import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { beginClaudeLogin, claudeAuthorizationUrl, finishClaudeSetup } from "../src/claude-login.mjs";
import { claudeLoginPresentation } from "../public/app.js";

const state = "s".repeat(43);
const url = new URL("https://claude.com/cai/oauth/authorize");
url.search = new URLSearchParams({ code: "true", client_id: "fixture", response_type: "code",
  redirect_uri: "https://platform.claude.com/oauth/code/callback", code_challenge: "c".repeat(43), code_challenge_method: "S256", state });

test("accepts the pinned CLI's OSC link and waits for a complete URL", () => {
  assert.equal(claudeAuthorizationUrl(`visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\n`), url.href);
  assert.equal(claudeAuthorizationUrl(`visit: ${url}`), "");
  assert.equal(claudeAuthorizationUrl(`visit: ${url}\n`), url.href);
  for (const other of [
    url.href.replace("claude.com", "claude.com.evil.example"),
    url.href.replace("https://claude.com", "http://claude.com"),
    url.href.replace("/cai/oauth/authorize", "/cai/oauth/authorize-evil"),
    url.href.replace("platform.claude.com", "evil.example"),
    url.href + "&state=duplicate",
    url.href.replace("S256", "plain")
  ]) {
    assert.equal(claudeAuthorizationUrl(other + "\n"), "");
    if (!other.endsWith("state=duplicate") && !other.includes("plain")) {
      assert.equal(claudeLoginPresentation({ status: "running", phase: "authorize", url: other }).url, "");
    }
  }
  assert.equal(claudeLoginPresentation({ status: "completed", phase: "ready", url: url.href }).url, "");
});

function loginFixture(options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { setImmediate(() => child.emit("close", 1)); };
  let sent = "";
  child.stdin.on("data", (data) => { sent += data; });
  const login = beginClaudeLogin({ accountId: "acct_000000000001", spawnLogin: () => child,
    verify: async () => {}, finishSetup: async () => {}, ...options });
  return { child, login, sent: () => sent };
}

test("relays only one code, matches its state, and never returns CLI output or secrets", async () => {
  const { child, login, sent } = loginFixture();
  child.stdout.write(`PRIVATE_DIAGNOSTIC\nvisit: ${url}\nPaste code here if prompted > `);
  assert.equal(login.view().phase, "authorize");
  for (const code of ["code\n/usage", "code\x1b[D", "fixture-code#wrong", "x".repeat(2049)]) {
    assert.throws(() => login.submit(code), { code: "login-code" });
  }
  const code = `fixture-code#${state}`;
  login.submit(code);
  assert.equal(sent(), code + "\n");
  assert.equal(login.view().url, "");
  assert.throws(() => login.submit(code), { code: "login-session" });
  child.stdout.write("SECRET_TOKEN\nLogin successful\n");
  child.emit("close", 0);
  await login.done;
  assert.equal(login.view().status, "completed");
  for (const secret of [code, "PRIVATE_DIAGNOSTIC", "SECRET_TOKEN"]) assert.equal(JSON.stringify(login.view()).includes(secret), false);
});

test("cancellation, expiry, failed verification, and worker shutdown stop sign-in", async () => {
  for (const mode of ["cancelled", "expired", "failed", "shutdown"]) {
    const controller = new AbortController();
    const { child, login } = loginFixture({ signal: controller.signal, timeoutMs: mode === "expired" ? 20 : 1000,
      verify: async () => { if (mode === "failed") throw new Error("private provider error"); } });
    child.stdout.write(`visit: ${url}\n`);
    if (mode === "cancelled") login.cancel();
    if (mode === "shutdown") controller.abort();
    if (mode === "failed") child.emit("close", 0);
    await login.done;
    assert.equal(login.view().status, mode === "shutdown" ? "cancelled" : mode);
    assert.equal(login.view().url, "");
    assert.throws(() => login.submit("fixture-code"), { code: "login-session" });
    assert.equal(JSON.stringify(login.view()).includes("private provider error"), false);
  }
});

test("first-run setup acknowledges only known native prompts and never types a model prompt", async () => {
  const events = new EventEmitter();
  const writes = [];
  const frames = [
    "Claude Code\nChoose the text style that looks best with your terminal\n❯ Dark mode",
    "Claude Code\nSecurity notes:\nPress Enter to continue…",
    "Claude Code\nQuick safety check: Is this a project you created or one you trust?\n❯ No, exit\nYes, I trust this folder",
    "Claude Code\n\n❯"
  ];
  const child = {
    onData(fn) { events.on("data", fn); return { dispose: () => events.off("data", fn) }; },
    onExit(fn) { events.on("exit", fn); return { dispose: () => events.off("exit", fn) }; },
    write(value) { writes.push(value); setImmediate(() => paint()); },
    kill() { setImmediate(() => events.emit("exit")); }
  };
  const paint = () => events.emit("data", `\x1b[2J\x1b[H${frames.shift().replaceAll("\n", "\r\n")}`);
  const done = finishClaudeSetup({ spawnTerminal: () => child, timeoutMs: 3000 });
  paint();
  await done;
  assert.deepEqual(writes, ["\r", "\r", "\x1b[B\r"]);
  const unknown = finishClaudeSetup({ spawnTerminal: () => child, timeoutMs: 40 });
  events.emit("data", "\x1b[2J\x1b[HClaude Code\r\nType a command to continue");
  await assert.rejects(unknown, { code: "login-setup" });
  assert.deepEqual(writes, ["\r", "\r", "\x1b[B\r"]);
  await delay(1);
});
