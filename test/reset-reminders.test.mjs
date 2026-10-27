import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (predicate(result)) return result;
    await delay(30);
  }
  throw new Error("Timed out waiting for isolated reminder fixture");
}

async function fixture(t, legacyHours, options = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "reset-reminders-"));
  const dataDir = path.join(temp, "data");
  const bin = path.join(temp, "bin");
  const home = path.join(temp, "codex-home");
  const controlsPath = path.join(temp, "controls.json");
  const messagesPath = path.join(temp, "messages.jsonl");
  const preloadPath = path.join(temp, "telegram-stub.mjs");
  const storePath = path.join(dataDir, "store.json");
  await Promise.all([mkdir(dataDir), mkdir(bin), mkdir(home)]);
  const initialNow = Date.now();
  const expiry = Math.floor(initialNow / 1000) + 3 * 86400;
  let controls = { now: initialNow, status: 200, count: 1, expirations: [expiry], used: 20, weekly: 20,
    fiveHourReset: Math.floor(initialNow / 1000) + 4 * 3600, weeklyReset: expiry,
    reserveUsed: 10, ordinaryAllowed: true, authFailure: false };
  const setControls = async (patch) => {
    controls = { ...controls, ...patch };
    await writeFile(`${controlsPath}.tmp`, JSON.stringify(controls));
    await rename(`${controlsPath}.tmp`, controlsPath);
  };
  await setControls({});
  await writeFile(messagesPath, "");
  // Stub only this child server's Telegram transport. No real credentials or external requests.
  await writeFile(preloadPath, `
import { readFileSync, appendFileSync } from "node:fs";
const controls = () => JSON.parse(readFileSync(process.env.REMINDER_CONTROLS, "utf8"));
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [controls().now])); }
  static now() { return controls().now; }
};
const realInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => realInterval(fn, ms === 60_000 ? 50 : ms, ...args);
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith("https://api.telegram.org/botfixture-token/")) throw new Error("Unexpected external request");
  const state = JSON.parse(readFileSync(process.env.REMINDER_STORE, "utf8"));
  const status = controls().status;
  appendFileSync(process.env.REMINDER_MESSAGES, JSON.stringify({ body: JSON.parse(options.body), status,
    persistedOutbox: state.telegramAlertOutbox.length }) + "\\n");
  return new Response(JSON.stringify({ ok: status === 200, error_code: status }), { status });
};
`);
  await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (process.argv[2] !== "app-server") process.exit(0);
let lastOutcome;
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "account/read") result = { account: { type: "chatgpt" } };
  if (request.method === "account/rateLimits/read") {
    const control = JSON.parse(fs.readFileSync(process.env.REMINDER_CONTROLS, "utf8"));
    if (control.authFailure) {
      console.log(JSON.stringify({ id: request.id, error: { code: 401, message: "Unauthorized: fixture authentication failed" } }));
      return;
    }
    result = { rateLimits: {
      primary: { usedPercent: control.used, windowDurationMins: 300, resetsAt: control.fiveHourReset },
      secondary: { usedPercent: control.weekly, windowDurationMins: 10080, resetsAt: control.weeklyReset }
    }, rateLimitsByLimitId: { reserve: { limitName: "gpt-reserve", primary: { usedPercent: control.reserveUsed,
      windowDurationMins: 10080, resetsAt: control.weeklyReset } } }, ordinaryUsageAllowed: control.ordinaryAllowed,
      rateLimitResetCredits: { availableCount: control.count,
      credits: control.expirations.map(expiresAt => ({ expiresAt })) } };
    if (control.turnOutcome && control.turnOutcome !== lastOutcome) {
      lastOutcome = control.turnOutcome;
      console.log(JSON.stringify({ method: "turn/completed", params: { threadId: "fixture-thread", turn: {
        id: "fixture-turn", status: control.turnOutcome, ...(control.turnOutcome === "failed" ? { error: { message: "Fixture send failure" } } : {}) } } }));
    }
  }
  if (request.method === "thread/resume") result = { thread: { id: "fixture-thread" } };
  console.log(JSON.stringify({ id: request.id, result }));
});
`);
  await chmod(path.join(bin, "codex"), 0o755);
  await writeFile(storePath, JSON.stringify({
    settings: { schedulerEnabled: false, telegramAlertsEnabled: true,
      ...(legacyHours === undefined ? {} : { telegramResetExpiryHours: legacyHours }) },
    accounts: [{ id: "fixture", label: "Fixture account", enabled: false, codeHome: home,
      threadState: { threadId: "fixture-thread" },
      dashboard: { rateLimitResetCredits: { availableCount: 1, expiresAt: [expiry] } } }],
    selectedAccountId: "fixture",
    scheduledRuns: options.seedRun ? [{ id: "fixture-run", accountId: "fixture", reason: "scheduled", status: "started",
      turnId: "fixture-turn", ts: new Date(initialNow).toISOString() }] : []
  }));
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child;
  let logs = "";
  const request = async (route, method = "GET", body) => {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const start = async () => {
    child = spawn(process.execPath, ["--import", preloadPath, "src/server.mjs"], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DATA_DIR: dataDir, CODEX_HOME: home,
        CODEX_ACCOUNTS_DIR: path.join(temp, "accounts"), WORKSPACE_DIR: temp, PORT: String(port),
        ADMIN_EMAILS: "", TELEGRAM_BOT_TOKEN: "fixture-token", TELEGRAM_CHAT_ID: "fixture-chat",
        REMINDER_CONTROLS: controlsPath, REMINDER_MESSAGES: messagesPath, REMINDER_STORE: storePath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", chunk => { logs += chunk; });
    child.stderr.on("data", chunk => { logs += chunk; });
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Fixture server exited: ${logs}`);
      return request("/api/settings").catch(() => null);
    });
    await until(async () => (await request("/api/status")).body.accounts?.[0]?.dashboard?.rateLimitResetCredits?.updatedAt);
  };
  const stop = async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("exit", resolve));
    }
  };
  t.after(async () => { await stop(); await rm(temp, { recursive: true, force: true }); });
  await start();
  return { expiry, initialNow, setControls, request, start, stop,
    refresh: () => request("/api/refresh", "POST", {}),
    stored: async () => JSON.parse(await readFile(storePath, "utf8")),
    messages: async () => (await readFile(messagesPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse) };
}

