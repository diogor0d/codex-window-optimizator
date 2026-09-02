const $ = (selector) => document.querySelector(selector);

const state = {
  settings: null,
  activityIds: new Set(),
  activityEvents: [],
  showRawEvents: false,
  accounts: [],
  selectedAccountId: null,
  runs: [],
  refreshInFlight: false,
  lastQuotaRefreshAt: 0,
  fleetSignature: null
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function badge(element, text, tone) {
  element.textContent = text;
  element.className = `badge ${tone}`;
}

function preferredTheme() {
  const stored = localStorage.getItem("theme");
  if (stored === "dark" || stored === "light") {
    return stored;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
  const button = $("#themeToggleBtn");
  if (button) {
    const isDark = theme === "dark";
    button.textContent = isDark ? "Light mode" : "Dark mode";
    button.setAttribute("aria-pressed", String(isDark));
  }
}

function initTheme() {
  setTheme(preferredTheme());
}

function formatRun(run) {
  if (!run) {
    return "None";
  }
  const label = [run.status, run.scheduledTime || run.reason, run.turnId || ""].filter(Boolean).join(" | ");
  return `${label} (${new Date(run.ts).toLocaleString()})`;
}

function formatUnixSeconds(seconds) {
  if (!Number.isFinite(seconds)) {
    return "Unknown";
  }
  return new Date(seconds * 1000).toLocaleString();
}

function compactText(value, fallback = "None") {
  if (!value) {
    return fallback;
  }
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "Unknown";
  }
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

const NEAR_LIMIT_USED = 80;
const FLEET_TIMETABLE_MS = 24 * 60 * 60 * 1000;
const VISIBLE_STATE_REFRESH_MS = 60 * 1000;
const QUOTA_REFRESH_MS = 5 * 60 * 1000;
const QUOTA_REFRESH_STORAGE_KEY = "codex-window:last-quota-refresh";

function accountWindow(account) {
  const limits = account?.dashboard?.rateLimits;
  if (!limits) {
    return null;
  }
  const normalize = (entry) => {
    if (!entry) {
      return null;
    }
    const used = Number(entry.usedPercent);
    return {
      hasData: Number.isFinite(used),
      used: clampPercent(used),
      free: Number.isFinite(used) ? clampPercent(100 - used) : null,
      resetsAt: Number.isFinite(Number(entry.resetsAt)) ? Number(entry.resetsAt) : null,
      windowDurationMins: Number.isFinite(Number(entry.windowDurationMins)) ? Number(entry.windowDurationMins) : null
    };
  };
  const primary = normalize(limits.primary);
  if (!primary?.hasData) {
    return null;
  }
  return {
    primary,
    secondary: normalize(limits.secondary),
    planType: limits.planType ? String(limits.planType) : null,
    updatedAt: limits.updatedAt || null
  };
}

function isFreshWindow(win, now = Date.now()) {
  const resetMs = Number(win?.primary?.resetsAt) * 1000;
  return Number.isFinite(resetMs) && resetMs > now;
}

function fmtCountdown(msLeft) {
  if (!Number.isFinite(msLeft)) {
    return "";
  }
  if (msLeft <= 0) {
    return "stale";
  }
  const totalMinutes = Math.round(msLeft / 60000);
  if (totalMinutes < 1) {
    return "under a minute";
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 48) {
    const days = Math.floor(hours / 24);
    return `in ${days}d ${hours % 24}h`;
  }
  return hours ? `in ${hours}h ${String(minutes).padStart(2, "0")}m` : `in ${minutes}m`;
}

function fmtClockTime(ms) {
  if (!Number.isFinite(ms)) {
    return "--:--";
  }
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtWeeklyReset(ms) {
  if (!Number.isFinite(ms)) {
    return "reset unknown";
  }
  return new Date(ms).toLocaleString([], {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function shortId(value) {
  if (!value) {
    return "";
  }
  const text = String(value);
  return text.length > 10 ? text.slice(-8) : text;
}

function readableSource(value) {
  const text = String(value || "service");
  return text.replaceAll("_", " ");
}

function updateWindowSummary(dashboard = {}) {
  const limits = dashboard.rateLimits;
  const primary = limits?.primary;
  const usedValue = Number(primary?.usedPercent);
  const used = Number.isFinite(usedValue) ? `${usedValue}%` : "Unknown";
  const reset = Number.isFinite(primary?.resetsAt) ? formatUnixSeconds(primary.resetsAt) : "Unknown";
  const duration = Number.isFinite(primary?.windowDurationMins) ? `${primary.windowDurationMins} min` : "Unknown";
  const plan = limits?.planType ? `${limits.planType} / ${duration}` : duration;
  const lastTurn = dashboard.lastCompletedTurn;

  $("#windowUsage").textContent = used;
  $("#windowReset").textContent = reset;
  $("#windowPlan").textContent = plan;
  $("#lastPing").textContent = compactText(dashboard.lastUserMessage?.text);
  $("#lastReply").textContent = compactText(dashboard.lastAgentMessage?.text);
  $("#windowUsageLabel").textContent = Number.isFinite(usedValue) ? `${usedValue}% of current window used` : "Usage unknown";
  $("#windowResetHint").textContent = Number.isFinite(primary?.resetsAt) ? `Resets ${reset}` : "Reset unknown";
  $("#windowUsageBar").style.width = `${clampPercent(usedValue)}%`;

  if (lastTurn?.status === "completed" && !lastTurn.error) {
    badge($("#windowBadge"), `Last turn OK (${formatDuration(lastTurn.durationMs)})`, "ok");
  } else if (lastTurn?.error) {
    badge($("#windowBadge"), "Last turn failed", "bad");
  } else if (limits) {
    badge($("#windowBadge"), "Window tracked", "ok");
  } else {
    badge($("#windowBadge"), "No data yet", "neutral");
  }
}

function updateStatus(status) {
  state.accounts = status.accounts || [];
  state.selectedAccountId = status.selectedAccountId || status.selectedAccount?.id || null;
  renderAccounts();
  const selectedAccount = status.selectedAccount || {};
  $("#authState").textContent = status.auth.detail || (status.auth.loggedIn ? "Logged in" : "Not logged in");
  $("#appServerState").textContent = status.appServer.running ? "Running" : "Stopped";
  $("#threadState").textContent = selectedAccount.thread?.threadId || status.thread.threadId || "None";
  $("#localTime").textContent = status.scheduler.next.localNow;
  $("#lastRun").textContent = formatRun(status.latestRun);
  renderNextSend(status.scheduler.next.nextLocal, status.scheduler.enabled);

  badge($("#serviceBadge"), status.auth.loggedIn ? "Ready" : "Needs login", status.auth.loggedIn ? "ok" : "warn");
  badge($("#loginBadge"), status.auth.loggedIn ? "Logged in" : "Logged out", status.auth.loggedIn ? "ok" : "bad");
  badge($("#schedulerBadge"), status.scheduler.enabled ? "Enabled" : "Paused", status.scheduler.enabled ? "ok" : "warn");
  updateWindowSummary(status.dashboard || {});
  renderFleet();

  $("#pauseBtn").disabled = !status.scheduler.enabled;
  $("#resumeBtn").disabled = status.scheduler.enabled;
  renderDepartures();
}

function selectedAccountId() {
  return state.selectedAccountId || $("#accountSelect")?.value || null;
}

function renderAccounts() {
  const select = $("#accountSelect");
  const list = $("#accountList");
  if (!select || !list) {
    return;
  }
  const previous = select.value;
  select.innerHTML = "";
  for (const account of state.accounts) {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = account.label;
    option.selected = account.id === state.selectedAccountId;
    select.append(option);
  }
  if (!state.selectedAccountId && previous) {
    select.value = previous;
  }

  const selected = state.accounts.find((account) => account.id === state.selectedAccountId) || state.accounts[0];
  $("#accountLabelInput").value = selected?.label || "";
  $("#accountEnabledInput").checked = selected?.enabled !== false;
  fillAccountOverrides(selected);

  list.innerHTML = "";
  for (const account of state.accounts) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `account-card ${account.id === state.selectedAccountId ? "selected" : ""}`;
    const authTone = account.auth?.loggedIn ? "ok" : "bad";
    const enabledTone = account.enabled ? "ok" : "warn";
    card.innerHTML = `
      <span>
        <strong>${escapeHtml(account.label)}</strong>
        <small>${escapeHtml(account.thread?.threadId ? `thread ${shortId(account.thread.threadId)}` : "no thread yet")}</small>
      </span>
      <span class="account-card-badges">
        <span class="mini-badge ${authTone}">${account.auth?.loggedIn ? "logged in" : "logged out"}</span>
        <span class="mini-badge ${enabledTone}">${account.enabled ? "scheduled" : "paused"}</span>
      </span>
    `;
    card.addEventListener("click", () => selectAccount(account.id));
    list.append(card);
  }
}

async function refreshStatus() {
  const status = await api("/api/status");
  updateStatus(status);
}

let refreshFeedbackTimer = null;

async function refreshAllState({ interactive = true } = {}) {
  if (state.refreshInFlight) {
    return;
  }
  state.refreshInFlight = true;
  const button = $("#refreshBtn");
  if (refreshFeedbackTimer) {
    clearTimeout(refreshFeedbackTimer);
    refreshFeedbackTimer = null;
  }
  button.disabled = true;
  button.textContent = interactive ? "Refreshing..." : "Auto refreshing...";
  button.setAttribute("aria-busy", "true");

  let upstream = null;
  let upstreamError = null;
  try {
    upstream = await api("/api/refresh", { method: "POST" });
  } catch (error) {
    upstreamError = error;
  }
  if (!upstreamError && !upstream.failed) {
    state.lastQuotaRefreshAt = Date.now();
    localStorage.setItem(QUOTA_REFRESH_STORAGE_KEY, String(state.lastQuotaRefreshAt));
  }

  const accountId = selectedAccountId();
  const reloads = await Promise.allSettled(interactive
    ? [
        refreshStatus(),
        refreshSettings(),
        refreshActivity(),
        api(`/api/auth/device/current?accountId=${encodeURIComponent(accountId || "")}`).then(renderLoginOutput)
      ]
    : [refreshStatus(), refreshActivity()]);
  const reloadFailures = reloads.filter((result) => result.status === "rejected").length;

  if (interactive) {
    if (upstreamError) {
      button.textContent = "Refresh failed";
      button.title = upstreamError.message;
    } else {
      const partial = upstream.failed || upstream.skipped || reloadFailures;
      button.textContent = partial ? `Updated ${upstream.updated}/${upstream.attempted}` : "All updated";
      button.title = [
        `${upstream.updated} quota reading${upstream.updated === 1 ? "" : "s"} updated`,
        upstream.skipped ? `${upstream.skipped} signed out` : "",
        upstream.failed ? `${upstream.failed} quota refresh failed` : "",
        reloadFailures ? `${reloadFailures} view reload${reloadFailures === 1 ? "" : "s"} failed` : ""
      ].filter(Boolean).join("; ");
    }

    refreshFeedbackTimer = setTimeout(() => {
      if (!button.disabled) {
        button.textContent = "Refresh";
      }
    }, 3000);
  } else {
    button.textContent = "Refresh";
    button.title = upstreamError
      ? `Automatic refresh failed: ${upstreamError.message}`
      : "Quota and page state refresh automatically while this page is visible.";
  }
  state.refreshInFlight = false;
  button.disabled = false;
  button.removeAttribute("aria-busy");
}

async function refreshVisibleState() {
  if (document.visibilityState !== "visible") {
    return;
  }
  await Promise.allSettled([refreshStatus(), refreshActivity()]);
}

function refreshQuotaIfDue() {
  if (document.visibilityState !== "visible" || state.refreshInFlight) {
    return;
  }
  if (Date.now() - state.lastQuotaRefreshAt >= QUOTA_REFRESH_MS) {
    void refreshAllState({ interactive: false });
  }
}

function startAutoRefresh() {
  state.lastQuotaRefreshAt = Math.max(
    state.lastQuotaRefreshAt,
    Number(localStorage.getItem(QUOTA_REFRESH_STORAGE_KEY)) || 0
  );
  setInterval(() => void refreshVisibleState(), VISIBLE_STATE_REFRESH_MS);
  setInterval(refreshQuotaIfDue, VISIBLE_STATE_REFRESH_MS);
  window.addEventListener("storage", (event) => {
    if (event.key === QUOTA_REFRESH_STORAGE_KEY) {
      state.lastQuotaRefreshAt = Math.max(state.lastQuotaRefreshAt, Number(event.newValue) || 0);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshVisibleState();
      refreshQuotaIfDue();
    }
  });
  refreshQuotaIfDue();
}

async function selectAccount(accountId) {
  await api("/api/accounts/select", { method: "POST", body: JSON.stringify({ accountId }) });
  await refreshStatus();
  renderLoginOutput(await api(`/api/auth/device/current?accountId=${encodeURIComponent(accountId)}`));
}

async function patchSelectedAccount(patch) {
  const accountId = selectedAccountId();
  if (!accountId) {
    return;
  }
  await api(`/api/accounts/${encodeURIComponent(accountId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
  await refreshStatus();
}

function fillAccountOverrides(account) {
  const overrides = account?.settings || {};
  const effective = account?.effectiveSettings || {};
  $("#accountScheduleInput").value = (overrides.scheduleTimes || []).join(", ");
  $("#accountWorkspaceInput").value = overrides.workspaceDir || "";
  $("#accountModelInput").value = overrides.model || "";
  $("#accountPromptInput").value = overrides.promptTemplate || "";
  $("#accountScheduleInput").placeholder = (effective.scheduleTimes || []).join(", ") || "Inherited";
  $("#accountWorkspaceInput").placeholder = effective.workspaceDir || "Inherited";
  $("#accountModelInput").placeholder = effective.model || "CLI default";
  $("#accountPromptInput").placeholder = "Inherited global template";
}

function setAccountMessage(text) {
  const el = $("#accountMessage");
  if (el) {
    el.textContent = text;
  }
}

async function saveAccountOverrides() {
  const accountId = selectedAccountId();
  if (!accountId) {
    return;
  }
  const scheduleTimes = $("#accountScheduleInput").value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const settings = {
    scheduleTimes: scheduleTimes.length ? scheduleTimes : null,
    workspaceDir: $("#accountWorkspaceInput").value.trim() || null,
    model: $("#accountModelInput").value.trim() || null,
    promptTemplate: $("#accountPromptInput").value.trim() || null
  };
  setAccountMessage("Saving...");
  try {
    await patchSelectedAccount({ settings });
    setAccountMessage("Overrides saved.");
  } catch (error) {
    setAccountMessage(error.message);
  }
}

function fillSettings(settings) {
  state.settings = settings;
  $("#timezoneInput").value = settings.timezone || "";
  $("#scheduleInput").value = (settings.scheduleTimes || []).join(", ");
  $("#workspaceInput").value = settings.workspaceDir || "";
  $("#modelInput").value = settings.model || "";
  $("#effortInput").value = settings.effort || "";
  $("#approvalInput").value = settings.approvalPolicy || "";
  $("#summaryInput").value = settings.summary || "";
  $("#networkInput").checked = Boolean(settings.networkAccess);
  $("#skipActiveInput").checked = Boolean(settings.skipIfActive);
  $("#promptInput").value = settings.promptTemplate || "";
}

async function refreshSettings() {
  fillSettings(await api("/api/settings"));
}

function stringifyPayload(payload) {
  if (!payload || Object.keys(payload).length === 0) {
    return "";
  }
  return JSON.stringify(payload, null, 2);
}

function eventPriority(event) {
  if (event.severity === "error" || event.severity === "warn") {
    return true;
  }
  if (event.source !== "codex") {
    return true;
  }
  return new Set([
    "turn/started",
    "turn/completed",
    "turn/failed",
    "turn/cancelled",
    "item/completed",
    "account/rateLimits/updated",
    "thread/status/changed"
  ]).has(event.message);
}

function shouldShowEvent(event) {
  if (state.showRawEvents) {
    return true;
  }
  if (!eventPriority(event)) {
    return false;
  }
  if (event.message === "item/completed") {
    const itemType = event.payload?.item?.type;
    return itemType === "userMessage" || itemType === "agentMessage";
  }
  if (event.message === "thread/status/changed") {
    return event.payload?.status?.type !== "active" || event.severity !== "info";
  }
  return true;
}

function summarizeEvent(event) {
  const payload = event.payload || {};
  const baseTags = [
    readableSource(event.source),
    event.severity || "info"
  ];

  if (event.severity === "error") {
    return {
      kind: "error",
      title: event.message || "Error",
      body: compactText(payload.error || payload.message || stringifyPayload(payload), ""),
      tags: baseTags,
      payload
    };
  }

  if (event.message === "account/rateLimits/updated") {
    const limits = payload.rateLimits;
    const primary = limits?.primary;
    const used = Number.isFinite(primary?.usedPercent) ? `${primary.usedPercent}% used` : "Usage unknown";
    const reset = Number.isFinite(primary?.resetsAt) ? `resets ${formatUnixSeconds(primary.resetsAt)}` : "reset unknown";
    return {
      kind: "window",
      title: "Codex window updated",
      body: `${used}, ${reset}`,
      tags: [limits?.planType || "plan unknown", `${primary?.windowDurationMins || "?"} min window`],
      payload: {
        usedPercent: primary?.usedPercent,
        resetsAt: formatUnixSeconds(primary?.resetsAt),
        windowDurationMins: primary?.windowDurationMins,
        planType: limits?.planType,
        rateLimitReachedType: limits?.rateLimitReachedType
      }
    };
  }

  if (event.message === "item/completed") {
    const item = payload.item;
    if (item?.type === "userMessage") {
      const text = item.content?.find((part) => part?.type === "text")?.text || "";
      return {
        kind: "message",
        title: "Ping sent",
        body: compactText(text, ""),
        tags: ["user", `turn ${shortId(payload.turnId)}`].filter(Boolean),
        payload: {
          text,
          threadId: payload.threadId,
          turnId: payload.turnId
        }
      };
    }
    if (item?.type === "agentMessage") {
      return {
        kind: "message",
        title: "Codex replied",
        body: compactText(item.text, ""),
        tags: ["assistant", `turn ${shortId(payload.turnId)}`].filter(Boolean),
        payload: {
          text: item.text || "",
          threadId: payload.threadId,
          turnId: payload.turnId
        }
      };
    }
  }

  if (event.message === "turn/started") {
    return {
      kind: "turn",
      title: "Turn started",
      body: `Codex started processing turn ${shortId(payload.turn?.id)}.`,
      tags: ["active", `thread ${shortId(payload.threadId)}`].filter(Boolean),
      payload
    };
  }

  if (event.message === "turn/completed") {
    return {
      kind: "turn",
      title: "Turn completed",
      body: `${payload.turn?.status || "completed"} in ${formatDuration(payload.turn?.durationMs)}`,
      tags: [payload.turn?.error ? "error" : "ok", `turn ${shortId(payload.turn?.id)}`].filter(Boolean),
      payload: {
        status: payload.turn?.status,
        duration: formatDuration(payload.turn?.durationMs),
        error: payload.turn?.error,
        threadId: payload.threadId,
        turnId: payload.turn?.id
      }
    };
  }

  if (event.message === "Started Codex turn") {
    return {
      kind: "turn",
      title: "Scheduled run started",
      body: `Reason: ${payload.reason || "unknown"}`,
      tags: [`run ${shortId(payload.runId)}`, `turn ${shortId(payload.turnId)}`].filter(Boolean),
      payload
    };
  }

  if (event.message === "thread/status/changed") {
    return {
      kind: "system",
      title: "Thread status changed",
      body: payload.status?.type || "unknown",
      tags: [`thread ${shortId(payload.threadId)}`].filter(Boolean),
      payload
    };
  }

  if (event.message === "Settings updated") {
    return {
      kind: "settings",
      title: "Settings updated",
      body: "Scheduler configuration was saved.",
      tags: baseTags,
      payload
    };
  }

  if (event.source === "auth") {
    return {
      kind: "auth",
      title: event.message,
      body: payload.text ? compactText(payload.text, "") : "",
      tags: baseTags,
      payload
    };
  }

  return {
    kind: "system",
    title: event.message,
    body: "",
    tags: baseTags,
    payload
  };
}

function addActivity(event, prepend = true) {
  if (!event || state.activityIds.has(event.id)) {
    return;
  }
  state.activityEvents.push(event);
  state.activityEvents = state.activityEvents.slice(-1000);
  renderActivity();
}

function renderActivity() {
  state.activityIds.clear();
  const list = $("#activityList");
  list.innerHTML = "";
  const events = [...state.activityEvents].filter(shouldShowEvent).slice(-300).reverse();
  for (const event of events) {
    if (state.activityIds.has(event.id)) {
      continue;
    }
    state.activityIds.add(event.id);
    const summary = summarizeEvent(event);
    const accountTag = event.payload?.accountId
      ? event.payload.accountLabel || `account ${shortId(event.payload.accountId)}`
      : null;
    const item = document.createElement("li");
    item.className = `activity-item ${event.severity || "info"} ${summary.kind || "system"}`;
    const payload = stringifyPayload(summary.payload);
    const tags = [accountTag, ...(summary.tags || [])]
      .filter(Boolean)
      .slice(0, 5)
      .map((tag) => `<span class="activity-chip">${escapeHtml(tag)}</span>`)
      .join("");
    item.innerHTML = `
      <div class="timeline-dot" aria-hidden="true"></div>
      <div class="activity-content">
        <div class="activity-top">
          <div>
            <div class="activity-message">${escapeHtml(summary.title || "")}</div>
            ${summary.body ? `<p class="activity-body">${escapeHtml(summary.body)}</p>` : ""}
          </div>
          <time>${escapeHtml(new Date(event.ts).toLocaleTimeString())}</time>
        </div>
        ${tags ? `<div class="activity-tags">${tags}</div>` : ""}
        ${payload ? `<details class="activity-details"><summary>Details</summary><pre class="activity-payload">${escapeHtml(payload)}</pre></details>` : ""}
      </div>
    `;
    list.append(item);
  }
  if (events.length === 0) {
    const item = document.createElement("li");
    item.className = "activity-empty";
    item.textContent = state.showRawEvents ? "No activity yet." : "No high-signal activity yet. Enable Raw events to inspect the full stream.";
    list.append(item);
  }
  $("#activityHint").textContent = state.showRawEvents
    ? "Showing all raw app-server and service events."
    : "Showing turn lifecycle, completed messages, rate limits, settings, auth, and errors.";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function linkify(text) {
  const safe = escapeHtml(text);
  return safe.replace(/https?:\/\/[^\s]+/g, (url) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
}

function renderLoginOutput(session) {
  const box = $("#loginOutput");
  if (!session || session.status === "none") {
    box.textContent = "No login session yet.";
    return;
  }
  const lines = [
    `Session: ${session.id}`,
    `Status: ${session.status}`,
    ""
  ];
  for (const entry of session.output || []) {
    lines.push(`[${entry.stream}] ${entry.text}`);
  }
  box.innerHTML = linkify(lines.join("\n"));
  box.scrollTop = box.scrollHeight;
}

async function refreshActivity() {
  const data = await api("/api/activity?limit=200");
  state.activityEvents = data.events || [];
  state.runs = data.runs || [];
  state.activityIds.clear();
  renderActivity();
  renderDepartures();
}

function timezoneParts(timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function timezoneDateKey(timezone, date = new Date()) {
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
  } catch {
    return timezoneDateKey("Europe/Lisbon", date);
  }
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

let clockTimer = null;

function startClock() {
  const render = () => {
    const timezone = state.settings?.timezone || "Europe/Lisbon";
    let parts;
    try {
      parts = timezoneParts(timezone);
    } catch {
      parts = timezoneParts("Europe/Lisbon");
    }
    const digits = $("#headerClock");
    if (digits) {
      digits.textContent = `${parts.hour}:${parts.minute}:${parts.second}`;
    }
    const dateLine = $("#subtitle");
    if (dateLine) {
      dateLine.textContent = `${parts.weekday} ${parts.day} ${parts.month} · ${timezone.replaceAll("_", " ").replaceAll("/", " / ")}`.toUpperCase();
    }
  };
  render();
  if (!clockTimer) {
    clockTimer = setInterval(render, 1000);
  }
}

function renderNextSend(nextLocal, schedulerEnabled) {
  const strip = $("#nextRunFlap");
  if (!strip) {
    return;
  }
  let time = "--:--";
  let day = schedulerEnabled ? "" : "PAUSED";
  if (schedulerEnabled && nextLocal) {
    const match = /(\d{2}:\d{2})/.exec(nextLocal);
    if (match) {
      time = match[1];
    }
    day = nextLocal.startsWith("tomorrow") ? "TOMORROW" : "TODAY";
  }
  const signature = `${time}|${day}`;
  if (strip.dataset.signature === signature) {
    return;
  }
  const previous = strip.dataset.chars || "";
  strip.dataset.signature = signature;
  strip.dataset.chars = time;
  strip.innerHTML = "";
  [...time].forEach((char, index) => {
    const cell = document.createElement("span");
    cell.className = "flap-cell";
    const face = document.createElement("span");
    face.textContent = char;
    if (previous[index] && previous[index] !== char) {
      cell.classList.add("tick");
      face.style.animationDelay = `${index * 45}ms`;
    }
    cell.append(face);
    strip.append(cell);
    if (index === 1) {
      const colon = document.createElement("span");
      colon.className = "flap-colon";
      colon.textContent = ":";
      strip.append(colon);
    }
  });
  const dayTag = $("#nextRunDay");
  if (dayTag) {
    dayTag.textContent = day;
  }
  strip.setAttribute("aria-label", `Next send ${time}${day ? `, ${day.toLowerCase()}` : ""}`);
}

function boardCellFor(account, time, today, timeNow, timezone) {
  const runs = (state.runs || []).filter(
    (item) => item.accountId === account.id
      && item.scheduledTime === time
      && timezoneDateKey(timezone, new Date(item.ts)) === today
  );
  const run = runs[runs.length - 1];
  let cls = time <= timeNow ? "missed" : "pending";
  let label = time <= timeNow ? "No send recorded" : "Scheduled";
  if (run) {
    cls = "info";
    label = run.status;
    if (run.status === "completed") {
      cls = "ok";
      label = "Completed";
    } else if (run.status === "failed") {
      cls = "bad";
      label = "Failed";
    } else if (run.status === "skipped_active_turn") {
      cls = "warn";
      label = "Skipped, a turn was already active";
    } else if (["cancelled", "aborted", "interrupted"].includes(run.status)) {
      cls = "warn";
      label = run.status[0].toUpperCase() + run.status.slice(1);
    } else if (["starting", "started", "inProgress"].includes(run.status)) {
      cls = "active";
      label = "Running";
    }
  }
  return `<span class="board-cell ${cls}" title="${escapeHtml(time)} — ${escapeHtml(label)}">${boardGlyph(cls)}</span>`;
}

function boardGlyph(cls) {
  if (cls === "ok") return "✓";
  if (cls === "bad") return "✕";
  if (cls === "warn") return "⏸";
  if (cls === "active") return "●";
  if (cls === "missed") return "–";
  return "·";
}

function renderDepartures() {
  const host = $("#departuresBoard");
  if (!host) {
    return;
  }
  const timezone = state.settings?.timezone || "Europe/Lisbon";
  let parts;
  try {
    parts = timezoneParts(timezone);
  } catch {
    parts = timezoneParts("Europe/Lisbon");
  }
  const today = timezoneDateKey(timezone);
  const timeNow = `${parts.hour}:${parts.minute}`;
  const accounts = state.accounts;
  const times = [
    ...new Set(
      accounts
        .filter((account) => account.enabled)
        .flatMap((account) => account.effectiveSettings?.scheduleTimes || [])
    )
  ].sort();
  if (!accounts.length || !times.length) {
    host.innerHTML = '<p class="board-empty">No enabled accounts with schedule times. Enable one in Account console or Schedule.</p>';
    return;
  }
  const head = `<div class="board-row board-head"><span class="board-account">account</span>${times
    .map((time) => `<span class="board-time">${escapeHtml(time)}</span>`)
    .join("")}</div>`;
  const rows = accounts.map((account) => {
    const cells = times.map((time) => boardCellFor(account, time, today, timeNow, timezone)).join("");
    return `<div class="board-row"><span class="board-account" title="${escapeHtml(account.label)}">${escapeHtml(account.label)}</span>${cells}</div>`;
  });
  host.innerHTML = head + rows.join("");
}

function compareFleetAccounts(a, b, now = Date.now()) {
  const winA = accountWindow(a);
  const winB = accountWindow(b);
  const tier = (account, win) => {
    if (!account.auth?.loggedIn) {
      return 0;
    }
    if (!win) {
      return 1;
    }
    return isFreshWindow(win, now) ? 3 : 2;
  };
  const tierA = tier(a, winA);
  const tierB = tier(b, winB);
  if (tierA !== tierB) {
    return tierB - tierA;
  }
  if (tierA === 3 && winA.primary.free !== winB.primary.free) {
    return winB.primary.free - winA.primary.free;
  }
  return String(a.label).localeCompare(String(b.label));
}

function renderFleet() {
  const rowsHost = $("#fleetRows");
  const timetableHost = $("#fleetTimetable");
  if (!rowsHost || !timetableHost) {
    return;
  }
  const now = Date.now();
  const accounts = [...state.accounts].sort((a, b) => compareFleetAccounts(a, b, now));
  const accountReadings = accounts.map((account) => ({ account, win: accountWindow(account) }));
  const readings = accountReadings.filter(
    (entry) => entry.account.auth?.loggedIn && isFreshWindow(entry.win, now)
  );
  const staleReadings = accountReadings.filter(
    (entry) => entry.account.auth?.loggedIn && entry.win && !isFreshWindow(entry.win, now)
  );
  const nearLimit = readings.filter((entry) => entry.win.primary.used >= NEAR_LIMIT_USED);
  const updatedTimes = accountReadings
    .map((entry) => Date.parse(entry.win?.updatedAt || ""))
    .filter(Number.isFinite);
  const latestUpdatedAt = updatedTimes.length ? Math.max(...updatedTimes) : null;
  const fleetUpdated = $("#fleetUpdated");
  if (Number.isFinite(latestUpdatedAt)) {
    fleetUpdated.dataset.updatedAt = String(latestUpdatedAt);
    fleetUpdated.dateTime = new Date(latestUpdatedAt).toISOString();
    fleetUpdated.title = `Latest live quota reading: ${new Date(latestUpdatedAt).toLocaleString()}`;
  } else {
    delete fleetUpdated.dataset.updatedAt;
    fleetUpdated.removeAttribute("datetime");
    fleetUpdated.removeAttribute("title");
  }

  const fleetSignature = accountReadings.map(({ account, win }) => [
    account.id,
    win?.primary?.used ?? "",
    win?.primary?.resetsAt ?? "",
    win?.secondary?.used ?? "",
    win?.secondary?.resetsAt ?? ""
  ].join(":"))
    .sort()
    .join("|");
  if (state.fleetSignature !== null && state.fleetSignature !== fleetSignature) {
    const panel = $(".fleet-panel");
    panel.classList.remove("quota-updated");
    requestAnimationFrame(() => panel.classList.add("quota-updated"));
    setTimeout(() => panel.classList.remove("quota-updated"), 900);
  }
  state.fleetSignature = fleetSignature;

  $("#fleetMeanFree").textContent = readings.length
    ? `${Math.round(readings.reduce((sum, entry) => sum + entry.win.primary.free, 0) / readings.length)}%`
    : "—";
  const nearEl = $("#fleetNearLimit");
  nearEl.textContent = readings.length ? String(nearLimit.length) : "—";
  nearEl.classList.toggle("bad", nearLimit.length > 0);
  if (nearLimit.length) {
    nearEl.title = nearLimit.map((entry) => entry.account.label).join(", ");
  } else {
    nearEl.removeAttribute("title");
  }

  const fleetBadge = $("#fleetBadge");
  if (!accounts.length) {
    fleetBadge.textContent = "No accounts";
    fleetBadge.className = "badge neutral";
  } else if (!readings.length && !staleReadings.length) {
    fleetBadge.textContent = "No readings yet";
    fleetBadge.className = "badge neutral";
  } else {
    const issues = [];
    if (nearLimit.length) {
      issues.push(`${nearLimit.length} near limit`);
    }
    if (staleReadings.length) {
      issues.push(`${staleReadings.length} stale`);
    }
    fleetBadge.textContent = issues.join(" · ") || "All clear";
    fleetBadge.className = `badge ${nearLimit.length ? "bad" : staleReadings.length ? "warn" : "ok"}`;
  }

  rowsHost.innerHTML = !accounts.length
    ? '<p class="board-empty">No accounts configured yet. Add one in Account console.</p>'
    : accounts.map((account) => {
        const win = accountWindow(account);
        const loggedIn = Boolean(account.auth?.loggedIn);
        let rowClasses = "strip-row";
        let trackCell;
        let metaCell = "";
        const labelCell = `
          <span class="strip-label-stack">
            <span class="strip-label" title="${escapeHtml(account.label)}">${escapeHtml(account.label)}</span>
            ${win?.planType && win.planType !== "unknown" ? `<span class="mini-badge neutral strip-plan">${escapeHtml(win.planType)}</span>` : ""}
          </span>`;
        if (!loggedIn) {
          rowClasses += " muted";
          trackCell = '<span class="strip-note">logged out — re-login from Account console</span>';
        } else if (!win) {
          rowClasses += " muted";
          trackCell = '<span class="strip-note">no reading yet — waiting for a live quota refresh</span>';
        } else {
          const primary = win.primary;
          const fresh = isFreshWindow(win, now);
          if (fresh && primary.used >= NEAR_LIMIT_USED) {
            rowClasses += " near";
          }
          if (!fresh) {
            rowClasses += " stale";
          }
          if (!account.enabled) {
            rowClasses += " muted";
          }
          trackCell = `
            <div class="strip-cell">
              <div class="strip-track" role="img" aria-label="${escapeHtml(
                fresh
                  ? `${account.label}: ${primary.free}% available, ${primary.used}% used`
                  : `${account.label}: stale reading, last reported ${primary.free}% available`
              )}">
                <div class="strip-fill" style="width:${primary.used}%"></div>
              </div>
              ${win.secondary?.hasData ? `
              <div class="strip-week ${Number(win.secondary.resetsAt) * 1000 > now ? "" : "stale"}">
                <span class="week-tag">wk</span>
                <div class="week-track" role="img" aria-label="${escapeHtml(
                  Number(win.secondary.resetsAt) * 1000 > now
                    ? `${account.label} weekly window: ${win.secondary.free}% available`
                    : `${account.label} weekly window: stale reading, last reported ${win.secondary.free}% available`
                )}">
                  <div class="week-fill" style="width:${win.secondary.used}%"></div>
                </div>
                <span class="week-free" data-week-free="${win.secondary.free}">${win.secondary.free}% ${Number(win.secondary.resetsAt) * 1000 > now ? "free" : "last"}</span>
                <span class="week-reset">${
                  win.secondary.resetsAt
                    ? `<span data-week-resets="${win.secondary.resetsAt}" title="Weekly quota reset: ${escapeHtml(formatUnixSeconds(win.secondary.resetsAt))}"></span>`
                    : "reset unknown"
                }</span>
              </div>` : ""}
            </div>`;
          metaCell = `
            <div class="strip-meta">
              <span class="free-num">${primary.free}<small>${fresh ? "% free" : "% last reported"}</small></span>
              <span class="reset-line">${
                primary.resetsAt
                  ? `<span data-resets="${primary.resetsAt}" title="${
                      fresh ? "Window resets at this time" : "Reading expired; waiting for Codex to report the next window"
                    }"></span>`
                  : "reset unknown"
              }</span>
            </div>`;
        }
        return `<div class="${rowClasses}">${labelCell}${trackCell}${metaCell}</div>`;
      }).join("");

  const lanes = accounts.filter((account) => {
    const resetsAt = accountWindow(account)?.primary.resetsAt;
    const resetMs = Number(resetsAt) * 1000;
    return account.auth?.loggedIn && resetMs > now && resetMs <= now + FLEET_TIMETABLE_MS;
  });
  timetableHost.innerHTML = !lanes.length
    ? '<p class="tt-empty">No upcoming window resets tracked yet.</p>'
    : `
      <div class="tt-lane" aria-hidden="true">
        <span class="tt-name">next 24h</span>
        <div class="tt-scale">
          <b style="left:25%" data-tick="6"></b>
          <b style="left:50%" data-tick="12"></b>
          <b style="left:75%" data-tick="18"></b>
          <b style="left:calc(100% - 1px)" data-tick="24"></b>
        </div>
      </div>
      ${lanes.map((account) => {
        const resetsAt = accountWindow(account).primary.resetsAt;
        return `
        <div class="tt-lane">
          <span class="tt-name" title="${escapeHtml(account.label)}">${escapeHtml(account.label)}</span>
          <div class="tt-axis">
            <span class="tt-marker" data-resets="${resetsAt}" title="${escapeHtml(`${account.label} window reset`)}"></span>
            <span class="tt-time" data-resets="${resetsAt}"></span>
          </div>
        </div>`;
      }).join("")}`;
  tickFleet();
}

function tickFleet() {
  const now = Date.now();

  const fleetUpdated = $("#fleetUpdated");
  const updatedAt = Number(fleetUpdated?.dataset.updatedAt);
  if (Number.isFinite(updatedAt)) {
    const ageMs = Math.max(0, now - updatedAt);
    if (ageMs < 60 * 1000) {
      fleetUpdated.textContent = "Updated just now";
    } else if (ageMs < 60 * 60 * 1000) {
      fleetUpdated.textContent = `Updated ${Math.floor(ageMs / 60000)}m ago`;
    } else if (ageMs < 24 * 60 * 60 * 1000) {
      fleetUpdated.textContent = `Updated ${Math.floor(ageMs / 3600000)}h ago`;
    } else {
      fleetUpdated.textContent = `Updated ${Math.floor(ageMs / 86400000)}d ago`;
    }
  } else if (fleetUpdated) {
    fleetUpdated.textContent = "No live reading";
  }

  document.querySelectorAll("#fleetRows [data-resets]").forEach((el) => {
    const resetMs = Number(el.dataset.resets) * 1000;
    el.textContent = `${fmtClockTime(resetMs)} · ${fmtCountdown(resetMs - now)}`;
    el.title = resetMs > now
      ? "Window resets at this time"
      : "Reading expired; waiting for Codex to report the next window";
  });

  document.querySelectorAll("#fleetRows [data-week-resets]").forEach((el) => {
    const resetMs = Number(el.dataset.weekResets) * 1000;
    const stale = resetMs <= now;
    const row = el.closest(".strip-week");
    row?.classList.toggle("stale", stale);
    const free = row?.querySelector("[data-week-free]");
    if (free) {
      free.textContent = `${free.dataset.weekFree}% ${stale ? "last" : "free"}`;
    }
    el.textContent = `${fmtWeeklyReset(resetMs)} · ${fmtCountdown(resetMs - now)}`;
  });

  const nextResetsAt = state.accounts
    .filter((account) => account.enabled && account.auth?.loggedIn)
    .map((account) => accountWindow(account)?.primary.resetsAt)
    .filter((resetsAt) => Number.isFinite(resetsAt) && resetsAt * 1000 > now)
    .sort((a, b) => a - b)[0];
  if (Number.isFinite(nextResetsAt)) {
    $("#fleetNextReset").textContent = fmtClockTime(nextResetsAt * 1000);
    $("#fleetNextResetLabel").textContent = `next reset · ${fmtCountdown(nextResetsAt * 1000 - now)}`;
  } else {
    $("#fleetNextReset").textContent = "—";
    $("#fleetNextResetLabel").textContent = "next reset";
  }

  const spanMs = FLEET_TIMETABLE_MS;
  document.querySelectorAll("#fleetTimetable [data-resets]").forEach((el) => {
    const resetMs = Number(el.dataset.resets) * 1000;
    const msUntilReset = resetMs - now;
    const lane = el.closest(".tt-lane");
    const inRange = msUntilReset > 0 && msUntilReset <= spanMs;
    if (lane) {
      lane.hidden = !inRange;
    }
    if (!inRange) {
      return;
    }
    const pos = Math.min(99.5, (msUntilReset / spanMs) * 100);
    el.style.left = `${pos}%`;
    el.classList.toggle("flip", pos > 86);
    if (el.classList.contains("tt-time")) {
      el.textContent = fmtClockTime(resetMs);
    }
  });
  document.querySelectorAll("#fleetTimetable [data-tick]").forEach((el) => {
    el.setAttribute("data-time", fmtClockTime(now + Number(el.dataset.tick) * 3600 * 1000));
  });
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.addEventListener("activity", (message) => {
    const event = JSON.parse(message.data);
    addActivity(event, true);
    if (event.message === "account/rateLimits/updated") {
      void refreshStatus();
    }
  });
  events.addEventListener("login", async () => {
    renderLoginOutput(await api(`/api/auth/device/current?accountId=${encodeURIComponent(selectedAccountId() || "")}`));
    await refreshStatus();
  });
  events.addEventListener("run", async () => {
    await Promise.allSettled([refreshStatus(), refreshActivity()]);
  });
  events.onerror = () => {
    addActivity({
      id: `sse-${Date.now()}`,
      ts: new Date().toISOString(),
      source: "ui",
      severity: "warn",
      message: "Event stream disconnected; browser will retry.",
      payload: {}
    });
  };
}

async function saveSettings(event) {
  event.preventDefault();
  const scheduleTimes = $("#scheduleInput").value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const body = {
    timezone: $("#timezoneInput").value.trim(),
    scheduleTimes,
    workspaceDir: $("#workspaceInput").value.trim(),
    model: $("#modelInput").value.trim(),
    effort: $("#effortInput").value.trim(),
    approvalPolicy: $("#approvalInput").value.trim(),
    summary: $("#summaryInput").value.trim(),
    networkAccess: $("#networkInput").checked,
    skipIfActive: $("#skipActiveInput").checked,
    promptTemplate: $("#promptInput").value
  };
  $("#settingsMessage").textContent = "Saving...";
  try {
    fillSettings(await api("/api/settings", { method: "PATCH", body: JSON.stringify(body) }));
    $("#settingsMessage").textContent = "Saved.";
    await refreshStatus();
  } catch (error) {
    $("#settingsMessage").textContent = error.message;
  }
}

async function runNow(prompt = null) {
  const body = { accountId: selectedAccountId() };
  if (prompt) {
    body.prompt = prompt;
  }
  return api("/api/run-now", { method: "POST", body: JSON.stringify(body) });
}

function bindActions() {
  $("#refreshBtn").addEventListener("click", () => {
    void refreshAllState();
  });
  $("#runNowBtn").addEventListener("click", async () => {
    $("#runNowBtn").disabled = true;
    try {
      await runNow();
      await refreshStatus();
    } finally {
      $("#runNowBtn").disabled = false;
    }
  });
  $("#manualSendBtn").addEventListener("click", async () => {
    $("#manualMessage").textContent = "Sending...";
    try {
      await runNow($("#manualPromptInput").value.trim() || null);
      $("#manualMessage").textContent = "Sent.";
      await refreshStatus();
    } catch (error) {
      $("#manualMessage").textContent = error.message;
    }
  });
  $("#pauseBtn").addEventListener("click", async () => {
    await api("/api/scheduler/pause", { method: "POST", body: "{}" });
    await refreshStatus();
  });
  $("#resumeBtn").addEventListener("click", async () => {
    await api("/api/scheduler/resume", { method: "POST", body: "{}" });
    await refreshStatus();
  });
  $("#deviceLoginBtn").addEventListener("click", async () => {
    $("#deviceLoginBtn").disabled = true;
    try {
      renderLoginOutput(await api("/api/auth/device/start", {
        method: "POST",
        body: JSON.stringify({ accountId: selectedAccountId() })
      }));
    } catch (error) {
      $("#loginOutput").textContent = error.message;
    } finally {
      $("#deviceLoginBtn").disabled = false;
    }
  });
  $("#logoutBtn").addEventListener("click", async () => {
    $("#logoutBtn").disabled = true;
    try {
      await api("/api/auth/logout", {
        method: "POST",
        body: JSON.stringify({ accountId: selectedAccountId() })
      });
      await refreshStatus();
    } finally {
      $("#logoutBtn").disabled = false;
    }
  });
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#clearActivityBtn").addEventListener("click", () => {
    $("#activityList").innerHTML = "";
    state.activityIds.clear();
    state.activityEvents = [];
  });
  $("#rawEventsInput").addEventListener("change", (event) => {
    state.showRawEvents = event.target.checked;
    renderActivity();
  });
  const themeToggle = $("#themeToggleBtn");
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
  }
  $("#accountSelect").addEventListener("change", (event) => {
    void selectAccount(event.target.value);
  });
  $("#saveAccountBtn").addEventListener("click", async () => {
    await patchSelectedAccount({ label: $("#accountLabelInput").value.trim() });
  });
  $("#saveAccountOverridesBtn").addEventListener("click", () => {
    void saveAccountOverrides();
  });
  $("#removeAccountBtn").addEventListener("click", async () => {
    const accountId = selectedAccountId();
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) {
      return;
    }
    const confirmed = window.confirm(
      `Remove "${account.label}"? Its Codex credentials and thread data will be deleted from the server.`
    );
    if (!confirmed) {
      return;
    }
    $("#removeAccountBtn").disabled = true;
    setAccountMessage("Removing...");
    try {
      await api(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
      setAccountMessage("");
      await refreshStatus();
    } catch (error) {
      setAccountMessage(error.message);
    } finally {
      $("#removeAccountBtn").disabled = false;
    }
  });
  $("#accountEnabledInput").addEventListener("change", async (event) => {
    await patchSelectedAccount({ enabled: event.target.checked });
  });
  $("#addAccountBtn").addEventListener("click", async () => {
    const label = $("#newAccountLabelInput").value.trim() || `Account ${state.accounts.length + 1}`;
    const result = await api("/api/accounts", { method: "POST", body: JSON.stringify({ label }) });
    $("#newAccountLabelInput").value = "";
    state.accounts = result.accounts || [];
    state.selectedAccountId = result.selectedAccountId;
    renderAccounts();
    await refreshStatus();
  });
}

async function init() {
  initTheme();
  bindActions();
  startClock();
  connectEvents();
  await refreshSettings();
  await refreshStatus();
  await refreshActivity();
  renderLoginOutput(await api(`/api/auth/device/current?accountId=${encodeURIComponent(selectedAccountId() || "")}`));
  setInterval(tickFleet, 1000);
  startAutoRefresh();
}

init().catch((error) => {
  document.body.innerHTML = `<main class="panel"><h1>Startup failed</h1><pre>${escapeHtml(error.stack || error.message)}</pre></main>`;
});
