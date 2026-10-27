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
    const controls = { resetCreditCount: null, failPause: false, sendGate: null, deleteGate: null, deleteRequests: [], failDelete: false, loseDeleteResponse: false, failStatusAfterDelete: false, failNextStatus: false };
    const proxy = createServer(async (req, res) => {
      if (req.url === "/api/status" && controls.failNextStatus) {
        if (!controls.failStatusAfterDelete) controls.failNextStatus = false;
        req.resume();
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Status temporarily unavailable." }));
        return;
      }
      const deleting = req.method === "DELETE" && req.url.startsWith("/api/accounts/");
      if (deleting) {
        controls.deleteRequests.push(req.url);
        if (controls.failDelete) {
          controls.failDelete = false;
          req.resume();
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Temporary removal failure. Try again." }));
          return;
        }
        if (controls.deleteGate) await controls.deleteGate;
      }
      if (req.url === "/api/scheduler/pause" && controls.failPause) {
        controls.failPause = false;
        req.resume();
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Server busy. Try again." }));
        return;
      }
      if (req.url === "/api/run-now" && controls.sendGate) await controls.sendGate;
      const upstream = httpRequest(base + req.url, { method: req.method, headers: req.headers }, response => {
        if (req.url === "/api/status" && controls.resetCreditCount !== null && response.statusCode === 200) {
          const chunks = [];
          response.on("data", chunk => chunks.push(chunk));
          response.on("end", () => {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            const credits = { availableCount: controls.resetCreditCount, detailsComplete: true,
              expiresAt: Array.from({ length: controls.resetCreditCount }, (_, index) => Math.floor(now / 1000) + (index + 1) * 86400) };
            for (const account of data.accounts) account.dashboard.rateLimitResetCredits = credits;
            if (data.dashboard) data.dashboard.rateLimitResetCredits = credits;
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify(data));
          });
          return;
        }
        if (deleting && response.statusCode === 200) {
          controls.failNextStatus = controls.failStatusAfterDelete;
          if (controls.loseDeleteResponse) {
            controls.loseDeleteResponse = false;
            response.resume();
            response.on("end", () => {
              res.writeHead(503, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "Removal response lost." }));
            });
            return;
          }
        }
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

async function navigate(page, section) {
  const view = section === "account" ? "account" : section;
  const title = { fleet: "Overview", account: "Accounts", usage: "Usage", schedule: "Schedule", alerts: "Alerts", activity: "Activity" }[view];
  await page.locator(`.mobile-dock a[data-section="${section}"]`).click();
  await page.waitForFunction(({ section, view, title }) => {
    const active = document.querySelector(`.mobile-dock a[data-section="${section}"]`);
    const visibleViews = [...document.querySelectorAll("[data-view]")].filter(item => !item.hidden);
    return location.hash === `#${section}` && active?.getAttribute("aria-current") === "page"
      && visibleViews.length > 0 && visibleViews.every(item => item.dataset.view === view)
      && document.querySelector("#pageTitle")?.textContent === title;
  }, { section, view, title });
}

async function chartLabelValues(page, chartId) {
  return page.locator(`#${chartId} .usage-point-label[data-account-id] .usage-point-value`)
    .evaluateAll(nodes => nodes.map(node => node.textContent.replace(/\*+$/, "")).sort());
}

async function chartInspectorValues(page, chartId) {
  return page.locator(`#${chartId}Inspector tbody tr`)
    .evaluateAll(rows => rows.map(row => row.cells[1].firstChild.textContent).filter(value => value !== "—").sort());
}

async function chartLabelsOverlap(page, chartId) {
  return page.locator(`#${chartId} .usage-point-label[data-account-id]`).evaluateAll(labels => {
    const boxes = labels.map(label => label.querySelector("rect")?.getBBox() || label.getBBox());
    return boxes.some((a, index) => boxes.slice(index + 1).some(b => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y));
  });
}

async function accountWorkflow(page, fixture, label, expectedHttpErrors) {
  await navigate(page, "account");
  await page.locator("#accountDiagnostics").waitFor();
  assert.equal(await page.locator("#accountDiagnostics").evaluate(element => element.open), false);
  assert.equal(await page.locator(".account-danger").isVisible(), true, "sign-out and removal remain in the account footer");
  assert.equal(await page.locator(".account-danger summary").count(), 0, "account danger actions are not hidden behind a disclosure");
  for (const id of ["accountLabelInput", "saveAccountBtn", "editAccountRunSettingsBtn", "logoutBtn", "removeAccountBtn"]) {
    assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} remains available with diagnostics closed`);
  }
  assert.equal(await page.locator("#accountOverrides").evaluate(element => element.open), false);
  // Cancel is reversible and does not create an account.
  await page.locator("#addAccountOpenBtn").click();
  await page.locator("#newAccountLabelInput").fill("Cancelled account");
  await page.locator("#cancelAddAccountBtn").click();
  assert.equal((await requestJson(fixture.base, "/api/accounts")).accounts.length, 2);

  // Rename and per-account drafts survive polling and switching away and back.
  await page.locator("#accountLabelInput").fill("Alpha renamed");
  await page.locator("#refreshBtn").click();
  await page.waitForFunction(() => !document.querySelector("#refreshBtn").disabled);
  assert.equal(await page.locator("#accountLabelInput").inputValue(), "Alpha renamed");
  await page.locator("#saveAccountBtn").click();
  await page.locator("#accountDetailsMessage").getByText("Name saved.", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector("#accountSelect option:checked").textContent === "Alpha renamed");
  await page.locator("#editAccountRunSettingsBtn").click();
  assert.equal(await page.locator("#accountOverrides").evaluate(element => element.open), true);
  await page.locator("#accountPromptInput").fill("Draft account prompt");
  await page.locator("#accountPromptInput").evaluate(el => el.setSelectionRange(3, 8));
  await page.locator("#closeAccountRunSettingsBtn").click();
  assert.equal(await page.locator("#accountOverrides").evaluate(element => element.open), false);
  await page.locator("#refreshBtn").click();
  await page.waitForFunction(() => !document.querySelector("#refreshBtn").disabled);
  await page.locator("#editAccountRunSettingsBtn").click();
  assert.deepEqual(await page.locator("#accountPromptInput").evaluate(el => [el.selectionStart, el.selectionEnd]), [3, 8]);
  await page.locator("#closeAccountRunSettingsBtn").click();
  await page.locator("#accountSelect").selectOption("beta");
  await page.waitForFunction(() => document.querySelector("#accountSelect").value === "beta" && !document.querySelector("#accountSelect").disabled);
  await page.locator("#accountSelect").selectOption("alpha");
  await page.waitForFunction(() => document.querySelector("#accountSelect").value === "alpha" && !document.querySelector("#accountSelect").disabled);
  await page.locator("#editAccountRunSettingsBtn").click();
  assert.equal(await page.locator("#accountPromptInput").inputValue(), "Draft account prompt");
  await page.locator("#saveAccountOverridesBtn").click();
  await page.locator("#accountOverridesMessage").getByText("Custom settings saved.", { exact: true }).waitFor();
  assert.equal(await page.locator("#accountOverrides").evaluate(element => element.open), true, "save keeps run settings open for its success message");
  await page.locator("#closeAccountRunSettingsBtn").click();
  await page.locator("#accountSelect").selectOption("beta");
  await page.waitForFunction(() => document.querySelector("#accountSelect").value === "beta");
  await page.locator("#accountSelect").selectOption("alpha");
  await page.waitForFunction(() => document.querySelector("#accountSelect").value === "alpha");
  await page.locator("#editAccountRunSettingsBtn").click();
  assert.equal(await page.locator("#accountPromptInput").inputValue(), "Draft account prompt", "saved settings survive close and account switching");
  await page.locator("#closeAccountRunSettingsBtn").click();
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
  await page.locator("#logoutBtn").click();
  await page.locator("#accountDangerMessage").getByText("Signed out.", { exact: true }).waitFor();
  await page.locator("#deviceLoginBtn").waitFor();
  assert.equal(await page.locator("#loginProgress").isVisible(), false);
  // Cancellation never deletes; one confirmation sends exactly one scoped request.
  await page.locator("#removeAccountBtn").click();
  assert.equal(await page.locator("#removeAccountName").textContent(), "Work account");
  assert.equal(await page.locator("#cancelRemoveAccountBtn").evaluate(el => el === document.activeElement), true);
  await page.locator("#cancelRemoveAccountBtn").click();
  assert.equal((await requestJson(fixture.base, "/api/accounts")).accounts.length, 3);
  assert.equal(fixture.controls.deleteRequests.length, 0);
  // A real failure keeps the confirmation open with a usable retry.
  expectedHttpErrors.add(`${fixture.base}/api/accounts/${newId}`);
  expectedHttpErrors.add(`${fixture.base}/api/status`);
  fixture.controls.failDelete = true;
  await page.locator("#removeAccountBtn").click();
  await screenshot(page, `${label}-remove-account`);
  await page.locator("#confirmRemoveAccountBtn").click();
  await page.locator("#removeAccountMessage").getByText("Temporary removal failure. Try again.", { exact: true }).waitFor();
  assert.equal(await page.locator("#removeAccountDialog").evaluate(el => el.open), true);
  await page.waitForFunction(() => !document.querySelector("#confirmRemoveAccountBtn").disabled);
  assert.equal(fixture.controls.deleteRequests.length, 1);
  let releaseDelete;
  fixture.controls.deleteGate = new Promise(resolve => { releaseDelete = resolve; });
  fixture.controls.loseDeleteResponse = true;
  fixture.controls.failStatusAfterDelete = true;
  await page.locator("#confirmRemoveAccountBtn").click();
  await page.waitForFunction(() => document.querySelector("#confirmRemoveAccountBtn").disabled && document.querySelector("#confirmRemoveAccountBtn").textContent === "Removing…");
  await page.waitForFunction(() => document.querySelector("#accountSelect").disabled);
  assert.equal(await page.locator("#cancelRemoveAccountBtn").isDisabled(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#removeAccountDialog").evaluate(el => el.open), true);
  await page.locator("#confirmRemoveAccountBtn").evaluate(el => el.click());
  assert.equal(fixture.controls.deleteRequests.length, 2);
  releaseDelete();
  fixture.controls.deleteGate = null;
  await page.waitForFunction(() => document.querySelector("#accountSelect").options.length === 2 && !document.querySelector("#accountSelect").disabled);
  await page.waitForFunction(() => !document.querySelector("#removeAccountDialog").open && document.querySelector("#accountMessage").textContent.includes("Some details could not refresh"));
  assert.match(await page.locator("#accountMessage").textContent(), /^Removed Work account\./);
  assert.equal(await page.locator("#accountSelect").inputValue(), "alpha");
  assert.equal(fixture.controls.deleteRequests.length, 2, "no second DELETE after a lost acknowledgement or failed refresh");
  assert.ok(fixture.controls.deleteRequests.every(url => url === `/api/accounts/${newId}`));
  assert.equal((await requestJson(fixture.base, "/api/accounts")).accounts.length, 2);
  assert.equal(await page.locator("#accountSelect").evaluate(el => el === document.activeElement), true);
  fixture.controls.failStatusAfterDelete = false;
  fixture.controls.failNextStatus = false;
}

async function openSchedule(page, tab = "schedule") {
  await navigate(page, "schedule");
  if (!await page.locator("#scheduleDialog").evaluate(el => el.open)) await page.locator("#editScheduleBtn").click();
  await page.locator(`#${tab}-tab`).click();
}

async function saveSchedule(page) {
  await page.locator("#settingsForm button[type=submit]").click();
  await page.waitForFunction(() => !document.querySelector("#scheduleDialog").open && document.querySelector("#scheduleMessage").textContent === "Schedule saved.");
}

async function openAlerts(page) {
  await navigate(page, "alerts");
  if (!await page.locator("#alertsDialog").evaluate(el => el.open)) await page.locator("#editAlertsBtn").click();
}

async function saveAlerts(page) {
  await page.locator("#alertsForm button[type=submit]").click();
  await page.waitForFunction(() => !document.querySelector("#alertsDialog").open && document.querySelector("#alertsMessage").textContent === "Alerts saved.");
}

async function openAlertGroup(page, index) {
  const group = page.locator("#alertsEditor .telegram-alert-section").nth(index);
  if (!await group.evaluate(element => element.open)) await group.locator(":scope > summary").click();
  return group;
}

async function exerciseResetCreditOverflow(page, fixture) {
  fixture.controls.resetCreditCount = 17;
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector('[data-account-row="alpha"] .reset-credit-stack')?.dataset.creditCount === "17");
    const stack = page.locator('[data-account-row="alpha"] .reset-credit-stack');
    const seen = new Set();
    for (let pageIndex = 0; pageIndex < 17; pageIndex++) {
      const cards = stack.locator(".reset-credit-card:not([hidden])");
      assert.ok(await cards.count() <= 4, "a stack never exposes an unreadable number of documents");
      for (const index of await cards.evaluateAll(nodes => nodes.map(node => Number(node.dataset.creditIndex)))) seen.add(index);
      assert.equal(await cards.evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().width >= Math.min(159, node.parentElement.getBoundingClientRect().width))), true, "paging preserves readable card width");
      const next = stack.getByRole("button", { name: "Next reset credits" });
      if (await next.isDisabled()) break;
      await next.click();
    }
    assert.equal(seen.size, 17, "every reported expiry remains reachable");
    await stack.locator('[data-front="true"]').focus();
    await page.keyboard.press("End");
    assert.equal(await stack.locator('[data-front="true"]').getAttribute("data-credit-index"), "16");
    await page.locator("#refreshBtn").click();
    await page.waitForFunction(() => !document.querySelector("#refreshBtn").disabled);
    assert.equal(await stack.locator('[data-front="true"]').getAttribute("data-credit-index"), "16", "refresh retains the selected overflow card");
    await stack.locator('[data-front="true"]').focus();
    await page.keyboard.press("Home");
    assert.equal(await stack.locator('[data-front="true"]').getAttribute("data-credit-index"), "0");
  } finally {
    fixture.controls.resetCreditCount = null;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#fleetRows .strip-row").first().waitFor();
  }
}