test("reminder API validates settings, defaults to two days, and persists across restart", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request("/api/settings")).body.telegramResetReminderHours, [48]);
  for (const invalid of [null, "48", [0], [721], [1.5], [24, 24], Array.from({ length: 11 }, (_, i) => i + 1)]) {
    const result = await f.request("/api/settings", "PATCH", { telegramResetReminderHours: invalid });
    assert.equal(result.status, 400, JSON.stringify(result));
  }
  assert.equal((await f.request("/api/settings", "PATCH", { telegramResetReminderHours: [2, 48, 24] })).status, 200);
  await f.stop();
  await f.start();
  assert.deepEqual((await f.request("/api/settings")).body.telegramResetReminderHours, [48, 24, 2]);
  assert.equal((await f.request("/api/settings", "PATCH", { telegramResetReminderHours: [] })).status, 200);
  assert.deepEqual((await f.stored()).settings.telegramResetReminderHours, []);
});

test("migrates an existing single expiry warning", async t => {
  const f = await fixture(t, 12);
  assert.deepEqual((await f.request("/api/settings")).body.telegramResetReminderHours, [12]);
  assert.equal(Object.hasOwn((await f.stored()).settings, "telegramResetExpiryHours"), false);
});

test("timer reminds with paused sends, suppresses repeats and restarts, then sends the next reminder", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/settings", "PATCH", { telegramResetReminderHours: [48, 24] })).status, 200);
  assert.deepEqual(await f.messages(), []);
  await f.setControls({ now: f.expiry * 1000 - 48 * 3600_000 });
  const first = await until(f.messages, items => items.length === 1);
  assert.match(first[0].body.text, /2 days before expiry/);
  assert.ok(first[0].persistedOutbox > 0);
  await f.refresh();
  await delay(150);
  assert.equal((await f.messages()).length, 1);
  await f.stop();
  await f.start();
  await delay(150);
  assert.equal((await f.messages()).length, 1);
  await f.setControls({ now: f.expiry * 1000 - 24 * 3600_000 });
  const next = await until(f.messages, items => items.length === 2);
  assert.match(next[1].body.text, /1 day before expiry/);
});

test("deferred reminders use current credit counts and do not lose disabled reminders", async t => {
  const f = await fixture(t);
  await f.setControls({ now: f.expiry * 1000 - 48 * 3600_000, status: 500 });
  await until(f.messages, items => items.length === 1);
  await f.setControls({ count: 2, expirations: [f.expiry, f.expiry] });
  await f.refresh();
  await until(f.stored, state => state.accounts[0].dashboard.rateLimitResetCredits.availableCount === 2);
  assert.equal((await f.stored()).telegramAlertOutbox.filter(item => item.resetReminder).length, 1);
  await f.request("/api/settings", "PATCH", { telegramAlertResetCredits: false });
  await until(f.stored, state => state.telegramAlertOutbox.every(item => !item.resetReminder));
  await f.setControls({ status: 200, now: f.expiry * 1000 - 47 * 3600_000 });
  await f.request("/api/settings", "PATCH", { telegramAlertResetCredits: true });
  const delivered = await until(f.messages, items => items.some(item => item.status === 200 && /2 unused usage resets/.test(item.body.text)));
  assert.equal(delivered.filter(item => /unused usage resets/.test(item.body.text) && item.status === 200).length, 1);
});

