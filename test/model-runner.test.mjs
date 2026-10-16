import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("server did not become ready");
}

async function request(base, route, method = "GET", body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

test("HTTP model choices persist and reach resumed threads and turns", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "model-runner-"));
  const binDir = path.join(temp, "bin");
  const dataDir = path.join(temp, "data");
  const codeHome = path.join(temp, "codex-home");
  const logPath = path.join(temp, "rpc.jsonl");
  await Promise.all([mkdir(binDir), mkdir(dataDir), mkdir(codeHome)]);
  const fakeCodex = path.join(binDir, "codex");
  await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "login" && process.argv[3] === "status") {
  process.stdout.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
if (process.argv[2] !== "app-server") process.exit(0);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  for (;;) {
    const end = input.indexOf("\\n");
    if (end < 0) break;
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    fs.appendFileSync(process.env.RPC_LOG, JSON.stringify(message) + "\\n");
    let result = {};
    if (message.method === "model/list") result = { data: [
      { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "Astra", isDefault: true },
      { id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "Luna" }
    ], nextCursor: null };
    if (message.method === "thread/resume") result = { thread: { id: message.params.threadId } };
    if (message.method === "turn/start") result = { turn: { id: "turn-1", status: "completed" } };
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
  }
});
`);
  await chmod(fakeCodex, 0o755);

  const seed = {
    version: 1,
    settings: { schedulerEnabled: false, model: "", effort: "", workspaceDir: temp, skipIfActive: false },
    selectedAccountId: "default",
    accounts: [{
      id: "default", label: "Default account", enabled: true, codeHome,
      settings: {}, threadState: { threadId: "old-thread", sessionId: null, name: null },
      dashboard: {}, usageHistory: [], usageObservedAt: {}
    }],
    threadState: { threadId: "old-thread", sessionId: null, name: null },
    scheduledRuns: [], activityEvents: [], authEvents: []
  };
  await writeFile(path.join(dataDir, "store.json"), JSON.stringify(seed));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      DATA_DIR: dataDir,
      CODEX_HOME: codeHome,
      WORKSPACE_DIR: temp,
      PORT: String(port),
      RPC_LOG: logPath
    },
    stdio: "ignore"
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(3000)]);
    await rm(temp, { recursive: true, force: true });
  });
  await waitForServer(`${base}/api/settings`, child);

  const catalog = await request(base, "/api/models");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.recommendedModel, "gpt-5.6-luna");

  const run = async () => {
    const result = await request(base, "/api/run-now", "POST", { prompt: "integration" });
    assert.equal(result.status, 200);
    assert.equal(result.data.status, "completed");
  };
  const rpcMessages = async () => (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const assertLastRunModel = async expected => {
    const messages = await rpcMessages();
    const resume = messages.filter(message => message.method === "thread/resume").at(-1);
    const turn = messages.filter(message => message.method === "turn/start").at(-1);
    assert.ok(resume && turn, "expected both resume and turn/start RPCs");
    assert.equal(resume.params.threadId, "old-thread");
    assert.equal(resume.params.model, expected);
    assert.equal(turn.params.threadId, "old-thread");
    assert.equal(turn.params.model, expected);
    assert.equal(turn.params.serviceTier, "default");
  };

  await run();
  await assertLastRunModel("gpt-5.6-luna");

  assert.equal((await request(base, "/api/settings", "PATCH", { model: "gpt-6-astra" })).status, 200);
  await run();
  await assertLastRunModel("gpt-6-astra");

  assert.equal((await request(base, "/api/accounts/default", "PATCH", { settings: { model: "gpt-5.6-luna" } })).status, 200);
  await run();
  await assertLastRunModel("gpt-5.6-luna");

  assert.equal((await request(base, "/api/accounts/default", "PATCH", { settings: { model: "gpt-5.5" } })).status, 200);
  const beforeRetired = await rpcMessages();
  const rejected = await request(base, "/api/run-now", "POST", { prompt: "should fail" });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.status, "failed");
  assert.match(rejected.data.error, /unavailable/i);
  const afterRetired = await rpcMessages();
  assert.equal(afterRetired.filter(message => message.method === "turn/start").length,
    beforeRetired.filter(message => message.method === "turn/start").length);
  assert.ok(afterRetired.some(message => message.method === "thread/resume" && message.params.threadId === "old-thread"));
  const persisted = JSON.parse(await readFile(path.join(dataDir, "store.json"), "utf8"));
  assert.equal(persisted.accounts[0].threadState.threadId, "old-thread");
});
