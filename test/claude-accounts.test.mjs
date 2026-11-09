import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { claudeClient } from "../src/claude-client.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const version = "2.1.303";
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function until(read, check = Boolean) {
  const deadline = Date.now() + 10_000;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await delay(40);
  } while (Date.now() < deadline);
  throw new Error(`Fixture did not reach the expected state: ${JSON.stringify(value).slice(0, 400)}`);
}

test("mixed fleet uses isolated Claude sign-in, PTY quota, scheduler, and persistent text sessions", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "cwr-"));
  const data = path.join(temp, "data");
  const homes = path.join(temp, "claude");
  const socket = path.join(temp, "worker.sock");
  const bin = path.join(temp, "bin");
  const store = path.join(data, "store.json");
  const messages = path.join(temp, "messages");
  const preload = path.join(temp, "preload.mjs");
  const codexHome = path.join(temp, "home-a");
  const binary = path.join(bin, "claude");
  await Promise.all([data, homes, bin, codexHome].map((dir) => mkdir(dir)));
  await Promise.all(["claude", "codex"].map((name) => writeFile(path.join(bin, name),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(repo, "test", "browser", `fake-${name}.cjs`))} "$@"\n`, { mode: 0o700 })));
  const now = Date.now();
  const clockTime = new Date(now).toISOString().slice(11, 16);
  await writeFile(store, JSON.stringify({
    accounts: [{ id: "default", label: "Legacy", codeHome: codexHome, enabled: false }],
    selectedAccountId: "default",
    settings: { timezone: "UTC", schedulerEnabled: false, telegramAlertsEnabled: true, telegramQuotaWarningPercents: [80] }
  }));
  await writeFile(messages, "");
  await writeFile(preload, `
import { appendFileSync } from "node:fs";
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [${now}])); }
  static now() { return ${now}; }
};
const every = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => every(fn, ms === 10_000 ? 100 : ms, ...args);
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith("https://api.telegram.org/botfixture-token/")) throw new Error("Unexpected fetch");
  appendFileSync(${JSON.stringify(messages)}, JSON.stringify(JSON.parse(options.body).text) + "\\n");
  return Response.json({ ok: true });
};
`);
  const reserve = createServer();
  await new Promise((resolve, reject) => reserve.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = reserve.address();
  await new Promise((resolve) => reserve.close(resolve));
  const client = claudeClient(socket, version);
  let worker;
  let app;
  async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 2000);
    await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(deadline);
  }
  t.after(async () => {
    await stop(app);
    await stop(worker);
    await rm(temp, { recursive: true, force: true });
  });
  const launch = (args, env) => {
    const child = spawn(process.execPath, args, { cwd: repo, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => t.diagnostic(chunk.toString().slice(0, 500)));
    return child;
  };
  const request = async (route, method = "GET", body) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };
  const startApp = async (verifiedVersion) => {
    app = launch(["--import", preload, "src/server.mjs"], {
      DATA_DIR: data, CODEX_HOME: codexHome, CODEX_ACCOUNTS_DIR: path.join(temp, "codex-accounts"), WORKSPACE_DIR: temp,
      PATH: `${bin}:${process.env.PATH}`, PORT: String(port), ADMIN_EMAILS: "",
      TELEGRAM_BOT_TOKEN: "fixture-token", TELEGRAM_CHAT_ID: "fixture-chat",
      CLAUDE_WORKER_SOCKET: socket, CLAUDE_QUOTA_VERIFIED_VERSION: verifiedVersion
    });
    await until(() => request("/api/health").catch(() => null));
  };
  const startWorker = async (verifiedVersion) => {
    worker = launch(["src/claude-worker.mjs"], {
      CLAUDE_ACCOUNTS_DIR: homes, CLAUDE_BINARY: binary, CLAUDE_WORKER_SOCKET: socket,
      CLAUDE_QUOTA_VERIFIED_VERSION: verifiedVersion,
      ANTHROPIC_API_KEY: "fixture-not-inherited", TELEGRAM_BOT_TOKEN: "fixture-not-inherited", CODEX_HOME: codexHome
    });
    if (verifiedVersion === version) await until(() => client.available());
  };
  const account = async (id) => (await request("/api/accounts")).body.accounts.find((item) => item.id === id);
  const refresh = () => request("/api/refresh", "POST");
  const session = async (id) => (await account(id))?.thread.sessionId;
  const logs = async (id) => (await readFile(path.join(homes, id, "fixture-log"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const patch = (id, body) => request(`/api/accounts/${id}`, "PATCH", body);
  const quota = (id, payload) => writeFile(path.join(homes, id, "fixture-quota"), JSON.stringify(payload));
  const send = (id, prompt) => request("/api/run-now", "POST", { accountId: id, prompt });
  const auth = (id) => request(`/api/auth/status?accountId=${id}`);
  const runs = async () => (await request("/api/activity")).body.runs;

  await startApp("");
  assert.equal((await account("default")).provider, "codex");
  assert.equal((await request("/api/accounts", "POST", { provider: "claude" })).status, 503);
  assert.equal((await request("/api/accounts", "POST", { provider: "invalid" })).status, 400);
  await stop(app);
  await startWorker(version);
  assert.equal(await claudeClient(socket, "2.1.304").available(), false);
  await assert.rejects(claudeClient(socket, "2.1.304").call("prepare", "acct_000000000099"), { code: "disabled" });
  await startApp(version);
  assert.equal((await request("/api/status")).body.claudeAvailable, true);
  const first = (await request("/api/accounts", "POST", { provider: "claude", label: "Claude A", enabled: true })).body.account;
  const second = (await request("/api/accounts", "POST", { provider: "claude", label: "Claude B" })).body.account;
  assert.equal(first.enabled, false);
  assert.equal((await patch(first.id, { provider: "codex" })).status, 400);
  assert.equal((await patch(first.id, { settings: { model: "invalid" } })).status, 422);
  assert.equal((await request(`/api/models?accountId=${first.id}`)).status, 422);
  assert.equal((await request("/api/thread/goal", "POST", { accountId: first.id, objective: "test" })).status, 422);
  assert.equal((await request("/api/auth/device/start", "POST", { accountId: first.id })).status, 422);

  const browserAccount = (await request("/api/accounts", "POST", { provider: "claude", label: "Browser login" })).body.account;
  const loginStart = (id) => request("/api/auth/claude/start", "POST", { accountId: id });
  const loginCurrent = (id) => request(`/api/auth/claude/current?accountId=${id}`);
  const loginCode = (id, sessionId, code) => request("/api/auth/claude/code", "POST", { accountId: id, sessionId, code });
  for (const headers of [
    { "Content-Type": "application/json", Origin: "https://evil.example" },
    { "Content-Type": "text/plain" },
    { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }
  ]) {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/claude/start`, {
      method: "POST", headers, body: JSON.stringify({ accountId: first.id })
    })).status, 403);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/claude/code`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: '{"code":"PRIVATE_MALFORMED_CODE'
  })).status, 400);
  assert.equal((await loginStart("default")).status, 422);
  const login = (await loginStart(browserAccount.id)).body;
  assert.equal(login.status, "running");
  assert.equal((await loginStart(browserAccount.id)).body.id, login.id);
  const link = (await until(() => loginCurrent(browserAccount.id), (res) => res.body.phase === "authorize")).body;
  assert.equal(new URL(link.url).origin, "https://claude.com");
  assert.equal(JSON.stringify(link).includes("PRIVATE_LOGIN_DIAGNOSTIC"), false);
  assert.equal((await loginCurrent(second.id)).body.status, "none");
  assert.equal((await loginCode(second.id, login.id, "fixture-code")).status, 422);
  assert.equal((await loginCode(browserAccount.id, "wrong-session", "fixture-code")).status, 422);
  assert.equal((await loginCode(browserAccount.id, login.id, "fixture-code\n/usage")).status, 422);
  assert.equal((await loginCode(browserAccount.id, login.id, "fixture-code#wrong-state")).status, 422);
  await assert.rejects(client.call("run", browserAccount.id, { prompt: "Not while signing in" }), { code: "busy" });
  const code = `fixture-code#${"s".repeat(43)}`;
  assert.equal((await loginCode(browserAccount.id, login.id, code)).status, 200);
  const completed = await until(() => loginCurrent(browserAccount.id), (res) => res.body.status === "completed");
  assert.equal(completed.body.url, "");
  assert.equal(JSON.stringify(completed.body).includes("SECRET_TOKEN"), false);
  assert.equal((await auth(browserAccount.id)).body.loggedIn, true);
  const cancelled = (await loginStart(second.id)).body;
  assert.equal((await request("/api/auth/claude/cancel", "POST", { accountId: second.id, sessionId: cancelled.id })).body.status, "cancelled");
  assert.equal((await loginCode(second.id, cancelled.id, code)).status, 422);
  assert.equal((await auth(second.id)).body.loggedIn, false);
  const persisted = await readFile(store, "utf8");
  for (const secret of [code, "code_challenge", "PRIVATE_LOGIN_DIAGNOSTIC", "SECRET_TOKEN", "PRIVATE_MALFORMED_CODE"]) assert.equal(persisted.includes(secret), false);
  // The rest of this test uses manually prepared signed-in fixture accounts.
  assert.equal((await request(`/api/accounts/${browserAccount.id}`, "DELETE")).status, 200);
  await writeFile(path.join(homes, first.id, "fixture-setup"), "");
  await writeFile(path.join(homes, second.id, "fixture-setup"), "");

  const interruptedLogin = (await loginStart(second.id)).body;
  assert.equal(interruptedLogin.status, "running");
  await stop(worker);
  await startWorker(version);
  assert.equal((await loginCurrent(second.id)).body.status, "none");
  const removedLogin = (await request("/api/accounts", "POST", { provider: "claude", label: "Removed while signing in" })).body.account;
  await loginStart(removedLogin.id);
  assert.equal((await request(`/api/accounts/${removedLogin.id}`, "DELETE")).status, 200);
  await assert.rejects(readFile(path.join(homes, removedLogin.id, "fixture-identity")), { code: "ENOENT" });

  assert.equal((await auth(first.id)).body.loggedIn, false);
  await writeFile(path.join(homes, first.id, "fixture-identity"), "first@example.invalid");
  await writeFile(path.join(homes, second.id, "fixture-identity"), "second@example.invalid");
  await quota(first.id, { primary: 20, weekly: 32 });
  await quota(second.id, { primary: 30, weekly: 42 });
  await refresh();
  const live = await account(first.id);
  assert.equal(live.quotaStatus.live, true);
  assert.equal(live.dashboard.rateLimits.primary.usedPercent, 20);
  assert.equal(live.dashboard.rateLimits.secondary.usedPercent, 32);
  assert.equal(live.dashboard.rateLimitResetCredits, null);
  assert.equal((await account(second.id)).dashboard.rateLimits.primary.usedPercent, 30);
  assert.deepEqual((await logs(first.id)).map(({ action }) => action), ["usage"]);
  assert.equal(await session(first.id), null);
  assert.equal(JSON.stringify(live).includes("first@example.invalid"), false);

  const authUnavailable = path.join(homes, first.id, "fixture-auth-unavailable");
  await writeFile(authUnavailable, "");
  const uncertainAuth = (await auth(first.id)).body;
  assert.equal(uncertainAuth.loggedIn, true, "an unavailable check must preserve the confirmed sign-in");
  assert.equal(uncertainAuth.probeUnavailable, true);
  assert.equal((await account(first.id)).quotaStatus.live, true, "a standalone auth check does not invalidate quota");
  const unavailableRefresh = (await refresh()).body.accounts.find(({ accountId }) => accountId === first.id);
  assert.equal(unavailableRefresh.rateLimits, "failed");
  assert.equal((await account(first.id)).quotaStatus.live, false, "a failed quota refresh marks the reading stale");
  assert.equal((await account(first.id)).quotaStatus.observedAt, live.quotaStatus.observedAt);
  await rm(authUnavailable);

  await quota(first.id, { primary: 85, weekly: 35 });
  await refresh();
  await until(() => readFile(messages, "utf8"), (text) => text.includes("Claude A"));
  await refresh();
  assert.equal((await readFile(messages, "utf8")).split("\n").filter((message) => message.includes("Claude A")).length, 1);
  const history = (await request(`/api/usage-history?accountId=${first.id}`)).body.samples;
  assert.deepEqual(history.map((sample) => [sample.fiveHourUsed, sample.weeklyUsed]), [[20, 32], [85, 35]]);
  await quota(first.id, { primary: 1, weekly: 2, state: "cached" });
  await refresh();
  const stale = await account(first.id);
  assert.equal(stale.quotaStatus.live, false);
  assert.match(stale.quotaStatus.detail, /cached/);
  assert.equal(stale.dashboard.rateLimits.primary.usedPercent, 85);
  const readCount = (await logs(first.id)).length;
  const quotaReadCount = (await logs(first.id)).filter(({ action }) => action === "usage").length;
  await refresh();
  assert.equal((await logs(first.id)).length, readCount);
  assert.deepEqual((await request(`/api/usage-history?accountId=${first.id}`)).body.samples, history);

  const start = (await send(first.id, "/usage")).body;
  assert.equal(start.status, "started");
  assert.equal((await send(first.id, "Overlapping")).body.status, "skipped_active_turn");
  await until(() => session(first.id));
  assert.equal((await logs(first.id)).filter(({ action }) => action === "send")[0].text, "User message:\n/usage");
  assert.equal((await send(second.id, "Hi")).body.status, "started");
  const secondSession = await until(() => session(second.id));
  assert.notEqual(secondSession, start.threadId);
  await stop(app);
  await stop(worker);
  await startWorker(version);
  await startApp(version);
  await refresh();
  assert.equal((await logs(first.id)).filter(({ action }) => action === "usage").length, quotaReadCount);

  assert.equal((await patch(first.id, { enabled: true, settings: { scheduleTimes: [clockTime] } })).status, 200);
  await request("/api/scheduler/resume", "POST");
  const scheduled = await until(async () => (await runs()).find((run) => run.reason === "scheduled" && run.accountId === first.id && run.status === "completed"));
  assert.equal(scheduled.threadId, start.threadId);
  const firstSends = (await logs(first.id)).filter(({ action }) => action === "send");
  assert.equal(firstSends.length, 2);
  assert.equal(firstSends[1].resume, true);
  assert.match(firstSends[1].text, /Scheduled Claude window ping/);
  assert.equal(await session(second.id), secondSession);
  await stop(app);
  await startApp(version);
  await delay(300);
  assert.equal((await logs(first.id)).filter(({ action }) => action === "send").length, 2);
  await request("/api/scheduler/pause", "POST");

  assert.equal((await request("/api/auth/logout", "POST", { accountId: first.id })).status, 200);
  assert.equal((await auth(first.id)).body.loggedIn, false);
  await writeFile(path.join(homes, first.id, "fixture-identity"), "different@example.invalid");
  assert.match((await auth(first.id)).body.detail, /different Claude account/);
  assert.equal((await auth(second.id)).body.loggedIn, true);
  assert.equal((await request(`/api/accounts/${first.id}`, "DELETE")).status, 200);
  await assert.rejects(readFile(path.join(homes, first.id, "fixture-log")), { code: "ENOENT" });
  assert.equal(await session(second.id), secondSession);

  const third = (await request("/api/accounts", "POST", { provider: "claude", label: "Interrupted" })).body.account;
  await writeFile(path.join(homes, third.id, "fixture-identity"), "third@example.invalid");
  await writeFile(path.join(homes, third.id, "fixture-setup"), "");
  const thirdRun = (await send(third.id, "Test removal during a send")).body;
  assert.equal(thirdRun.status, "started");
  await until(() => logs(third.id).catch(() => []), (entries) => entries.some(({ action }) => action === "send"));
  assert.equal((await request(`/api/accounts/${third.id}`, "DELETE")).status, 200);
  await assert.rejects(readFile(path.join(homes, third.id, "fixture-log")), { code: "ENOENT" });
  assert.notEqual((await runs()).find(({ id }) => id === thirdRun.id).status, "completed");

  await stop(worker);
  assert.equal((await request("/api/status")).body.claudeAvailable, false);
  const outage = await refresh();
  assert.equal(outage.body.accounts.find(({ accountId }) => accountId === "default").rateLimits, "updated");
  assert.equal((await send("default", "Codex still works")).status, 200);
  assert.equal((await request(`/api/accounts/${second.id}`, "DELETE")).status, 503);
  assert.equal((await account(second.id)).provider, "claude");
});