test("coalesces deferred reminders and resumes retries after restart with the current inventory", async t => {
  const f = await fixture(t);
  await f.setControls({ now: f.expiry * 1000 - 48 * 3600_000, status: 500 });
  await until(f.messages, items => items.length === 1);
  await f.setControls({ count: 2, expirations: [f.expiry, f.expiry] });
  await f.refresh();
  await until(f.stored, state => state.accounts[0].dashboard.rateLimitResetCredits.availableCount === 2);
  assert.equal((await f.stored()).telegramAlertOutbox.filter(item => item.resetReminder).length, 1);
  await f.stop();
  await f.start();
  await f.setControls({ now: f.expiry * 1000 - 47 * 3600_000, status: 200 });
  await until(f.messages, items => items.some(item => item.status === 200 && /2 unused usage resets/.test(item.body.text)));
  await delay(150);
  assert.equal((await f.messages()).filter(item => item.status === 200 && /unused usage resets/.test(item.body.text)).length, 1);
});

test("changing a pending reminder's lead time immediately uses the newly due reminder", async t => {
  const f = await fixture(t);
  await f.setControls({ now: f.expiry * 1000 - 48 * 3600_000, status: 500 });
  await until(f.messages, items => items.length === 1);
  await f.setControls({ now: f.expiry * 1000 - 30_000, status: 200 });
  await f.request("/api/settings", "PATCH", { telegramResetReminderHours: [1] });
  const items = await until(f.messages, items => items.some(item => item.status === 200));
  assert.match(items.find(item => item.status === 200).body.text, /1 hour before expiry/);
});

test("drops queued reminders after the credit is consumed or expires", async t => {
  const f = await fixture(t);
  await f.setControls({ now: f.expiry * 1000 - 48 * 3600_000, status: 500 });
  await until(f.messages, items => items.length === 1);
  await f.setControls({ count: 0, expirations: [] });
  await f.refresh();
  await until(f.stored, state => state.telegramAlertOutbox.every(item => !item.resetReminder));
  assert.equal((await f.messages()).filter(item => item.status === 200 && /unused usage reset/.test(item.body.text)).length, 0);
  await f.setControls({ count: 1, expirations: [f.expiry], now: f.expiry * 1000 - 3600_000 });
  await f.refresh();
  await until(f.stored, state => state.telegramAlertOutbox.some(item => item.resetReminder));
  await f.setControls({ now: f.expiry * 1000 + 1000, status: 200 });
  await until(f.stored, state => state.telegramAlertOutbox.every(item => !item.resetReminder));
  assert.equal((await f.messages()).filter(item => item.status === 200 && /unused usage reset/.test(item.body.text)).length, 0);
});

test("custom notification counts and delays persist, and a future alert never blocks an immediate one", async t => {
  const f = await fixture(t);
  await f.request("/api/settings", "PATCH", { telegramQuotaWarningPercents: [50], telegramAlertRules: { "quota-threshold": [0, 1, 2] } });
  await f.setControls({ used: 60 });
  await f.refresh();
  await until(f.messages, items => items.length === 1);
  await until(f.stored, state => state.telegramAlertOutbox.length === 2);
  await f.setControls({ count: 2, expirations: [f.expiry, f.expiry] });
  await f.refresh();
  const immediate = await until(f.messages, items => items.length === 2);
  assert.match(immediate[1].body.text, /Usage resets changed/);
  await f.setControls({ now: f.initialNow + 61_000 });
  await until(f.messages, items => items.length === 3);
  await f.stop();
  await f.start();
  assert.equal((await f.messages()).length, 3);
  await f.setControls({ now: f.initialNow + 121_000 });
  const delivered = await until(f.messages, items => items.length === 4);
  assert.equal(delivered.filter(item => /crossed 50% free/.test(item.body.text)).length, 3);
  await f.refresh();
  await delay(120);
  assert.equal((await f.messages()).length, 4);
});

