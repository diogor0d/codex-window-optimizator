import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { CLAUDE_ACCOUNT_ID, CLAUDE_ERRORS, CLAUDE_REPLY_LIMIT, CLAUDE_RUN_TIMEOUT_MS, CLAUDE_SESSION_ID, ClaudeError } from "./claude-client.mjs";
import { readClaudeUsage } from "./claude-usage.mjs";
import { beginClaudeLogin, finishClaudeSetup } from "./claude-login.mjs";

const ROOT = process.env.CLAUDE_ACCOUNTS_DIR || "/claude/accounts";
const SOCKET = process.env.CLAUDE_WORKER_SOCKET || "/run/claude-worker/worker.sock";
const BIN = process.env.CLAUDE_BINARY || "claude";
const SAFE_ARGS = ["--safe-mode", "--tools", "", "--strict-mcp-config", "--no-chrome"];
const active = new Map();
const logins = new Map();
process.umask(0o077);

function childEnv(home) {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "xterm-256color",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1"
  };
}

async function accountContext(id, create = false) {
  if (!CLAUDE_ACCOUNT_ID.test(id || "")) throw new ClaudeError("failed");
  const home = path.join(ROOT, id);
  const cwd = path.join(home, "work");
  if (create) await mkdir(cwd, { recursive: true, mode: 0o700 });
  else {
    const info = await lstat(cwd).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (!info?.isDirectory()) throw new ClaudeError("signed-out");
  }
  return { home, cwd, env: childEnv(home) };
}

