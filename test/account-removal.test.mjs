import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function waitForFile(file, child, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 15000;
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

async function request(base, route, method = "GET") {
  const response = await fetch(`${base}${route}`, { method });
  return { status: response.status, data: await response.json() };
}

test("account removal waits for app-server shutdown and rejects overlapping access", { timeout: 30000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "account-removal-"));
  const binDir = path.join(temp, "bin");
  const dataDir = path.join(temp, "data");
  const accountsDir = path.join(temp, "accounts");
  const targetHome = path.join(accountsDir, "target-home");
  const otherHome = path.join(accountsDir, "other-home");
  const stoppingMarker = path.join(temp, "target-stopping");
  const closedMarker = path.join(temp, "target-closed");
  const fakeCodex = path.join(binDir, "codex");
  let child;

  try {
    await Promise.all([mkdir(binDir), mkdir(dataDir), mkdir(targetHome, { recursive: true }), mkdir(otherHome, { recursive: true })]);
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
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
    let result = {};
    if (message.method === "initialize") result = { serverInfo: { name: "fake-codex" } };
    if (message.method === "model/list") result = { data: [{ id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "Luna", isDefault: true }], nextCursor: null };
    if (message.method === "thread/resume") result = { thread: { id: message.params.threadId } };
    if (message.method === "account/read") result = { account: {} };
    if (message.method === "account/rateLimits/read") result = { rateLimits: {} };
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
  }
});
process.on("SIGTERM", () => {
  if (path.basename(process.env.CODEX_HOME || "") !== "target-home") {
    process.exit(0);
    return;
  }
  fs.writeFileSync(process.env.FAKE_STOPPING_MARKER, "stopping");
  setTimeout(() => {
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.CODEX_HOME, "late-shutdown-write"), "created after SIGTERM");
    fs.writeFileSync(process.env.FAKE_CLOSED_MARKER, "closed");
    process.exit(0);
  }, 300);
});
`);
    await chmod(fakeCodex, 0o755);

    const seed = {
      version: 1,
      settings: { schedulerEnabled: false, model: "", effort: "medium", workspaceDir: temp, skipIfActive: true },
      selectedAccountId: "target",
      accounts: [
        { id: "target", label: "Target", enabled: true, codeHome: targetHome, settings: {}, threadState: { threadId: "target-thread", sessionId: null, name: null }, dashboard: {}, usageHistory: [], usageObservedAt: {} },
        { id: "other", label: "Other", enabled: true, codeHome: otherHome, settings: {}, threadState: { threadId: "other-thread", sessionId: null, name: null }, dashboard: {}, usageHistory: [], usageObservedAt: {} }
      ],
      threadState: { threadId: "target-thread", sessionId: null, name: null },
      scheduledRuns: [], activityEvents: [], authEvents: []
    };
    await writeFile(path.join(dataDir, "store.json"), JSON.stringify(seed));

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        DATA_DIR: dataDir,
        CODEX_HOME: path.join(temp, "default-codex-home"),
        CODEX_ACCOUNTS_DIR: accountsDir,
        WORKSPACE_DIR: temp,
        PORT: String(port),
        FAKE_STOPPING_MARKER: stoppingMarker,
        FAKE_CLOSED_MARKER: closedMarker,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_CHAT_ID: ""
      },
      stdio: "ignore"
    });


    await waitForServer(`${base}/api/settings`, child);
    const catalog = await request(base, "/api/models?accountId=target");
    assert.equal(catalog.status, 200, JSON.stringify(catalog.data));
    assert.equal(catalog.data.data[0].model, "gpt-5.6-luna");

    const deletionPromise = request(base, "/api/accounts/target", "DELETE");
    await waitForFile(stoppingMarker, child);

    const overlappingDelete = await request(base, "/api/accounts/other", "DELETE");
    assert.equal(overlappingDelete.status, 409, JSON.stringify(overlappingDelete.data));
    const targetRead = await request(base, "/api/models?accountId=target");
    assert.equal(targetRead.status, 409, JSON.stringify(targetRead.data));

    const deletion = await deletionPromise;
    assert.equal(deletion.status, 200, JSON.stringify(deletion.data));
    assert.equal(await readFile(closedMarker, "utf8"), "closed");
    await assert.rejects(access(targetHome), { code: "ENOENT" });
    await access(otherHome);
    const persisted = JSON.parse(await readFile(path.join(dataDir, "store.json"), "utf8"));
    assert.deepEqual(persisted.accounts.map(account => account.id), ["other"]);

    const lastAccountDelete = await request(base, "/api/accounts/other", "DELETE");
    assert.equal(lastAccountDelete.status, 400, JSON.stringify(lastAccountDelete.data));
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(temp, { recursive: true, force: true });
  }
});
