import { randomUUID } from "node:crypto";
import xterm from "@xterm/headless";
import { ClaudeError } from "./claude-client.mjs";

export function claudeAuthorizationUrl(output) {
  const text = output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const match of text.matchAll(/https:\/\/[^\s<>"'\x00-\x1f]+(?=[\s<>"'\x00-\x1f])/g)) {
    try {
      const url = new URL(match[0]);
      if (!((url.origin === "https://claude.com" && url.pathname === "/cai/oauth/authorize")
        || (url.origin === "https://claude.ai" && url.pathname === "/oauth/authorize"))
        || url.username || url.password || url.hash) continue;
      const params = url.searchParams;
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1)
        || params.get("redirect_uri") !== "https://platform.claude.com/oauth/code/callback"
        || params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256"
        || !/^[\w-]{32,128}$/.test(params.get("state") || "")
        || !/^[\w-]{43,128}$/.test(params.get("code_challenge") || "")) continue;
      return url.href;
    } catch {}
  }
  return "";
}

// Only this view crosses the worker socket. CLI output and submitted codes never do.
export function beginClaudeLogin({ accountId, spawnLogin, verify, finishSetup, signal, timeoutMs = 10 * 60_000 }) {
  const session = {
    id: randomUUID(), accountId, provider: "claude", status: "running", phase: "preparing",
    startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    finishedAt: null
  };
  let url = "";
  let state = "";
  let child;
  let stopReason;
  const controller = new AbortController();
  function stop(reason) {
    stopReason ||= reason;
    controller.abort();
  }
  const abort = () => stop("cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => stop("expired"), timeoutMs);
  const done = (async () => {
    if (signal?.aborted) throw new ClaudeError("interrupted");
    await new Promise((resolve, reject) => {
      child = spawnLogin();
      let output = "";
      let bytes = 0;
      let killTimer;
      const terminate = () => {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }, 500);
      };
      controller.signal.addEventListener("abort", terminate, { once: true });
      const append = (chunk) => {
        bytes += chunk.length;
        if (bytes > 64_000) return stop("failed");
        if (url) return;
        output += chunk.toString("utf8");
        const found = claudeAuthorizationUrl(output);
        if (found) {
          url = found;
          state = new URL(url).searchParams.get("state");
          session.phase = "authorize";
          output = "";
        }
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.stdin.on("error", () => {});
      child.once("error", () => reject(new ClaudeError("unavailable")));
      child.once("close", (code) => {
        controller.signal.removeEventListener("abort", terminate);
        clearTimeout(killTimer);
        output = "";
        if (controller.signal.aborted || code !== 0) reject(new ClaudeError("failed"));
        else resolve();
      });
      if (controller.signal.aborted) terminate();
    });
    url = "";
    state = "";
    session.phase = "setup";
    await verify(controller.signal);
    await finishSetup(controller.signal);
    if (controller.signal.aborted) throw new ClaudeError("interrupted");
    session.status = "completed";
    session.phase = "ready";
  })().catch(() => {
    session.status = stopReason || "failed";
    session.phase = session.status;
  }).finally(() => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    url = "";
    state = "";
    session.finishedAt = new Date().toISOString();
  });
  return {
    done,
    view: () => ({ ...session, url: session.status === "running" && session.phase === "authorize" ? url : "" }),
    submit(code) {
      if (session.status !== "running" || session.phase !== "authorize" || !child?.stdin.writable) throw new ClaudeError("login-session");
      if (typeof code !== "string" || code.length > 2048
        || !/^[A-Za-z0-9._~+/=-]{8,}(?:#[A-Za-z0-9_-]+)?$/.test(code.trim())
        || (code.includes("#") && code.trim().split("#")[1] !== state)) throw new ClaudeError("login-code");
      session.phase = "verifying";
      url = "";
      child.stdin.write(`${code.trim()}\n`);
    },
    cancel: () => stop("cancelled")
  };
}

export function finishClaudeSetup({ spawnTerminal, signal, timeoutMs = 25_000 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ClaudeError("interrupted"));
    const screen = new xterm.Terminal({ cols: 120, rows: 60, scrollback: 0, allowProposedApi: true });
    let child;
    try { child = spawnTerminal(120, 60); } catch {
      screen.dispose();
      return reject(new ClaudeError("unavailable"));
    }
    let outcome;
    let quiet;
    let killTimer;
    let killDeadline;
    let settled = false;
    let bytes = 0;
    const answered = new Set();
    const timeout = setTimeout(() => stop(new ClaudeError("login-setup")), timeoutMs);
    const input = screen.onData((data) => { if (!outcome) child.write(data); });
    const output = child.onData((data) => {
      if (outcome) return;
      bytes += Buffer.byteLength(data);
      if (bytes > 1024 * 1024) return stop(new ClaudeError("login-setup"));
      clearTimeout(quiet);
      screen.write(data, () => {
        clearTimeout(quiet);
        quiet = setTimeout(inspect, 180);
      });
    });
    const exit = child.onExit(() => finish());
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(quiet);
      clearTimeout(killTimer);
      clearTimeout(killDeadline);
      signal?.removeEventListener("abort", abort);
      input.dispose(); output.dispose(); exit.dispose(); screen.dispose();
      if (outcome?.ok) resolve();
      else reject(outcome?.error || new ClaudeError("login-setup"));
    }
    const abort = () => stop(new ClaudeError("interrupted"));
    signal?.addEventListener("abort", abort, { once: true });
    function stop(error) {
      if (outcome) return;
      outcome = { error, ok: !error };
      clearTimeout(timeout);
      clearTimeout(quiet);
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 500);
      killDeadline = setTimeout(() => { outcome = { error: new ClaudeError("login-setup") }; finish(); }, 2000);
      try { child.kill(); } catch {}
    }
    function answer(key, value = "\r") {
      if (answered.has(key)) return;
      answered.add(key);
      child.write(value);
    }
    function inspect() {
      if (outcome) return;
      const buffer = screen.buffer.active;
      const frame = Array.from({ length: 60 }, (_, i) => buffer.getLine(buffer.baseY + i)?.translateToString(true) || "").join("\n");
      // Only acknowledge known setup screens in the account's empty, tool-free directory.
      if (/Choose the text style|Choose (?:a |the )?theme/i.test(frame) && /Dark mode/i.test(frame)) answer("theme");
      else if (/Security notes:/i.test(frame) && /Enter to (?:continue|confirm)/i.test(frame)) answer("security");
      else if (/Do you trust the files in this folder\?|Quick safety check: Is this a project you created or one you trust\?/i.test(frame)
        && /Yes, I trust this folder/i.test(frame)) {
        if (/❯\s*No, exit/.test(frame)) answer("trust", "\x1b[B\r");
        else if (/❯\s*(?:✔\s*)?Yes, I trust this folder/.test(frame)) answer("trust");
      }
      else if (/Claude Code/i.test(frame) && /^[^\S\r\n]*❯(?:[^\S\r\n]+Try ["“][^\n]+["”])?[^\S\r\n]*$/m.test(frame)
        && !/press enter|enter to confirm|select login|choose|do you trust|quick safety check/i.test(frame)) stop();
    }
  });
}