function runCli(args, context, { input = "", timeoutMs = 8000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ClaudeError("interrupted"));
    const child = spawn(BIN, args, { cwd: context.cwd, env: context.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let error;
    let killTimer;
    const kill = (name) => {
      try { if (child.pid) process.kill(-child.pid, name); } catch {}
    };
    function stop(reason) {
      if (error) return;
      error = new ClaudeError(reason);
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 500);
    }
    const timeout = setTimeout(() => stop("timeout"), timeoutMs);
    const abort = () => stop("interrupted");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (error) return;
      stdout += chunk;
      if (stdout.length > 512_000) stop("failed");
    });
    child.stderr.on("data", (chunk) => {
      if (error) return;
      stderr += chunk;
      if (stderr.length > 64_000) stop("failed");
    });
    child.on("error", () => { error ||= new ClaudeError("unavailable"); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function authStatus(context, signal) {
  const result = await runCli(["auth", "status", "--json"], context, { signal });
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new ClaudeError("unavailable"); }
  if (result.code === 1 && data.loggedIn === false) return { status: "signed-out" };
  if (result.code !== 0 || data.loggedIn !== true) throw new ClaudeError("unavailable");
  if (data.authMethod !== "claude.ai" || data.apiProvider !== "firstParty") return { status: "wrong-auth" };
  // Bind slots to the first identity the CLI reports. Keep the digest in the worker.
  if (typeof data.email !== "string" || !data.email.trim()) throw new ClaudeError("unavailable");
  const identity = createHash("sha256").update(JSON.stringify([data.email.trim().toLowerCase(), data.orgId || null])).digest("hex");
  const binding = path.join(context.home, "identity");
  try {
    await writeFile(binding, identity, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return { status: (await readFile(binding, "utf8")) === identity ? "ready" : "account-changed" };
}

async function requireSubscription(context, signal) {
  const { status } = await authStatus(context, signal);
  if (status !== "ready") throw new ClaudeError(status);
}

async function usage(context, signal) {
  await requireSubscription(context, signal);
  return readClaudeUsage({
    signal,
    spawnTerminal: (cols, rows) => pty.spawn(BIN, SAFE_ARGS, {
      cwd: context.cwd, env: context.env, name: "xterm-256color", cols, rows
    })
  });
}

async function send(context, data, signal) {
  if (typeof data.prompt !== "string" || !data.prompt.trim() || data.prompt.length > 16_000
    || !CLAUDE_SESSION_ID.test(data.sessionId || "") || typeof data.resume !== "boolean") throw new ClaudeError("failed");
  await requireSubscription(context, signal);
  const sessionArgs = data.resume ? ["--resume", data.sessionId] : ["--session-id", data.sessionId];
  const args = [...SAFE_ARGS, "--disable-slash-commands", "--print", "--output-format", "json", ...sessionArgs];
  const result = await runCli(args, context, {
    // Never let caller text become a CLI option or local slash command.
    input: `User message:\n${data.prompt}`, timeoutMs: CLAUDE_RUN_TIMEOUT_MS, signal
  });
  let message;
  try { message = JSON.parse(result.stdout); } catch {}
  if (result.code === 0 && message?.type === "result" && message.subtype === "success"
    && message.is_error !== true && message.session_id === data.sessionId && typeof message.result === "string") {
    return { sessionId: message.session_id, reply: message.result.slice(0, CLAUDE_REPLY_LIMIT) };
  }
  const details = JSON.stringify([message?.error, message?.errors, message?.is_error ? message.result : null, result.stderr]);
  if (/login expired|not logged in|authentication_failed|invalid oauth|\b401\b/i.test(details)) throw new ClaudeError("auth-expired");
  if (/\brate_limit\b|usage limit|usage credits|billing_error|hit your (?:session|weekly) limit/i.test(details)) throw new ClaudeError("usage-limit");
  if (data.resume && /no conversation found|session not found|no session found/i.test(details)) throw new ClaudeError("session-missing");
  throw new ClaudeError("failed");
}

function singleOperation(id, action, execute) {
  if (active.has(id)) throw new ClaudeError("busy");
  const controller = new AbortController();
  const done = Promise.resolve().then(() => execute(controller.signal)).finally(() => active.delete(id));
  active.set(id, { action, controller, done });
  return done;
}

async function remove(id) {
  const previous = active.get(id);
  if (previous?.removing) throw new ClaudeError("busy");
  previous?.controller.abort();
  if (previous) {
    previous.removing = true;
    await previous.done.catch(() => {});
  }
  return singleOperation(id, "remove", async () => {
    logins.delete(id);
    await rm(path.join(ROOT, id), { recursive: true, force: true });
    return { removed: true };
  });
}

async function invoke(action, id, data) {
  if (action === "remove") return remove(id);
  if (action === "login-current") return logins.get(id)?.view() || { accountId: id, provider: "claude", status: "none" };
  if (["login-code", "login-cancel"].includes(action)) {
    const login = logins.get(id);
    if (!login || login.view().id !== data.sessionId) throw new ClaudeError("login-session");
    if (action === "login-code") login.submit(data.code);
    else {
      login.cancel();
      await active.get(id)?.done;
    }
    return login.view();
  }
  if (action === "login-start" && logins.get(id)?.view().status === "running") return logins.get(id).view();
  const previous = active.get(id);
  if (previous && !previous.removing && ["run", "logout", "login-start"].includes(action) && ["status", "usage"].includes(previous.action)) {
    // A foreground operation can interrupt a passive probe, but never another send.
    previous.controller.abort();
    await previous.done.catch(() => {});
  }
  if (action === "login-start") {
    if (active.has(id)) throw new ClaudeError("busy");
    // Hold the account lock for the whole sign-in while returning progress immediately.
    let login;
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const task = singleOperation(id, "login", async (signal) => {
      try {
        const context = await accountContext(id, true);
        login = beginClaudeLogin({
          accountId: id, signal,
          spawnLogin: () => spawn(BIN, ["auth", "login", "--claudeai"], {
            cwd: context.cwd, env: context.env, stdio: ["pipe", "pipe", "pipe"], detached: true
          }),
          verify: (signal) => requireSubscription(context, signal),
          finishSetup: (signal) => finishClaudeSetup({ signal, spawnTerminal: (cols, rows) => pty.spawn(BIN, SAFE_ARGS, {
            cwd: context.cwd, env: context.env, name: "xterm-256color", cols, rows
          }) })
        });
        logins.set(id, login);
        ready();
        await login.done;
      } catch (error) {
        ready(error);
      }
    });
    void task.catch(() => {});
    const error = await started;
    if (error) throw error;
    return login.view();
  }
  return singleOperation(id, action, async (signal) => {
    const context = await accountContext(id, action === "prepare");
    if (action === "prepare") return { ok: true };
    if (action === "status") return authStatus(context, signal);
    if (action === "run") return send(context, data, signal);
    if (action === "logout") {
      const result = await runCli(["auth", "logout"], context, { signal });
      if (result.code !== 0) throw new ClaudeError("failed");
      await rm(path.join(context.home, "quota-backoff"), { force: true });
      logins.delete(id);
      return { code: 0 };
    }
    const backoffFile = path.join(context.home, "quota-backoff");
    const savedBackoff = await readFile(backoffFile, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    const retryAt = Number(savedBackoff);
    if (retryAt > Date.now()) throw new ClaudeError("quota-limited", retryAt);
    try {
      return { rateLimits: await usage(context, signal) };
    } catch (error) {
      if (["quota-limited", "quota-stale"].includes(error.code)) {
        const retry = error.retryAt || Date.now() + 10 * 60_000;
        await writeFile(backoffFile, String(retry), { mode: 0o600 });
        throw new ClaudeError(error.code, retry);
      }
      throw error;
    }
  });
}

async function serve() {
  const versionResult = await runCli(["--version"], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: childEnv("/tmp") });
  const version = versionResult.code === 0 ? /^([\d.]+)\s+\(Claude Code\)/.exec(versionResult.stdout.trim())?.[1] : null;
  const enabled = Boolean(version && version === process.env.CLAUDE_QUOTA_VERIFIED_VERSION);
  const actions = new Set(["prepare", "status", "usage", "run", "logout", "remove", "login-start", "login-current", "login-code", "login-cancel"]);
  const server = createServer(async (req, res) => {
    const reply = (status, result) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(result));
    };
    if (req.method !== "POST") return reply(405, { error: "failed" });
    if (req.url === "/health") return reply(200, { enabled, version });
    const [, action, id, extra] = req.url.split("/");
    if (extra !== undefined || !actions.has(action) || !CLAUDE_ACCOUNT_ID.test(id || "")) return reply(404, { error: "failed" });
    if (!enabled || req.headers["x-claude-verified-version"] !== version) return reply(503, { error: "disabled" });
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 100_000) return reply(413, { error: "failed" });
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      reply(200, await invoke(action, id, data));
    } catch (error) {
      const code = error instanceof ClaudeError ? error.code : "failed";
      reply(code === "busy" ? 409 : 422, { error: code, retryAt: error.retryAt ?? null });
    }
  });
  // Only replace a stale socket. The parent directory is a dedicated shared volume.
  const old = await lstat(SOCKET).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (old) {
    if (!old.isSocket()) throw new ClaudeError("failed");
    await rm(SOCKET);
  }
  await new Promise((resolve, reject) => server.listen(SOCKET, resolve).once("error", reject));
  await chmod(SOCKET, 0o600);
  const stop = async () => {
    server.close();
    for (const task of active.values()) task.controller.abort();
    await Promise.allSettled([...active.values()].map((task) => task.done));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

async function main() {
  const [mode, id] = process.argv.slice(2);
  if (!mode) return serve();
  if (!["login", "inspect", "pilot", "status"].includes(mode)) throw new ClaudeError("failed");
  const context = await accountContext(id, mode === "login");
  if (mode === "status") {
    console.log(JSON.stringify(await authStatus(context)));
    return;
  }
  if (mode === "pilot") {
    console.log(JSON.stringify(await usage(context), null, 2));
    return;
  }
  if (mode === "login") {
    await runInteractive(["auth", "login", "--claudeai"], context);
    console.log("Complete Claude Code setup for this empty account directory, open /usage, then exit.");
  }
  await runInteractive(SAFE_ARGS, context);
}

function runInteractive(args, context) {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, { cwd: context.cwd, env: context.env, stdio: "inherit" });
    child.on("error", () => reject(new ClaudeError("unavailable")));
    child.on("close", (code) => code === 0 ? resolve() : reject(new ClaudeError("failed")));
  });
}

main().catch((error) => {
  console.error(error instanceof ClaudeError ? CLAUDE_ERRORS[error.code] : CLAUDE_ERRORS.failed);
  process.exitCode = 1;
});
