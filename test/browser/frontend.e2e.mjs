import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fakeCodexSource = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-codex.cjs");
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium, webkit } = await import(playwrightModule);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated server exited early with ${child.exitCode}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error("isolated server did not become ready");
}

async function startFixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codex-window-e2e-"));
  const binDir = path.join(temp, "bin");
  const dataDir = path.join(temp, "data");
  const codeHomeA = path.join(temp, "home-a");
  const codeHomeB = path.join(temp, "home-b");
  const rpcLog = path.join(temp, "rpc.jsonl");
  await Promise.all([mkdir(binDir), mkdir(dataDir), mkdir(codeHomeA), mkdir(codeHomeB)]);
  const fakeCodex = path.join(binDir, "codex");
  await writeFile(fakeCodex, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeCodexSource)} "$@"\n`);
  await chmod(fakeCodex, 0o755);
  const now = Date.now();
  const samplesA = [
    { ts: new Date(now - 4 * 3600_000).toISOString(), fiveHourUsed: 18, weeklyUsed: 29, reserveUsed: 8, ordinaryUsageAllowed: true },
    { ts: new Date(now - 70_000).toISOString(), fiveHourUsed: 24, weeklyUsed: 34, reserveUsed: 9, ordinaryUsageAllowed: true }
  ];
  const samplesB = [
    { ts: new Date(now - 3 * 3600_000).toISOString(), fiveHourUsed: 44, weeklyUsed: 49, reserveUsed: 12, ordinaryUsageAllowed: true },
    { ts: new Date(now - 60_000).toISOString(), fiveHourUsed: 48, weeklyUsed: 52, reserveUsed: 13, ordinaryUsageAllowed: true }
  ];
  const dashboardA = { rateLimits: {
    primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 3600 },
    secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 86400 }, planType: "plus"
  }, rateLimitsByLimitId: { reserve: { limitName: "gpt-reserve", primary: { usedPercent: 9, windowDurationMins: 10080 }, updatedAt: new Date(now).toISOString() } } };
  const dashboardB = { rateLimits: {
    primary: { usedPercent: 48, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 1800 },
    secondary: { usedPercent: 52, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 72000 }, planType: "plus"
  }, rateLimitsByLimitId: { reserve: { limitName: "gpt-reserve", primary: { usedPercent: 13, windowDurationMins: 10080 }, updatedAt: new Date(now).toISOString() } } };
  const seed = {
    version: 1,
    settings: {
      schedulerEnabled: false, model: "", effort: "medium", workspaceDir: temp,
      skipIfActive: false, timezone: "Europe/Lisbon", scheduleTimes: ["08:00", "20:00"],
      promptTemplate: "Scheduled Codex window ping at {{local_time}}. Slot {{scheduled_time}} ({{reason}}).", approvalPolicy: "on-request", summary: "concise",
      networkAccess: false, telegramAlertsEnabled: false
    },
    selectedAccountId: "alpha",
    accounts: [
      { id: "alpha", label: "Alpha account", enabled: true, codeHome: codeHomeA, settings: {},
        threadState: { threadId: "alpha-thread", sessionId: "alpha-session", name: "Alpha" },
        dashboard: dashboardA, usageHistory: samplesA, usageObservedAt: {} },
      { id: "beta", label: "Beta account", enabled: true, codeHome: codeHomeB, settings: {},
        threadState: { threadId: "beta-thread", sessionId: "beta-session", name: "Beta" },
        dashboard: dashboardB, usageHistory: samplesB, usageObservedAt: {} }
    ],
    scheduledRuns: [],
    activityEvents: [
      { id: "seed-refresh", ts: new Date(now - 90_000).toISOString(), source: "refresh", severity: "info", message: "State refresh completed", payload: {} },
      { id: "seed-failed", ts: new Date(now - 60_000).toISOString(), source: "codex", severity: "info", message: "turn/failed",
        payload: { accountId: "alpha", accountLabel: "Alpha account", threadId: "alpha-thread", turn: { id: "failed-seed", status: "failed", error: "simulated failure" } } },
      { id: "seed-completed-error", ts: new Date(now - 50_000).toISOString(), source: "codex", severity: "info", message: "turn/completed",
        payload: { accountId: "alpha", accountLabel: "Alpha account", threadId: "alpha-thread", turn: { id: "completed-error-seed", status: "failed", error: "simulated completion error" } } },
      { id: "seed-success", ts: new Date(now - 40_000).toISOString(), source: "codex", severity: "info", message: "turn/completed",
        payload: { accountId: "alpha", accountLabel: "Alpha account", threadId: "alpha-thread", turn: { id: "success-seed", status: "completed" } } },
      { id: "seed-interrupted", ts: new Date(now - 30_000).toISOString(), source: "codex", severity: "info", message: "turn/interrupted",
        payload: { accountId: "alpha", accountLabel: "Alpha account", threadId: "alpha-thread", turn: { id: "interrupted-seed", status: "interrupted" } } }
    ],
    authEvents: []
  };
  await writeFile(path.join(dataDir, "store.json"), JSON.stringify(seed));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env, PATH: `${binDir}:${process.env.PATH}`, DATA_DIR: dataDir,
      CODEX_HOME: path.join(temp, "primary-home"), CODEX_ACCOUNTS_DIR: path.join(temp, "accounts"),
      WORKSPACE_DIR: temp, PORT: String(port), ADMIN_EMAILS: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "",
      RPC_LOG: rpcLog, FAKE_CODEX_RPC_LOG: rpcLog
    },
    stdio: "ignore"
  });
  try {
    await waitForServer(`${base}/api/health`, child);
    // Inject transport failures outside the browser so service workers cannot bypass them.
    const controls = { failPause: false, sendGate: null };
    const proxy = createServer(async (req, res) => {
      if (req.url === "/api/scheduler/pause" && controls.failPause) {
        controls.failPause = false;
        req.resume();
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Server busy. Try again." }));
        return;
      }
      if (req.url === "/api/run-now" && controls.sendGate) await controls.sendGate;
      const upstream = httpRequest(base + req.url, { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on("error", error => { if (!res.headersSent) res.writeHead(502); res.end(error.message); });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    await new Promise((resolve, reject) => proxy.listen(0, "127.0.0.1", resolve).once("error", reject));
    return { temp, base: `http://127.0.0.1:${proxy.address().port}`, child, rpcLog, dataDir, proxy, controls };
  } catch (error) {
    child.kill("SIGTERM");
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

async function stopFixture(fixture) {
  fixture.proxy.closeAllConnections();
  await new Promise(resolve => fixture.proxy.close(resolve));
  if (fixture.child.exitCode === null) {
    fixture.child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => fixture.child.once("exit", resolve)), delay(4000)]);
    if (fixture.child.exitCode === null) fixture.child.kill("SIGKILL");
  }
  await rm(fixture.temp, { recursive: true, force: true });
}