test("pending quota warnings stop after quota recovery or removal of a notification time", async t => {
  const f = await fixture(t);
  await f.request("/api/settings", "PATCH", { telegramQuotaWarningPercents: [50], telegramAlertRules: { "quota-threshold": [1, 2] } });
  await f.setControls({ used: 60 });
  await f.refresh();
  await until(f.stored, state => state.telegramAlertOutbox.length === 2);
  await f.request("/api/settings", "PATCH", { telegramAlertRules: { "quota-threshold": [2] } });
  await until(f.stored, state => state.telegramAlertOutbox.length === 1);
  await f.setControls({ used: 10 });
  await f.refresh();
  await until(f.stored, state => state.telegramAlertOutbox.length === 0);
  await f.setControls({ now: f.initialNow + 180_000 });
  await delay(120);
  assert.deepEqual(await f.messages(), []);
});

test("quota reset reminders repeat at chosen lead times, ignore clock projections, and renew next cycle", async t => {
  const f = await fixture(t);
  await f.request("/api/settings", "PATCH", { telegramQuotaReminderHours: { "5h": [2, 1] }, telegramAlertRules: { "quota-reset": [] } });
  await f.setControls({ now: f.initialNow + 2 * 3600_000 });
  const first = await until(f.messages, items => items.length === 1);
  assert.match(first[0].body.text, /2 hours before reset/);
  await f.setControls({ fiveHourReset: Math.floor(f.initialNow / 1000) + 4 * 3600 + 30 });
  await f.refresh();
  await delay(120);
  assert.equal((await f.messages()).length, 1);
  await f.setControls({ now: f.initialNow + 3 * 3600_000 + 60_000 });
  const next = await until(f.messages, items => items.length === 2);
  assert.match(next[1].body.text, /1 hour before reset/);
  await f.stop();
  await f.start();
  assert.equal((await f.messages()).length, 2);
  await f.setControls({ fiveHourReset: Math.floor(f.initialNow / 1000) + 9 * 3600, now: f.initialNow + 7 * 3600_000 });
  await f.refresh();
  await until(f.messages, items => items.length === 3);
});

test("credit count alerts and credit expiry alerts are independently configurable", async t => {
  const f = await fixture(t);
  await f.request("/api/settings", "PATCH", { telegramAlertResetExpiry: false, telegramAlertRules: { "reset-credit-count": [0, 1] } });
  await f.setControls({ count: 2, expirations: [f.expiry, f.expiry], now: f.expiry * 1000 - 24 * 3600_000 });
  await f.refresh();
  await until(f.messages, items => items.length === 1);
  await f.setControls({ now: f.expiry * 1000 - 24 * 3600_000 + 61_000 });
  const messages = await until(f.messages, items => items.length === 2);
  assert.ok(messages.every(item => /Usage resets changed/.test(item.body.text)));
  assert.ok(!messages.some(item => /unused usage reset/.test(item.body.text)));
});

test("Reserve recovery cancels pending activation follow-ups without disabling the recovery alert", async t => {
  const f = await fixture(t);
  await f.request("/api/settings", "PATCH", { telegramAlertRules: { "reserve-active": [0, 1], "reserve-recovered": [0] } });
  await f.setControls({ ordinaryAllowed: false });
  await f.refresh();
  await until(f.messages, items => items.length === 1);
  await f.setControls({ ordinaryAllowed: true });
  await f.refresh();
  const messages = await until(f.messages, items => items.length === 2);
  assert.match(messages[1].body.text, /returned to standby/);
  await f.setControls({ now: f.initialNow + 120_000 });
  await delay(120);
  assert.equal((await f.messages()).length, 2);
});

test("authentication and scheduled-turn failures have independent counts and cancel follow-ups after recovery", async t => {
  const f = await fixture(t, undefined, { seedRun: true });
  await f.request("/api/settings", "PATCH", { telegramAlertRules: { "auth-failure": [0, 1], "send-failure": [0, 1] } });
  await f.setControls({ authFailure: true });
  await f.refresh();
  await f.refresh();
  await until(f.messages, items => items.length === 1);
  await f.setControls({ authFailure: false });
  await f.refresh();
  await until(f.stored, state => state.telegramAlertOutbox.length === 0);
  await f.setControls({ now: f.initialNow + 120_000, turnOutcome: "failed" });
  await f.refresh();
  const messages = await until(f.messages, items => items.length === 2);
  assert.match(messages[1].body.text, /Scheduled Codex turn ended as failed/);
  await f.setControls({ now: f.initialNow + 121_000, turnOutcome: "completed" });
  await f.refresh();
  await until(f.stored, state => state.telegramAlertOutbox.length === 0);
  await f.setControls({ now: f.initialNow + 240_000 });
  await delay(120);
  assert.equal((await f.messages()).length, 2);
});