async function exercise(browserType, fixture, viewport, label) {
  const executablePath = process.env[browserType.name() === "chromium" ? "CHROMIUM_EXECUTABLE_PATH" : "WEBKIT_EXECUTABLE_PATH"];
  const browser = await browserType.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const pageErrors = [];
    const settingsPatches = [];
    const contextOptions = { viewport: viewport.size, deviceScaleFactor: viewport.deviceScaleFactor || 1,
      isMobile: Boolean(viewport.isMobile), hasTouch: Boolean(viewport.hasTouch) };
    const page = await browser.newPage(contextOptions);
    page.on("request", request => {
      if (request.method() === "PATCH" && request.url().endsWith("/api/settings")) {
        try { settingsPatches.push(JSON.parse(request.postData() || "{}")); } catch {}
      }
    });
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
    await navigate(page, "fleet");
    // Each credit retains its own expiry and urgency rather than coloring the whole inventory.
    await page.waitForFunction(() => document.querySelector('[data-account-row="alpha"] .reset-credit-stack')?.dataset.creditState === "expiring");
    const alphaCredits = page.locator('[data-account-row="alpha"] .reset-credit-stack');
    assert.match(await alphaCredits.locator(".reset-credit-total").textContent(), /2 reset credits/);
    assert.equal(await alphaCredits.locator(".reset-credit-card").count(), 2);
    assert.equal(await alphaCredits.locator("time[datetime]").count(), 2);
    const urgentCredit = alphaCredits.locator('.reset-credit-card[data-credit-index="0"]');
    const laterCredit = alphaCredits.locator('.reset-credit-card[data-credit-index="1"]');
    assert.match(await urgentCredit.textContent(), /Expires within 2 days/);
    assert.equal(await urgentCredit.evaluate(element => getComputedStyle(element).animationName), "credit-expiry-attention");
    assert.equal(await urgentCredit.evaluate(element => getComputedStyle(element, "::before").animationName), "credit-shine");
    assert.equal(await laterCredit.getAttribute("data-credit-state"), "available");
    assert.equal(await laterCredit.evaluate(element => getComputedStyle(element).animationName), "none");
    assert.equal(await laterCredit.evaluate(element => getComputedStyle(element, "::before").animationName), "none");
    assert.notEqual(await urgentCredit.locator("time").getAttribute("datetime"), await laterCredit.locator("time").getAttribute("datetime"));
    assert.equal(await page.locator('[data-account-row="beta"] .reset-credit-card').getAttribute("data-credit-state"), "available");
    const creditCards = alphaCredits.locator(".reset-credit-card");
    assert.equal(await laterCredit.locator(".reset-credit-content").isVisible(), false, "rear documents expose only their right edge");
    const creditCapacity = Number(await alphaCredits.getAttribute("data-credit-capacity"));
    if (creditCapacity > 1) assert.equal(await alphaCredits.evaluate(stack => {
      const [first, second] = [...stack.querySelectorAll(".reset-credit-card")].map(card => card.getBoundingClientRect());
      return Math.abs(first.y - second.y) <= 3 && Math.abs(first.width - second.width) < 1 && second.x > first.x
        && !stack.querySelector(".reset-credit-deck button") && stack.querySelectorAll(".reset-credit-card > .reset-credit-number").length === 2;
    }), true, "overlapping documents include their own numbers without separate buttons");
    if (!viewport.hasTouch && creditCapacity > 1) {
      await laterCredit.locator(".reset-credit-number").hover();
      assert.equal(await laterCredit.locator(".reset-credit-content").isVisible(), true, "hover expands a rear document");
      await page.locator("#fleetTitle").hover();
      assert.equal(await urgentCredit.getAttribute("data-front"), "true", "leaving the stack restores the selected document");
    }
    if (creditCapacity === 1) await alphaCredits.getByRole("button", { name: "Next reset credits" }).click();
    else await laterCredit.locator(".reset-credit-number").click();
    await page.locator("#fleetTitle").click();
    assert.equal(await laterCredit.getAttribute("data-front"), "true", "click or tap keeps the chosen document forward");
    await creditCards.nth(1).focus();
    await page.keyboard.press("Home");
    assert.equal(await urgentCredit.getAttribute("data-front"), "true", "keyboard selection returns to the first document");
    assert.equal(await creditCards.nth(0).getAttribute("aria-pressed"), "true");
    if (viewport.size.width >= 1101) {
      const rowLayout = await alphaCredits.evaluate(stack => {
        const row = stack.closest(".strip-row");
        const quota = row.querySelector(".strip-cell").getBoundingClientRect();
        const credits = stack.getBoundingClientRect();
        const meta = row.querySelector(".strip-meta").getBoundingClientRect();
        return { height: row.getBoundingClientRect().height, creditsBesideQuota: credits.left >= quota.right - 1, metaBesideCredits: meta.left >= credits.right - 1 };
      });
      assert.ok(rowLayout.height <= 155, "reset documents must not inflate desktop account rows");
      assert.ok(rowLayout.creditsBesideQuota && rowLayout.metaBesideCredits, "desktop reset credits have a dedicated column beside quota");
    }
    await exerciseResetCreditOverflow(page, fixture);
    const sendAction = page.locator('.page-heading > a[href="#send"]');
    assert.equal(await sendAction.evaluate(node => getComputedStyle(node).whiteSpace), "nowrap", "the Send action stays on one line");
    if (!viewport.isMobile && !viewport.hasTouch) {
      const nav = page.locator(".mobile-dock");
      const navBox = await nav.boundingBox();
      const workspaceBox = await page.locator("#mainContent").boundingBox();
      assert.equal(await nav.evaluate(element => getComputedStyle(element).position), "relative", "desktop section navigation belongs in the header flow");
      assert.ok(navBox && workspaceBox && navBox.y + navBox.height <= workspaceBox.y, "desktop navigation sits above the workspace");
    }
    const overviewChart = page.locator("#overviewUsageChart");
    await page.waitForFunction(() => document.querySelectorAll("#overviewUsageChart .usage-point-label[data-account-id]").length >= 2);
    assert.equal(await overviewChart.locator('svg[aria-label*="6h"]').count(), 1, "overview chart uses a fixed six-hour range");
    assert.equal(await page.locator("#overviewUsageChartInspector").evaluate(element => element.classList.contains("sr-only") && getComputedStyle(element).clipPath === "inset(50%)"), true, "compact inspector stays available to assistive technology without a visible table");
    const overviewCursor = overviewChart.locator(".usage-hover-layer");
    await overviewCursor.focus();
    await page.keyboard.press("Home");
    const overviewFirst = await overviewChart.locator(".usage-point-label[data-account-id] .usage-point-value").evaluateAll(nodes => nodes.map(node => node.textContent).sort());
    await page.keyboard.press("End");
    const overviewLast = await overviewChart.locator(".usage-point-label[data-account-id] .usage-point-value").evaluateAll(nodes => nodes.map(node => node.textContent).sort());
    assert.notDeepEqual(overviewFirst, overviewLast, "overview point labels follow the keyboard cursor");
    const overviewLabelsOverlap = await overviewChart.locator(".usage-point-label[data-account-id]").evaluateAll(labels => {
      const boxes = labels.map(label => label.querySelector("rect")?.getBBox() || label.getBBox());
      return boxes.some((a, index) => boxes.slice(index + 1).some(b => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y));
    });
    assert.equal(overviewLabelsOverlap, false, "coincident overview labels remain separated");
    const accountRows = () => page.locator("#fleetRows [data-account-row]");
    assert.equal(await accountRows().count(), 2);
    await page.locator("#accountSearchInput").fill("Beta");
    await page.waitForFunction(() => document.querySelectorAll("#fleetRows [data-account-row]:not([hidden])").length === 1);
    assert.equal(await page.locator("#fleetRows [data-account-row]:not([hidden])").getAttribute("data-account-row"), "beta");
    await page.locator("#accountSearchInput").fill("");
    await page.locator("#accountSearchInput").fill("No matching account");
    await page.locator("#noAccountResults").waitFor({ state: "visible" });
    assert.equal(await page.locator("#fleetRows [data-account-row]:not([hidden])").count(), 0);
    await page.locator("#accountSearchInput").fill("");
    await page.locator("#noAccountResults").waitFor({ state: "hidden" });
    await page.locator("#accountFilterInput").selectOption("scheduled");
    await page.waitForFunction(() => document.querySelectorAll("#fleetRows [data-account-row]:not([hidden])").length === 2);
    await page.locator("#accountFilterInput").selectOption("all");
    await page.locator("#fleetRows [data-open-account='beta']").click();
    await page.waitForFunction(() => !document.querySelector("#account").hidden && document.querySelector("#accountSelect").value === "beta");
    await navigate(page, "fleet");
    await page.locator('.page-heading a[href="#send"]').click();
    await page.waitForFunction(() => !document.querySelector("#account").hidden && document.activeElement === document.querySelector("#manualPromptInput"));
    assert.equal(await page.locator("#manualPromptInput").isVisible(), true, "send deep link opens Accounts and focuses the prompt");
    await navigate(page, "usage");
    await page.getByRole("link", { name: "Skip to content", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => location.hash), "#usage", "skip link must preserve the current view");
    assert.equal(await page.locator("#mainContent").evaluate(element => document.activeElement === element), true);
    await page.goBack();
    await page.waitForFunction(() => location.hash === "#send" && !document.querySelector("#account").hidden && document.querySelector("#usage").hidden && document.querySelector("#pageTitle").textContent === "Accounts");
    await page.goBack();
    await page.waitForFunction(() => location.hash === "#fleet" && !document.querySelector("#fleet").hidden && document.querySelector("#usage").hidden && document.querySelector("#pageTitle").textContent === "Overview");
    await page.goForward();
    await page.waitForFunction(() => location.hash === "#send" && !document.querySelector("#account").hidden && document.querySelector("#pageTitle").textContent === "Accounts");
    await page.goForward();
    await page.waitForFunction(() => location.hash === "#usage" && !document.querySelector("#usage").hidden && document.querySelector("#fleet").hidden && document.querySelector("#pageTitle").textContent === "Usage");
    await navigate(page, "schedule");
    await page.waitForFunction(() => /Scheduled Codex window ping at \d{4}-\d{2}-\d{2} \d{2}:\d{2} Europe\/Lisbon/.test(document.querySelector("#schedulePrompt").textContent));
    assert.ok(!(await page.locator("#schedulePrompt").textContent()).includes("{{"));
    assert.equal(await page.locator("#schedulePromptHint").isVisible(), true);
    assert.ok((await page.locator("#promptInput").inputValue()).includes("{{local_time}}"));
    assert.ok(await page.locator('.mobile-dock a[data-section="alerts"]').count() >= 1, "alerts have their own dashboard navigation link");
    await page.locator("#schedule").scrollIntoViewIfNeeded();
    await screenshot(page, `${label}-rendered-message-preview`);

    // Theme switch persists across reload.
    assert.equal(await page.locator("#themeToggleBtn").evaluate(element => element.textContent.trim()), "", "theme toggle is icon-only");
    assert.equal(await page.locator("#themeToggleBtn svg:visible").count(), 1);
    assert.equal(await page.locator("#themeToggleBtn").getAttribute("aria-label"), "Switch to dark mode");
    assert.equal(await page.locator("#themeToggleBtn").getAttribute("title"), "Switch to dark mode");
    assert.equal(await page.locator("#themeToggleBtn").getAttribute("aria-pressed"), "false");
    await page.locator("#themeToggleBtn").click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    assert.equal(await page.locator("#themeToggleBtn").getAttribute("aria-label"), "Switch to light mode");
    assert.equal(await page.locator("#themeToggleBtn").getAttribute("title"), "Switch to light mode");
    assert.equal(await page.locator("#themeToggleBtn").getAttribute("aria-pressed"), "true");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    assert.equal(await page.locator("#themeToggleBtn").getAttribute("aria-label"), "Switch to light mode");
    await page.locator("#themeToggleBtn").click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");

    // Schedule editing has only Schedule and Run tabs; alerts use their own editor.
    assert.equal(await page.locator("#settingsForm").isVisible(), false);
    await openSchedule(page);
    await page.locator("#schedule-tab").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#run-tab").getAttribute("aria-selected"), "true");
    await page.keyboard.press("End");
    assert.equal(await page.locator("#run-tab").getAttribute("aria-selected"), "true");
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
    await page.locator("#schedule-tab").click();
    await screenshot(page, `${label}-schedule-editor`);
    await saveSchedule(page);
    const schedulePatch = settingsPatches.at(-1);
    assert.ok(schedulePatch && "scheduleTimes" in schedulePatch && "promptTemplate" in schedulePatch);
    assert.ok(!Object.keys(schedulePatch).some(key => key.startsWith("telegram")), "schedule saves must omit alert settings");
    assert.equal(await page.locator("#scheduleTimes").textContent(), "07:1519:45");
    assert.equal(await page.locator("#schedulePrompt").textContent(), "E2E saved prompt");
    assert.equal(await page.locator("#schedulePromptHint").isVisible(), false);
    await navigate(page, "alerts");
    assert.equal(await page.locator("#alertRulesSummary .alert-summary-row").count(), 5);
    await page.getByRole("button", { name: "Edit quota warnings", exact: true }).click();
    const quotaWarnings = page.locator("#alertsEditor .telegram-alert-section").first();
    assert.equal(await quotaWarnings.evaluate(element => element.open), true);
    assert.equal(await quotaWarnings.locator(":scope > summary").evaluate(element => document.activeElement === element), true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#alertsDialog").open);
    await page.waitForFunction(() => document.activeElement === document.querySelector('[data-edit-alert-section="0"]'));
    await openAlerts(page);
    await screenshot(page, `${label}-alerts-editor`);
    await page.locator("#closeAlertsBtn").click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#scheduleInput").value === "07:15, 19:45");
    assert.equal(await page.locator("#modelInput").inputValue(), "gpt-5.6-luna");
    assert.equal(await page.locator("#effortInput").inputValue(), "low");
    // Cancel discards the schedule draft; Escape retains it for reopening.
    await openSchedule(page, "run");
    await page.locator("#promptInput").fill("Discard this draft");
    await page.locator("#cancelScheduleBtn").click();
    await openSchedule(page, "run");
    assert.equal(await page.locator("#promptInput").inputValue(), "E2E saved prompt");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#scheduleDialog").open);
    assert.equal(await page.locator("#editScheduleBtn").evaluate(el => el === document.activeElement), true);

    // An invalid alert draft does not block a valid schedule save and remains isolated.
    await openAlerts(page);
    await openAlertGroup(page, 0);
    await page.locator("#telegramQuotaThresholdInput").fill("0");
    await page.locator("#closeAlertsBtn").click();
    await openSchedule(page, "run");
    await page.locator("#promptInput").fill("Schedule saved with an invalid alert draft");
    await saveSchedule(page);
    const isolatedSchedulePatch = settingsPatches.at(-1);
    assert.ok(isolatedSchedulePatch && "promptTemplate" in isolatedSchedulePatch);
    assert.ok(!Object.keys(isolatedSchedulePatch).some(key => key.startsWith("telegram")));
    await openAlerts(page);
    assert.equal(await page.locator("#telegramQuotaThresholdInput").inputValue(), "0");
    await page.locator("#cancelAlertsBtn").click();
    await openSchedule(page);
    assert.equal(await page.locator("#promptInput").inputValue(), "Schedule saved with an invalid alert draft");
    await page.locator("#cancelScheduleBtn").click();

    if (await page.locator("#schedulerBadge").textContent() === "Paused") await page.locator("#schedulerToggleBtn").click();
    await page.waitForFunction(() => document.querySelector("#schedulerBadge").textContent === "Enabled");
    await page.locator("#schedulerToggleBtn").click();
    await page.waitForFunction(() => document.querySelector("#schedulerBadge").textContent === "Paused");
    await page.locator("#schedulerToggleBtn").click();
    await page.waitForFunction(() => document.querySelector("#schedulerBadge").textContent === "Enabled");
    await navigate(page, "account");
    const selectBox = await page.locator("#accountSelect").boundingBox();
    assert.ok(selectBox.height >= 44 && selectBox.width >= 140, "account selector needs usable Safari dimensions");
    for (const theme of ["light", "dark"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#themeToggleBtn").click();
      await page.locator("#account").scrollIntoViewIfNeeded();
      if (process.env.E2E_OUTPUT_DIR) await page.locator("#account").screenshot({ path: path.join(process.env.E2E_OUTPUT_DIR, `${label}-${theme}-account.png`) });
      await navigate(page, "schedule");
      await page.locator("#schedule").scrollIntoViewIfNeeded();
      await screenshot(page, `${label}-${theme}-schedule-summary`);
      await navigate(page, "account");
    }

    // Account switching updates selection and account-specific model catalogue.
    await page.locator("#accountSelect").selectOption("beta");
    await page.waitForFunction(() => document.querySelector("#accountSelect").value === "beta");
    assert.equal(await page.locator("#accountConsoleTitle").textContent(), "Account details");
    assert.equal((await (await fetch(`${fixture.base}/api/status`)).json()).selectedAccountId, "beta");
    await page.locator("#accountSelect").selectOption("alpha");
    await page.waitForFunction(() => document.querySelector("#accountSelect").value === "alpha");

    // Chart ranges, legend keyboard activation and usage-history loading.
    await navigate(page, "usage");
    for (const range of ["6h", "24h", "7d", "30d"]) {
      await page.locator(`#usageHistoryRanges [data-range="${range}"]`).click();
      await page.waitForFunction(expected => document.querySelector(`#usageHistoryRanges [data-range="${expected}"]`).getAttribute("aria-pressed") === "true", range);
    }
    for (const chartId of ["usageHistoryFiveHourChart", "usageHistoryWeeklyChart"]) {
      await page.waitForFunction(id => document.querySelectorAll(`#${id} .usage-point-label[data-account-id]`).length >= 2, chartId);
      const values = await chartLabelValues(page, chartId);
      assert.equal(values.every(value => /^\d+%$/.test(value)), true, `${chartId} labels show numeric percentages`);
      assert.equal(await chartLabelsOverlap(page, chartId), false, `${chartId} labels do not overlap`);
    }
    const cursor = page.locator("#usageHistoryFiveHourChart .usage-hover-layer");
    await cursor.focus();
    await page.keyboard.press("Home");
    const firstTime = await page.locator("#usageHistoryFiveHourChartInspector strong").textContent();
    const historyLabelsAtStart = await chartLabelValues(page, "usageHistoryFiveHourChart");
    const historyInspectorAtStart = await chartInspectorValues(page, "usageHistoryFiveHourChart");
    assert.deepEqual(historyLabelsAtStart, historyInspectorAtStart, "chart point labels match the inspected readings");
    await page.keyboard.press("End");
    const lastTime = await page.locator("#usageHistoryFiveHourChartInspector strong").textContent();
    assert.notEqual(firstTime, lastTime, "keyboard cursor must inspect different readings");
    const historyLabelsAtEnd = await chartLabelValues(page, "usageHistoryFiveHourChart");
    const historyInspectorAtEnd = await chartInspectorValues(page, "usageHistoryFiveHourChart");
    assert.deepEqual(historyLabelsAtEnd, historyInspectorAtEnd, "chart point labels continue to match inspected readings");
    assert.notDeepEqual(historyLabelsAtStart, historyLabelsAtEnd, "chart point labels change with Home and End");
    const weeklyCursor = page.locator("#usageHistoryWeeklyChart .usage-hover-layer");
    await weeklyCursor.focus();
    await page.keyboard.press("Home");
    const weeklyLabelsAtStart = await chartLabelValues(page, "usageHistoryWeeklyChart");
    assert.deepEqual(weeklyLabelsAtStart, await chartInspectorValues(page, "usageHistoryWeeklyChart"));
    await page.keyboard.press("End");
    const weeklyLabelsAtEnd = await chartLabelValues(page, "usageHistoryWeeklyChart");
    assert.deepEqual(weeklyLabelsAtEnd, await chartInspectorValues(page, "usageHistoryWeeklyChart"));
    assert.notDeepEqual(weeklyLabelsAtStart, weeklyLabelsAtEnd, "weekly chart labels change with Home and End");
    const legendToggle = page.locator("#usageHistoryLegend button").first();
    if (await legendToggle.count()) {
      await legendToggle.focus();
      await page.keyboard.press("Enter");
      assert.equal(await legendToggle.getAttribute("aria-pressed"), "false");
      await page.keyboard.press("Space");
      assert.equal(await legendToggle.getAttribute("aria-pressed"), "true");
    }

    await navigate(page, "fleet");
    assert.equal(await overviewChart.locator('svg[aria-label*="6h"]').count(), 1, "overview range stays at six hours after full-history range changes");

    // Shared settings edits survive a refresh until explicitly saved.
    await openSchedule(page, "run");
    await page.locator("#promptInput").fill("Unsaved shared draft");
    await page.keyboard.press("Escape");
    await page.locator("#refreshBtn").click();
    await page.waitForFunction(() => !document.querySelector("#refreshBtn").disabled);
    await openSchedule(page, "run");
    assert.equal(await page.locator("#promptInput").inputValue(), "Unsaved shared draft");
    await saveSchedule(page);

    // Expiry reminders default to 48 hours, support editing/removal, and persist as hours.
    await openSchedule(page);
    await page.locator("#scheduleTimeInputs input").first().fill("");
    await page.locator("#run-tab").click();
    await page.locator("#promptInput").fill("Unsaved invalid schedule draft");
    await page.locator("#closeScheduleBtn").click();
    await openAlerts(page);
    await page.locator("#telegramResetExpiryInput").uncheck();
    await saveAlerts(page);
    const alertOnlyPatch = settingsPatches.at(-1);
    assert.ok(alertOnlyPatch && "telegramAlertResetExpiry" in alertOnlyPatch);
    assert.ok(!["scheduleTimes", "promptTemplate", "timezone", "workspaceDir"].some(key => key in alertOnlyPatch), "alert saves must omit schedule settings");
    assert.deepEqual((await requestJson(fixture.base, "/api/settings")).scheduleTimes, ["07:15", "19:45"]);
    await openSchedule(page);
    assert.equal(await page.locator("#scheduleTimeInputs input").first().inputValue(), "");
    assert.equal(await page.locator("#promptInput").inputValue(), "Unsaved invalid schedule draft");
    await page.locator("#cancelScheduleBtn").click();
    await openAlerts(page);
    const reminderInputs = () => page.locator("#telegramExpiryReminderRows input");
    assert.deepEqual(await reminderInputs().evaluateAll(inputs => inputs.map(input => input.value)), ["48"]);
    await page.locator("#addTelegramExpiryReminderBtn").click();
    await reminderInputs().nth(1).fill("24");
    await page.locator("#addTelegramExpiryReminderBtn").click();
    await reminderInputs().nth(2).fill("72");
    await page.locator("#telegramExpiryReminderRows button[aria-label='Remove expiry reminder 3']").click();
    assert.deepEqual(await reminderInputs().evaluateAll(inputs => inputs.map(input => input.value)), ["48", "24"]);
    await reminderInputs().nth(1).fill("0");
    await page.locator("#alertsForm button[type=submit]").click();
    await page.locator("#alertsForm").waitFor({ state: "visible" });
    assert.equal(await reminderInputs().nth(1).evaluate(input => input.validity.valid), false);
    await reminderInputs().nth(1).fill("24");
    await saveAlerts(page);
    assert.deepEqual((await requestJson(fixture.base, "/api/settings")).telegramResetReminderHours, [48, 24]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#accountSelect").options.length === 2);
    await openAlerts(page);
    assert.deepEqual(await reminderInputs().evaluateAll(inputs => inputs.map(input => input.value)), ["48", "24"]);
    await screenshot(page, `${label}-reset-reminders`);
    const alertGroups = () => page.locator("#alertsEditor details.telegram-alert-section");
    const thresholdInputs = () => page.locator("#telegramQuotaThresholdRows input");
    await openAlertGroup(page, 0);
    assert.deepEqual(await thresholdInputs().evaluateAll(inputs => inputs.map(input => input.value)), ["80", "95", "100"]);
    await page.locator("#addTelegramQuotaThresholdBtn").click();
    await thresholdInputs().nth(3).fill("90");
    await page.locator("#telegramQuotaThresholdRows button[aria-label='Remove threshold 2']").click();
    assert.deepEqual(await thresholdInputs().evaluateAll(inputs => inputs.map(input => input.value)), ["80", "100", "90"]);
    const thresholdDelays = page.locator("#telegramQuotaThresholdRulesRows input");
    await page.locator("[data-add-rule='quota-threshold']").click();
    await thresholdDelays.nth(1).fill("30");
    const resetGroup = alertGroups().nth(1);
    await openAlertGroup(page, 1);
    const resetNotices = page.locator("#telegramQuotaResetRulesRows input");
    await page.locator("#telegramQuotaResetRulesRows button[aria-label='Remove notification 1']").click();
    assert.equal(await resetNotices.count(), 0, "an empty event rule disables only that event");
    await page.locator("[data-add-reminder='5h']").click();
    const fiveHourReminder = page.locator("#telegramReminder5hRows input").first();
    await fiveHourReminder.fill("0");
    await resetGroup.locator(":scope > summary").click();
    await page.locator("#alertsForm button[type=submit]").click();
    assert.equal(await resetGroup.evaluate(element => element.open), true, "invalid controls reveal their collapsed settings group");
    assert.equal(await fiveHourReminder.evaluate(input => input.validity.valid), false);
    await fiveHourReminder.fill("2");
    await openAlertGroup(page, 2);
    await page.locator("#telegramResetExpiryInput").uncheck();
    await saveAlerts(page);
    const alertSavePatch = settingsPatches.at(-1);
    assert.ok(alertSavePatch && "telegramAlertRules" in alertSavePatch && "telegramQuotaWarningPercents" in alertSavePatch);
    assert.ok(!["scheduleTimes", "promptTemplate", "timezone", "workspaceDir", "model", "effort"].some(key => key in alertSavePatch), "alert saves must contain only alert fields");
    const alertSettings = await requestJson(fixture.base, "/api/settings");
    assert.deepEqual(alertSettings.telegramQuotaWarningPercents, [80, 90, 100]);
    assert.equal(alertSettings.telegramAlertRules["quota-threshold"].length, 2, "quota warnings support multiple notification times");
    assert.deepEqual(alertSettings.telegramAlertRules["quota-reset"], []);
    assert.deepEqual(alertSettings.telegramQuotaReminderHours["5h"], [2]);
    assert.equal(alertSettings.telegramAlertResetExpiry, false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#accountSelect").options.length === 2);
    await openAlerts(page);
    await openAlertGroup(page, 0);
    assert.deepEqual(await thresholdInputs().evaluateAll(inputs => inputs.map(input => input.value)), ["80", "90", "100"]);
    assert.deepEqual(await page.locator("#telegramQuotaThresholdRulesRows input").evaluateAll(inputs => inputs.map(input => input.value)), ["0", "30"]);
    await openAlertGroup(page, 1);
    assert.equal(await page.locator("#telegramQuotaResetRulesRows input").count(), 0);
    assert.deepEqual(await page.locator("#telegramReminder5hRows input").evaluateAll(inputs => inputs.map(input => input.value)), ["2"]);
    await openAlertGroup(page, 2);
    assert.equal(await page.locator("#telegramResetExpiryInput").isChecked(), false);
    await page.locator("#telegramQuotaThresholdInput").fill("81");
    await page.locator("#closeAlertsBtn").click();
    await page.locator("#refreshBtn").click();
    await page.waitForFunction(() => !document.querySelector("#refreshBtn").disabled);
    await openAlerts(page);
    await openAlertGroup(page, 0);
    assert.equal(await page.locator("#telegramQuotaThresholdInput").inputValue(), "81", "refresh preserves the alerts draft");
    await page.locator("#cancelAlertsBtn").click();
    await openAlerts(page);
    await openAlertGroup(page, 0);
    assert.deepEqual(await thresholdInputs().evaluateAll(inputs => inputs.map(input => input.value)), ["80", "90", "100"], "alert cancellation resets only its own draft");
    await page.locator("#closeAlertsBtn").click();

    await accountWorkflow(page, fixture, label, expectedHttpErrors);

    // Seeded failures and success must use distinct semantic classes/tones.
    const failedTurn = page.locator("[data-event-id='seed-failed']");
    const completedFailure = page.locator("[data-event-id='seed-completed-error']");
    const successTurn = page.locator("[data-event-id='seed-success']");
    const interruptedTurn = page.locator("[data-event-id='seed-interrupted']");
    await navigate(page, "activity");
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
      await navigate(page, "activity");
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
    await navigate(page, "activity");
    assert.equal(await page.locator("[data-event-id='seed-success']").count(), 0);
    await navigate(page, "account");
    await page.locator("#runNowBtn").click();
    await navigate(page, "activity");
    await page.locator(".activity-item").filter({ hasText: "Turn started" }).first().waitFor({ timeout: 10_000 });
    await page.locator(".activity-item.success").filter({ hasText: "e2e-turn-" }).first().waitFor({ timeout: 10_000 });
    await navigate(page, "account");

    // Real app-server notifications travel over the server's SSE connection.
    await navigate(page, "account");
    for (const [prompt, tone, title] of [["E2E_FAIL", "error", "Turn failed"], ["E2E_INTERRUPT", "warn", "Turn interrupted"]]) {
      await page.locator("#manualPromptInput").fill(prompt);
      await page.locator("#manualSendBtn").click();
      await page.locator("#manualMessage").getByText("Turn started. Follow its progress in Activity.", { exact: true }).waitFor();
      await navigate(page, "activity");
      await page.locator(`.activity-item.${tone}`).filter({ hasText: title }).filter({ hasText: "e2e-turn-" }).first().waitFor();
      await navigate(page, "account");
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
    await navigate(page, "schedule");
    await page.locator("#schedulerToggleBtn").click();
    await page.locator("#schedulerMessage").getByText("Server busy. Try again.", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector("#schedulerToggleBtn").disabled);

    // Both send buttons lock while one request is pending; selection stays scoped.
    let releaseSend;
    fixture.controls.sendGate = new Promise(resolve => { releaseSend = resolve; });
    await navigate(page, "account");
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
      for (const section of ["account", "schedule", "alerts", "usage", "activity", "fleet"]) {
        await navigate(page, section);
      }
      await navigate(page, "activity");
      await navigate(page, "fleet");
    }
    await navigate(page, "fleet");
    const rowOverlaps = await page.locator("#fleetRows .strip-row").evaluateAll(rows => rows.some(row => {
      const cell = row.querySelector(".strip-cell")?.getBoundingClientRect();
      const meta = row.querySelector(".strip-meta")?.getBoundingClientRect();
      return cell && meta && cell.left < meta.right && cell.right > meta.left + 1 && cell.top < meta.bottom && cell.bottom > meta.top + 1;
    }));
    assert.equal(rowOverlaps, false, "quota tracks and reset metadata must not overlap");
    const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(overflow.scroll <= overflow.client + 1, `horizontal overflow ${overflow.scroll - overflow.client}px`);
    await navigate(page, "fleet");
    assert.equal(await page.locator("#pageTitle").textContent(), "Overview");
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