async function screenshot(page, name) {
  if (!process.env.E2E_OUTPUT_DIR) return;
  await mkdir(process.env.E2E_OUTPUT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.E2E_OUTPUT_DIR, `${name}.png`), fullPage: false });
}

async function assertNoPageErrors(page, errors) {
  await page.waitForTimeout(200);
  assert.deepEqual(errors, [], `browser console/page errors: ${errors.join("\n")}`);
}

async function requestJson(base, route, method = "GET", body) {
  const response = await fetch(base + route, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(response.ok, true, `${method} ${route} failed`);
  return response.json();
}

async function accountWorkflow(page, fixture, label) {
  // Cancel is reversible and does not create an account.
  await page.locator("#addAccountOpenBtn").click();
  await page.locator("#newAccountLabelInput").fill("Cancelled account");
  await page.locator("#cancelAddAccountBtn").click();
  assert.equal((await requestJson(fixture.base, "/api/accounts")).accounts.length, 2);

  // Rename and per-account drafts survive polling and switching away and back.
  await page.locator("#accountSettings > summary").click();
  await page.locator("#accountLabelInput").fill("Alpha renamed");
  await page.locator("#refreshBtn").click();
  await page.waitForFunction(() => !document.querySelector("#refreshBtn").disabled);
  assert.equal(await page.locator("#accountLabelInput").inputValue(), "Alpha renamed");
  await page.locator("#saveAccountBtn").click();
  await page.locator("#accountDetailsMessage").getByText("Name saved.", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector("#accountSelect option:checked").textContent === "Alpha renamed");
  await page.locator("#accountOverrides > summary").click();
  await page.locator("#accountPromptInput").fill("Draft account prompt");
  await page.locator("#accountPromptInput").evaluate(el => el.setSelectionRange(3, 8));
  await page.locator("#refreshBtn").click();
  await page.waitForFunction(() => !document.querySelector("#refreshBtn").disabled);
  assert.deepEqual(await page.locator("#accountPromptInput").evaluate(el => [el.selectionStart, el.selectionEnd]), [3, 8]);
  await page.locator("#accountSelect").selectOption("beta");
  await page.waitForFunction(() => document.querySelector("#accountSelect").value === "beta" && !document.querySelector("#accountSelect").disabled);
  await page.locator("#accountSelect").selectOption("alpha");
  await page.waitForFunction(() => document.querySelector("#accountSelect").value === "alpha" && !document.querySelector("#accountSelect").disabled);
  await page.locator("#accountSettings > summary").click();
  await page.locator("#accountOverrides > summary").click();
  assert.equal(await page.locator("#accountPromptInput").inputValue(), "Draft account prompt");
  await page.locator("#saveAccountOverridesBtn").click();
  await page.locator("#accountOverridesMessage").getByText("Custom settings saved.", { exact: true }).waitFor();
  const alpha = (await requestJson(fixture.base, "/api/accounts")).accounts.find(a => a.id === "alpha");
  assert.equal(alpha.settings.promptTemplate, "Draft account prompt");
  await page.locator("#accountEnabledInput").uncheck();
  await page.waitForFunction(() => !document.querySelector("#accountEnabledInput").disabled);
  assert.equal((await requestJson(fixture.base, "/api/accounts")).accounts.find(a => a.id === "alpha").enabled, false);
  await page.locator("#accountEnabledInput").check();
  await page.waitForFunction(() => !document.querySelector("#accountEnabledInput").disabled);

  // Add creates a signed-out account with scheduled sends paused.
  await page.locator("#addAccountOpenBtn").click();
  await page.locator("#newAccountLabelInput").fill("Work account");
  await page.locator("#addAccountBtn").click();
  await page.waitForFunction(() => !document.querySelector("#addAccountDialog").open && !document.querySelector("#accountSelect").disabled);
  const newId = await page.locator("#accountSelect").inputValue();
  assert.notEqual(newId, "alpha");
  assert.equal(await page.locator("#accountEnabledInput").isChecked(), false);
  await page.locator("#deviceLoginBtn").waitFor();
  assert.equal(await page.locator("#manualSendBtn").isDisabled(), true);
  // Fail once, then retry using the actual local login process and SSE bridge.
  await writeFile(path.join(fixture.temp, "accounts", newId, ".fake-fail-login"), "fail once");
  await page.locator("#deviceLoginBtn").click();
  await page.locator("#loginSteps:not([hidden])").waitFor();
  assert.equal(await page.locator("#loginCode").textContent(), "TEST0-CODE9");
  assert.equal(await page.locator("#loginLink").getAttribute("href"), "https://auth.openai.com/codex/device");
  assert.equal(await page.locator(".login-diagnostics").evaluate(el => el.open), false);
  // Keep this check independent of host clipboard permissions and contents.
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copiedLoginCode = text; } } }));
  await page.locator("#copyLoginCodeBtn").click();
  await page.waitForFunction(() => document.querySelector("#loginMessage").textContent === "Code copied.");
  assert.equal(await page.evaluate(() => window.copiedLoginCode), "TEST0-CODE9");
  await screenshot(page, `${label}-sign-in`);
  await page.locator('#loginProgress[data-state="failed"]').waitFor();
  assert.equal(await page.locator("#loginCode").textContent(), "");
  await page.locator("#deviceLoginBtn").click();
  await page.locator("#loginSteps:not([hidden])").waitFor();
  await page.locator('#loginProgress[data-state="completed"]').waitFor();
  await page.waitForFunction(() => document.querySelector("#accountAccessTitle").textContent === "Connected to Work account");
  assert.equal(await page.locator("#loginCode").textContent(), "");
  assert.equal(await page.locator("#loginSteps").isVisible(), false);
  assert.equal(await page.locator("#accountEnabledInput").isChecked(), false);
  assert.equal(await page.locator("#deviceLoginBtn").isVisible(), false);
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  assert.ok(!stored.includes("TEST0-CODE9"), "sign-in code must not enter local snapshots");
  await page.locator("#accountAccess").scrollIntoViewIfNeeded();
  await screenshot(page, `${label}-connected`);

  // Switching accounts clears the previous account's sign-in state.
  await page.locator("#accountSelect").selectOption("beta");
  await page.waitForFunction(() => document.querySelector("#accountSelect").value === "beta" && !document.querySelector("#accountSelect").disabled);
  assert.equal(await page.locator("#loginProgress").isVisible(), false);
  await page.locator("#accountSelect").selectOption(newId);
  await page.waitForFunction(() => document.querySelector("#accountSelect").value !== "beta" && !document.querySelector("#accountSelect").disabled);
  await page.locator("#accountSettings > summary").click();
  await page.locator(".account-danger > summary").click();
  await page.locator("#logoutBtn").click();
  await page.locator("#accountDangerMessage").getByText("Signed out.", { exact: true }).waitFor();
  await page.locator("#deviceLoginBtn").waitFor();
  assert.equal(await page.locator("#loginProgress").isVisible(), false);
  // Only this disposable fixture account is deleted, after the user's confirmation.
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#removeAccountBtn").click();
  assert.equal((await requestJson(fixture.base, "/api/accounts")).accounts.length, 3);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#removeAccountBtn").click();
  await page.waitForFunction(() => document.querySelector("#accountSelect").options.length === 2 && !document.querySelector("#accountSelect").disabled);
}

