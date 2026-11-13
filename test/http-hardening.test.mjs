import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

// Sends a request line that fetch() would normalize away.
function rawRequest(port, head) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.end(`${head}\r\nConnection: close\r\n\r\n`));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => { data += chunk; });
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1])));
    socket.on("error", reject);
  });
}

async function startServer(t, { env = {}, seedStore } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "http-hardening-"));
  const binDir = path.join(temp, "bin");
  const dataDir = path.join(temp, "data");
  await Promise.all([mkdir(binDir), mkdir(dataDir)]);
  // Signed-out Codex: the server never starts an app-server for it.
  await writeFile(path.join(binDir, "codex"), "#!/bin/sh\necho 'Not logged in'\nexit 1\n");
  await chmod(path.join(binDir, "codex"), 0o755);
  if (seedStore !== undefined) await writeFile(path.join(dataDir, "store.json"), seedStore);
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env, PATH: `${binDir}:${process.env.PATH}`, PORT: String(port), DATA_DIR: dataDir,
      CODEX_HOME: path.join(temp, "codex-home"), CODEX_ACCOUNTS_DIR: path.join(temp, "accounts"), WORKSPACE_DIR: temp,
      ADMIN_EMAILS: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", CLAUDE_WORKER_SOCKET: "", CLAUDE_QUOTA_VERIFIED_VERSION: "",
      ...env
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise(resolve => child.exitCode === null ? child.once("close", resolve) : resolve());
    await rm(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}: ${stderr.slice(-500)}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("server did not become ready");
    await delay(100);
  }
  return { base, port, child, dataDir };
}

test("malformed request targets are rejected without stopping the server", { timeout: 30000 }, async (t) => {
  const { base, port, child } = await startServer(t);
  assert.equal(await rawRequest(port, "GET // HTTP/1.1\r\nHost: localhost"), 400);
  assert.equal(await rawRequest(port, "GET http:// HTTP/1.1\r\nHost: localhost"), 400);
  await delay(200);
  assert.equal(child.exitCode, null, "server must survive malformed request targets");
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("request bodies and settings are validated as client errors", { timeout: 30000 }, async (t) => {
  const { base } = await startServer(t);
  const patch = body => fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body });
  assert.equal((await patch("{not json")).status, 400);
  assert.equal((await patch("null")).status, 400);
  assert.equal((await patch("[1]")).status, 400);
  assert.equal((await patch(JSON.stringify({ timezone: "Not/AZone" }))).status, 400);
  assert.equal((await patch(JSON.stringify({ scheduleTimes: ["25:00"] }))).status, 400);
  assert.equal((await patch(JSON.stringify({ promptTemplate: "x".repeat(1_100_000) }))).status, 413);
  assert.equal((await patch(JSON.stringify({ skipIfActive: false }))).status, 200);

  for (const limit of ["abc", "-5", "0"]) {
    const response = await fetch(`${base}/api/activity?limit=${limit}`);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).events.length <= 200);
  }
  assert.equal((await (await fetch(`${base}/api/activity?limit=1`)).json()).events.length, 1);
});

test("state-changing API requests must be same-origin", { timeout: 30000 }, async (t) => {
  const { base, port } = await startServer(t);
  const pause = headers => fetch(`${base}/api/scheduler/pause`, { method: "POST", headers });
  assert.equal((await pause({ origin: "https://evil.example" })).status, 403);
  assert.equal((await pause({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await pause({ "sec-fetch-site": "same-site", origin: "https://sibling.example" })).status, 403);
  assert.equal((await (await fetch(`${base}/api/settings`)).json()).schedulerEnabled, true);

  // A browser's own verdict wins over Host comparison, so a proxy that rewrites Host still works.
  assert.equal((await pause({ "sec-fetch-site": "same-origin", origin: "https://relay.example" })).status, 200);
  assert.equal((await fetch(`${base}/api/scheduler/resume`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/scheduler/resume`, { method: "POST" })).status, 200);
  // Reads stay available to cross-origin navigations; the browser withholds the response.
  assert.equal((await fetch(`${base}/api/settings`, { headers: { "sec-fetch-site": "cross-site" } })).status, 200);
});

test("static files are served with a restrictive policy and real 404s", { timeout: 30000 }, async (t) => {
  const { base } = await startServer(t);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'.*script-src 'self';.*frame-ancestors 'none'/);

  const script = await fetch(`${base}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /^text\/javascript/);

  // A missing asset must not be answered with the HTML shell.
  assert.equal((await fetch(`${base}/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/assets/missing.css`)).status, 404);
  // Extension-less paths stay client-side routes.
  const route = await fetch(`${base}/accounts`);
  assert.equal(route.status, 200);
  assert.match(route.headers.get("content-type"), /^text\/html/);

  const post = await fetch(`${base}/`, { method: "POST" });
  assert.equal(post.status, 405);
  const head = await fetch(`${base}/app.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${base}/api/status`)).headers.get("x-content-type-options"), "nosniff");
});

test("health stays reachable for container probes when the email allowlist is on", { timeout: 30000 }, async (t) => {
  const { base } = await startServer(t, { env: { ADMIN_EMAILS: "owner@example.invalid" } });
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/status`)).status, 403);
  assert.equal((await fetch(`${base}/api/status`, {
    headers: { "cf-access-authenticated-user-email": "owner@example.invalid" }
  })).status, 200);
});

test("an unreadable store is kept aside instead of being overwritten", { timeout: 30000 }, async (t) => {
  const corrupt = '{"accounts":[{"id":"acct_keepme"';
  const { dataDir } = await startServer(t, { seedStore: corrupt });
  const kept = (await readdir(dataDir)).filter(name => name.startsWith("store.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(await readFile(path.join(dataDir, kept[0]), "utf8"), corrupt);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, "store.json"), "utf8")).accounts.length, 1);
});
