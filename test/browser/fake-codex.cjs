#!/usr/bin/env node
// Isolated app-server stand-in for the local frontend E2E harness.
const fs = require("node:fs");
const path = require("node:path");

function marker(name) {
  return path.join(process.env.CODEX_HOME || process.cwd(), `.fake-${name}`);
}

function loggedIn() {
  return fs.existsSync(marker("signed-in")) || (!fs.existsSync(marker("signed-out"))
    && ["home-a", "home-b"].includes(path.basename(process.env.CODEX_HOME || "")));
}

if (process.argv[2] === "login" && process.argv[3] === "status") {
  process.stdout.write(loggedIn() ? "Logged in using ChatGPT\n" : "Not logged in\n");
  process.exit(loggedIn() ? 0 : 1);
}
if (process.argv[2] === "login" && process.argv[3] === "--device-auth") {
  process.stdout.write("Open https://auth.openai.com/codex/device and enter code ");
  setTimeout(() => process.stdout.write("TEST0-"), 120);
  setTimeout(() => process.stdout.write("CODE9\nThis code expires in 15 minutes.\n"), 250);
  const fail = fs.existsSync(marker("fail-login"));
  setTimeout(() => {
    if (fail) {
      fs.rmSync(marker("fail-login"), { force: true });
      process.stderr.write("Simulated local device-login failure.\n");
      process.exit(1);
    }
    fs.rmSync(marker("signed-out"), { force: true });
    fs.writeFileSync(marker("signed-in"), "local fake sign-in\n");
    process.exit(0);
  }, 4000);
  process.stdin.resume();
  return;
}
if (process.argv[2] === "logout") {
  fs.rmSync(marker("signed-in"), { force: true });
  fs.writeFileSync(marker("signed-out"), "local fake sign-out\n");
  process.exit(0);
}
if (process.argv[2] !== "app-server") process.exit(0);

let buffer = "";
let turnNumber = 0;
const creditExpiryBase = Math.floor(Date.now() / 1000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    if (process.env.FAKE_CODEX_RPC_LOG) {
      fs.appendFileSync(process.env.FAKE_CODEX_RPC_LOG, `${JSON.stringify(request)}\n`);
    }
    let result = {};
    switch (request.method) {
      case "initialize":
        result = { userAgent: "codex-window-local-e2e" };
        break;
      case "account/read":
        result = loggedIn()
          ? { account: { type: "chatgpt", email: "e2e@example.invalid", planType: "plus" }, requiresOpenaiAuth: false }
          : { account: null, requiresOpenaiAuth: true };
        break;
      case "account/rateLimits/read":
        result = { rateLimits: {
          primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { usedPercent: 38, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
          planType: "plus"
        }, rateLimitResetCredits: {
          // Synthetic inventory makes the local preview and browser tests exercise credit expiry UI.
          availableCount: path.basename(process.env.CODEX_HOME || "") === "home-a" ? 2 : 1,
          credits: path.basename(process.env.CODEX_HOME || "") === "home-a"
            ? [{ expiresAt: creditExpiryBase + 36 * 3600 }, { expiresAt: creditExpiryBase + 7 * 86400 }]
            : [{ expiresAt: creditExpiryBase + 7 * 86400 }]
        } };
        break;
      case "model/list":
        result = { data: [
          { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "Sol", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] },
          { id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "Luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] }
        ], nextCursor: null };
        break;
      case "thread/resume":
        result = { thread: { id: request.params.threadId, name: "E2E thread" } };
        break;
      case "thread/start":
        result = { thread: { id: "e2e-thread", sessionId: "e2e-session", name: "E2E thread" } };
        break;
      case "turn/start": {
        const id = `e2e-turn-${++turnNumber}`;
        const prompt = JSON.stringify(request.params.input || []);
        if (prompt.includes("E2E_START_ERROR")) {
          process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: "Simulated turn start failure" } })}\n`);
          continue;
        }
        const status = prompt.includes("E2E_FAIL") ? "failed" : prompt.includes("E2E_INTERRUPT") ? "interrupted" : "completed";
        const error = status === "failed" ? { message: "Selected model is at capacity. Please try a different model." } : null;
        // Exercise the real server SSE bridge while remaining entirely local.
        process.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: request.params.threadId, turn: { id } } })}\n`);
        setTimeout(() => {
          process.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: request.params.threadId, turn: { id, status, error, durationMs: 350 } } })}\n`);
        }, 350);
        result = { turn: { id, status: "inProgress" } };
        break;
      }
      default:
        result = {};
    }
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  }
});