async function openSchedule(page, tab = "schedule") {
  if (!await page.locator("#scheduleDialog").evaluate(el => el.open)) await page.locator("#editScheduleBtn").click();
  await page.locator(`#${tab}-tab`).click();
}

async function saveSchedule(page) {
  await page.locator("#settingsForm button[type=submit]").click();
  await page.waitForFunction(() => !document.querySelector("#scheduleDialog").open && document.querySelector("#scheduleMessage").textContent === "Schedule saved.");
}

async function exercise(browserType, fixture, viewport, label) {
  const executablePath = process.env[browserType.name() === "chromium" ? "CHROMIUM_EXECUTABLE_PATH" : "WEBKIT_EXECUTABLE_PATH"];
  const browser = await browserType.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const pageErrors = [];
    const contextOptions = { viewport: viewport.size, deviceScaleFactor: viewport.deviceScaleFactor || 1,
      isMobile: Boolean(viewport.isMobile), hasTouch: Boolean(viewport.hasTouch) };
    const page = await browser.newPage(contextOptions);
    page.on("pageerror", error => pageErrors.push(error.message));
    const expectedHttpErrors = new Set();
    let offlineCheck = false;
    page.on("console", message => {
      if (message.type() !== "error") return;
      if ((offlineCheck || expectedHttpErrors.has(message.location().url)) && /Failed to load resource|Fetch API cannot load/i.test(message.text())) return;
      pageErrors.push(`${message.text()} (${message.location().url})`);
    });
    page.setDefaultTimeout(12_000);
    await page.addInitScript(() => { if (!localStorage.getItem("theme")) localStorage.setItem("theme", "light"); });
    await page.goto(fixture.base, { waitUntil: "domcontentloaded" });
    await page.locator("#fleetRows .strip-row").first().waitFor();
    await page.waitForFunction(() => document.querySelector("#accountSelect").options.length === 2);
    await page.waitForFunction(() => document.querySelector("#timezoneInput").value === "Europe/Lisbon");
    await page.waitForFunction(() => /Scheduled Codex window ping at \d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Lisbon/.test(document.querySelector("#schedulePrompt").textContent));
    assert.ok(!(await page.locator("#schedulePrompt").textContent()).includes("{{"));
    assert.equal(await page.locator("#schedulePromptHint").isVisible(), true);
    assert.ok((await page.locator("#promptInput").inputValue()).includes("{{local_time}}"));
    await page.locator("#schedule").scrollIntoViewIfNeeded();
    await screenshot(page, `${label}-rendered-message-preview`);

    // Theme switch persists across reload.
    await page.locator("#themeToggleBtn").click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.locator("#themeToggleBtn").click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");

    // Focused editor: keyboard tabs, add/remove times, saved summary and persistence.
    assert.equal(await page.locator("#settingsForm").isVisible(), false);
    await openSchedule(page);
    await page.locator("#schedule-tab").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#run-tab").getAttribute("aria-selected"), "true");
    await page.keyboard.press("End");
    assert.equal(await page.locator("#alerts-tab").getAttribute("aria-selected"), "true");
    await page.keyboard.press("Home");
    await page.locator("#scheduleTimeInputs input").nth(0).fill("07:15");
    await page.locator("#scheduleTimeInputs input").nth(1).fill("19:45");
    await page.locator("#addScheduleTimeBtn").click();
    assert.equal(await page.locator("#scheduleTimeInputs input").count(), 3);
    await page.locator("#scheduleTimeInputs button").last().click();
    assert.equal(await page.locator("#scheduleTimeInputs input").count(), 2);
    await page.locator("#run-tab").click();
    await page.locator("#advancedSettings > summary").click();
    await page.locator("#effortInput").fill("low");
    await page.locator("#summaryInput").fill("E2E summary");
    await page.locator("#promptInput").fill("E2E saved prompt");
    await page.locator("#modelInput").selectOption("gpt-5.6-luna");
    await page.locator("#alerts-tab").click();
    assert.equal(await page.locator("#telegramEnabledInput").isVisible(), true);
    await screenshot(page, `${label}-schedule-alerts`);
    await page.locator("#schedule-tab").click();
    await screenshot(page, `${label}-schedule-editor`);
    await saveSchedule(page);
    assert.equal(await page.locator("#scheduleTimes").textContent(), "07:1519:45");
    assert.equal(await page.locator("#schedulePrompt").textContent(), "E2E saved prompt");
    assert.equal(await page.locator("#schedulePromptHint").isVisible(), false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#scheduleInput").value === "07:15, 19:45");
    assert.equal(await page.locator("#modelInput").inputValue(), "gpt-5.6-luna");
    assert.equal(await page.locator("#effortInput").inputValue(), "low");
    // Cancel discards only the editor draft; Escape retains it for reopening.
    await openSchedule(page, "run");
    await page.locator("#promptInput").fill("Discard this draft");
    await page.locator("#cancelScheduleBtn").click();
    await openSchedule(page);
    await page.locator("#scheduleTimeInputs input").first().fill("");
    await page.locator("#alerts-tab").click();
    await page.locator("#telegramQuotaThresholdInput").fill("0");
    await page.locator("#run-tab").click();
    await page.locator("#settingsForm button[type=submit]").click();
    assert.equal(await page.locator("#schedule-tab").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#scheduleTimeInputs input").first().evaluate(el => el === document.activeElement), true);
    await page.locator("#scheduleTimeInputs input").first().fill("07:15");
    await page.locator("#settingsForm button[type=submit]").click();
    assert.equal(await page.locator("#alerts-tab").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#telegramQuotaThresholdInput").evaluate(el => el === document.activeElement), true);
    await page.locator("#cancelScheduleBtn").click();
    await openSchedule(page, "run");
    assert.equal(await page.locator("#promptInput").inputValue(), "E2E saved prompt");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#scheduleDialog").open);
    assert.equal(await page.locator("#editScheduleBtn").evaluate(el => el === document.activeElement), true);

    if (await page.locator("#schedulerBadge").textContent() === "Paused") await page.locator("#schedulerToggleBtn").click();
    await page.waitForFunction(() => document.querySelector("#schedulerBadge").textContent === "Enabled");
    await page.locator("#schedulerToggleBtn").click();
    await page.waitForFunction(() => document.querySelector("#schedulerBadge").textContent === "Paused");
    await page.locator("#schedulerToggleBtn").click();
    await page.waitForFunction(() => document.querySelector("#schedulerBadge").textContent === "Enabled");
    const selectBox = await page.locator("#accountSelect").boundingBox();
    assert.ok(selectBox.height >= 44 && selectBox.width >= 140, "account selector needs usable Safari dimensions");
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#themeToggleBtn").click();
      await page.locator("#account").scrollIntoViewIfNeeded();
      if (process.env.E2E_OUTPUT_DIR) await page.locator("#account").screenshot({ path: path.join(process.env.E2E_OUTPUT_DIR, `${label}-${theme}-account.png`) });
      await page.locator("#schedule").scrollIntoViewIfNeeded();
      await screenshot(page, `${label}-${theme}-schedule-summary`);
    }

    // Account switching updates selection and account-specific model catalogue.
    await page.locator("#accountSelect").selectOption("beta");
    await page.waitForFunction(() => document.querySelector("#accountSelect").value === "beta");
    await page.waitForFunction(() => document.querySelector("#accountConsoleTitle").textContent.includes("Account console"));
    assert.equal((await (await fetch(`${fixture.base}/api/status`)).json()).selectedAccountId, "beta");
    await page.locator("#accountSelect").selectOption("alpha");
    await page.waitForFunction(() => document.querySelector("#accountSelect").value === "alpha");

    // Chart ranges, legend keyboard activation and usage-history loading.
    for (const range of ["6h", "24h", "7d", "30d"]) {
      await page.locator(`#usageHistoryRanges [data-range="${range}"]`).click();
      await page.waitForFunction(expected => document.querySelector(`#usageHistoryRanges [data-range="${expected}"]`).getAttribute("aria-pressed") === "true", range);
    }
    const cursor = page.locator("#usageHistoryFiveHourChart .usage-hover-layer");
    await cursor.focus();
    await page.keyboard.press("Home");
    const firstTime = await page.locator("#usageHistoryFiveHourChartInspector strong").textContent();
    await page.keyboard.press("End");
    const lastTime = await page.locator("#usageHistoryFiveHourChartInspector strong").textContent();
    assert.notEqual(firstTime, lastTime, "keyboard cursor must inspect different readings");
    const legendToggle = page.locator("#usageHistoryLegend button").first();
    if (await legendToggle.count()) {
      await legendToggle.focus();
      await page.keyboard.press("Enter");
      assert.equal(await legendToggle.getAttribute("aria-pressed"), "false");
      await page.keyboard.press("Space");
      assert.equal(await legendToggle.getAttribute("aria-pressed"), "true");
    }

    // Shared settings edits survive a refresh until explicitly saved.
    await openSchedule(page, "run");
    await page.locator("#promptInput").fill("Unsaved shared draft");
    await page.keyboard.press("Escape");
    await page.locator("#refreshBtn").click();
    await page.waitForFunction(() => !document.querySelector("#refreshBtn").disabled);
    await openSchedule(page, "run");
    assert.equal(await page.locator("#promptInput").inputValue(), "Unsaved shared draft");
    await saveSchedule(page);
    await accountWorkflow(page, fixture, label);

    // Seeded failures and success must use distinct semantic classes/tones.
    const failedTurn = page.locator("[data-event-id='seed-failed']");
    const completedFailure = page.locator("[data-event-id='seed-completed-error']");
    const successTurn = page.locator("[data-event-id='seed-success']");
    const interruptedTurn = page.locator("[data-event-id='seed-interrupted']");
    await failedTurn.waitFor();
    await completedFailure.waitFor();
    await successTurn.waitFor();
    await interruptedTurn.waitFor();
    for (const item of [failedTurn, completedFailure]) assert.match(await item.getAttribute("class"), /\bbad\b|\berror\b/);
    assert.match(await successTurn.getAttribute("class"), /\bsuccess\b/);
    assert.match(await interruptedTurn.getAttribute("class"), /\bwarn\b/);
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#themeToggleBtn").click();
      for (const [item, token] of [[failedTurn, "--bad"], [completedFailure, "--bad"], [successTurn, "--ok"], [interruptedTurn, "--warn"]]) {
        assert.equal(await item.evaluate((el, token) => {
          const probe = document.createElement("i");
          probe.style.background = `var(${token})`;
          el.append(probe);
          const expected = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return getComputedStyle(el.querySelector(".timeline-dot")).backgroundColor === expected;
        }, token), true, `activity marker should use ${token}`);
      }
      await page.locator("#activity").scrollIntoViewIfNeeded();
      if (process.env.E2E_OUTPUT_DIR) {
        await mkdir(process.env.E2E_OUTPUT_DIR, { recursive: true });
        await page.locator("#activityList").evaluate(el => { el.scrollTop = el.scrollHeight; });
        await page.locator("#activity").screenshot({ path: path.join(process.env.E2E_OUTPUT_DIR, `${label}-${theme}-activity.png`) });
      }
    }
    assert.equal(await page.locator("[data-event-id='seed-refresh']").count(), 0);
    await page.locator("#rawEventsInput").check();
    await page.locator("[data-event-id='seed-refresh']").waitFor();
    await page.locator("#rawEventsInput").uncheck();
    assert.equal(await page.locator("[data-event-id='seed-refresh']").count(), 0);
    await page.locator("#clearActivityBtn").click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#accountSelect").options.length === 2);
    assert.equal(await page.locator("[data-event-id='seed-success']").count(), 0);
    await page.locator("#runNowBtn").click();
    await page.locator(".activity-item").filter({ hasText: "Turn started" }).first().waitFor({ timeout: 10_000 });
    await page.locator(".activity-item.success").filter({ hasText: "e2e-turn-" }).first().waitFor({ timeout: 10_000 });

    // Real app-server notifications travel over the server's SSE connection.
    for (const [prompt, tone, title] of [["E2E_FAIL", "error", "Turn failed"], ["E2E_INTERRUPT", "warn", "Turn interrupted"]]) {
      await page.locator("#manualPromptInput").fill(prompt);
      await page.locator("#manualSendBtn").click();
      await page.locator("#manualMessage").getByText("Turn started. Follow its progress in Activity.", { exact: true }).waitFor();
      await page.locator(`.activity-item.${tone}`).filter({ hasText: title }).filter({ hasText: "e2e-turn-" }).first().waitFor();
      await page.waitForFunction(expected => document.querySelector("#windowBadge").textContent === expected, title === "Turn failed" ? "Last turn failed" : "Last turn interrupted");
    }

    // A rejected turn start and scheduler request both produce actionable feedback.
    expectedHttpErrors.add(`${fixture.base}/api/run-now`);
    await page.locator("#manualPromptInput").fill("E2E_START_ERROR");
    await page.locator("#manualSendBtn").click();
    await page.waitForFunction(() => document.querySelector("#manualMessage").dataset.tone === "error" && /Simulated turn start failure/.test(document.querySelector("#manualMessage").textContent));
    await page.waitForFunction(() => !document.querySelector("#manualSendBtn").disabled);
    expectedHttpErrors.add(`${fixture.base}/api/scheduler/pause`);
    fixture.controls.failPause = true;
    await page.locator("#schedulerToggleBtn").click();
    await page.locator("#schedulerMessage").getByText("Server busy. Try again.", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector("#schedulerToggleBtn").disabled);

    // Both send buttons lock while one request is pending; selection stays scoped.
    let releaseSend;
    fixture.controls.sendGate = new Promise(resolve => { releaseSend = resolve; });
    await page.locator("#manualPromptInput").fill("normal send");
    await page.locator("#manualSendBtn").click();
    await page.waitForFunction(() => document.querySelector("#manualSendBtn").disabled && document.querySelector("#runNowBtn").disabled);
    assert.equal(await page.locator("#accountSelect").isDisabled(), true);
    releaseSend();
    fixture.controls.sendGate = null;
    await page.waitForFunction(() => !document.querySelector("#manualSendBtn").disabled);

    // Server validation errors stay visible, and the next valid save recovers.
    expectedHttpErrors.add(`${fixture.base}/api/settings`);
    await openSchedule(page);
    await page.locator("#timezoneInput").fill("Invalid/Timezone");
    await page.locator("#settingsForm button[type=submit]").click();
    await page.locator("#settingsMessage").getByText("Invalid timezone", { exact: true }).waitFor();
    await page.locator("#timezoneInput").fill("Europe/Lisbon");
    await saveSchedule(page);

    // Keep the pill's edge gap compact even when iOS reports a larger safe area.
    if (viewport.isMobile || viewport.hasTouch) {
      await page.addStyleTag({ content: ":root { --safe-bottom: 34px; }" });
      const dock = page.locator(".mobile-dock");
      const dockBox = await dock.boundingBox();
      const dockStyle = await dock.evaluate(el => ({ radius: getComputedStyle(el).borderRadius, bottom: innerHeight - el.getBoundingClientRect().bottom, paddingBottom: getComputedStyle(el).paddingBottom }));
      assert.ok(dockBox && dockBox.x > 0, `dock should float inside viewport; x=${dockBox?.x}`);
      assert.match(dockStyle.radius, /999px/);
      assert.ok(dockBox.height <= 90, `dock is too tall (${dockBox.height}px)`);
      assert.ok(Math.abs(dockStyle.bottom - 12) <= 1, `dock should sit 12px from the bottom; got ${dockStyle.bottom}`);
      const rightGap = viewport.size.width - dockBox.x - dockBox.width;
      assert.ok(Math.abs(dockBox.x - rightGap) <= 1, "dock should be horizontally centered");
      if (viewport.size.width <= 440) {
        assert.ok(Math.abs(dockBox.x - dockStyle.bottom) <= 1, "portrait dock should have equal side and bottom gaps");
      }
      for (const inset of [0, 21]) {
        await page.evaluate(value => document.documentElement.style.setProperty("--safe-bottom", `${value}px`), inset);
        const bottom = await dock.evaluate(el => innerHeight - el.getBoundingClientRect().bottom);
        assert.ok(Math.abs(bottom - 12) <= 1, `safe area ${inset}px must not lift the pill; got ${bottom}`);
      }
      await page.evaluate(() => document.documentElement.style.removeProperty("--safe-bottom"));
      for (const link of await dock.locator("a").all()) {
        const box = await link.boundingBox();
        assert.ok(box && box.height >= 44 && box.width >= 44, `dock touch target too short: ${box?.height}`);
      }
      for (const section of ["account", "schedule", "send", "activity", "fleet"]) {
        await dock.locator(`a[data-section=${section}]`).click();
        await page.waitForFunction(id => location.hash === `#${id}` && document.querySelector(`.mobile-dock a[data-section="${id}"]`).getAttribute("aria-current") === "location", section);
      }
      await dock.locator("a[data-section=activity]").click();
      await page.waitForFunction(() => location.hash === "#activity" && document.querySelector('.mobile-dock a[data-section="activity"]').getAttribute("aria-current") === "location");
      await dock.locator("a[data-section=fleet]").click();
      await page.waitForFunction(() => location.hash === "#fleet");
    }
    const rowOverlaps = await page.locator("#fleetRows .strip-row").evaluateAll(rows => rows.some(row => {
      const cell = row.querySelector(".strip-cell")?.getBoundingClientRect();
      const meta = row.querySelector(".strip-meta")?.getBoundingClientRect();
      return cell && meta && cell.left < meta.right && cell.right > meta.left + 1 && cell.top < meta.bottom && cell.bottom > meta.top + 1;
    }));
    assert.equal(rowOverlaps, false, "quota tracks and reset metadata must not overlap");
    const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(overflow.scroll <= overflow.client + 1, `horizontal overflow ${overflow.scroll - overflow.client}px`);
    await page.locator(".mobile-dock a[data-section=fleet]").click();
    await page.waitForFunction(() => document.querySelector("#fleet").getBoundingClientRect().top >= 0 && document.querySelector("#fleet").getBoundingClientRect().top < 100);
    await screenshot(page, label);
    await assertNoPageErrors(page, pageErrors);

    // Installed shell and privacy-reduced snapshots survive a network outage.
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    offlineCheck = true;
    await page.context().setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#connectionBanner:not([hidden])").waitFor();
    await page.locator("#fleetRows .strip-row").first().waitFor();
    await page.context().setOffline(false);
    // The existing online handler reloads the shell automatically.
    await page.waitForFunction(() => document.querySelector("#connectionBanner").hidden && document.querySelector("#accountSelect").options.length === 2);
    offlineCheck = false;
    await assertNoPageErrors(page, pageErrors);
  } finally {
    await browser.close();
  }
}

test("local frontend E2E in Chromium and WebKit with desktop and mobile layouts", { timeout: 240_000 }, async t => {
  const chromiumRuns = [
    { name: "chromium-desktop", size: { width: 1440, height: 1000 } },
    { name: "chromium-iphone", size: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    { name: "chromium-narrow320", size: { width: 320, height: 740 }, isMobile: true, hasTouch: true },
    { name: "chromium-landscape", size: { width: 844, height: 390 }, isMobile: true, hasTouch: true }
  ];
  const webkitRuns = [
    { name: "webkit-desktop", size: { width: 1440, height: 1000 } },
    { name: "webkit-iphone", size: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
  ];
  for (const [browserType, cases] of [[chromium, chromiumRuns], [webkit, webkitRuns]]) {
    for (const viewport of cases.filter(v => !process.env.E2E_CASE || v.name.includes(process.env.E2E_CASE))) {
      await t.test(viewport.name, async () => {
        const fixture = await startFixture();
        try { await exercise(browserType, fixture, viewport, viewport.name); }
        finally { await stopFixture(fixture); }
      });
    }
  }
});
