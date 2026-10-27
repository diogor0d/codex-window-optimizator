const $ = (selector) => document.querySelector(selector);

const state = {
  settings: null,
  settingsDirty: false,
  settingsRevision: 0,
  alertsDirty: false,
  alertsRevision: 0,
  accountDrafts: new Map(),
  resetCreditSelections: new Map(),
  resetCreditHovers: new Map(),
  accountBusy: false,
  removingAccountIds: new Set(),
  removalTarget: null,
  removalBusy: false,
  selectingAccountId: null,
  statusRequestId: 0,
  renderedAccountId: null,
  loginSession: null,
  sendBusy: false,
  schedulerBusy: false,
  schedulerEnabled: false,
  hiddenActivityIds: new Set(),
  modelCatalogs: new Map(),
  modelCatalogRequests: new Set(),
  activityIds: new Set(),
  activityEvents: [],
  showRawEvents: false,
  accounts: [],
  selectedAccountId: null,
  runs: [],
  refreshInFlight: false,
  fleetSignature: null,
  usageHistory: new Map(),
  usageHistoryErrors: new Map(),
  usageHistoryRequests: new Map(),
  usageHistoryControllers: new Map(),
  usageHistoryRefreshQueued: new Set(),
  usageHistoryGeneration: new Map(),
  usageHistoryRange: "24h",
  usageHistoryVisibleAccounts: null,
  usageHistoryCursorByChart: new Map()
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

function feedback(id, text, tone = "neutral") {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = text;
  element.dataset.tone = tone;
  if (id === "runMessage") element.hidden = !text;
}

async function buttonAction(button, messageId, action) {
  if (button.dataset.pending) return;
  button.dataset.pending = "true";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await action();
  } catch (error) {
    feedback(messageId, error.message, "error");
  } finally {
    delete button.dataset.pending;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    updateAccountControls();
  }
}

async function accountAction(button, messageId, action) {
  if (state.accountBusy) return;
  state.accountBusy = true;
  updateAccountControls();
  try { await buttonAction(button, messageId, action); }
  finally { state.accountBusy = false; updateAccountControls(); }
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0d1117" : "#f6f8fa");
  const button = $("#themeToggleBtn");
  if (button) {
    const isDark = theme === "dark";
    const label = isDark ? "Switch to light mode" : "Switch to dark mode";
    button.setAttribute("aria-label", label);
    button.title = label;
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
  const labels = { inProgress: "Running", completed: "Completed", failed: "Failed", skipped: "Skipped", skipped_active_turn: "Skipped · turn already running", interrupted: "Interrupted" };
  return `${labels[run.status] || run.status || "Unknown"} · ${new Date(run.ts).toLocaleString()}`;
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
const WEEKLY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const VISIBLE_STATE_REFRESH_MS = 60 * 1000;
const STATUS_SNAPSHOT_STORAGE_KEY = "codex-window:status-snapshot-v1";
const USAGE_HISTORY_SNAPSHOT_STORAGE_KEY = "codex-window:usage-history-snapshot-v1";
const USAGE_HISTORY_RANGES = {
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

function snapshotAuth(auth = {}) {
  const loggedIn = Boolean(auth.loggedIn);
  const authIssue = Boolean(auth.authIssue);
  return {
    loggedIn,
    credentialPresent: Boolean(auth.credentialPresent),
    authIssue,
    probeUnavailable: Boolean(auth.probeUnavailable),
    logoutConfirmationPending: Boolean(auth.logoutConfirmationPending),
    mode: auth.mode || "unknown",
    detail: auth.logoutConfirmationPending
      ? "Logged-out status pending confirmation"
      : loggedIn ? "Logged in (saved status)" : authIssue ? "Authentication issue (saved status)" : "Logged out (saved status)"
  };
}

function snapshotDashboard(dashboard = {}) {
  const turn = dashboard.lastCompletedTurn;
  const snapshotWindow = (window) => window ? {
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt ?? null,
    windowDurationMins: window.windowDurationMins ?? null,
    updatedAt: window.updatedAt || null
  } : null;
  const snapshotLimits = (limits) => limits ? {
    limitId: limits.limitId || null,
    limitName: limits.limitName || null,
    normalModelSlug: limits.normalModelSlug || null,
    primary: snapshotWindow(limits.primary),
    secondary: snapshotWindow(limits.secondary),
    rateLimitReachedType: limits.rateLimitReachedType || null,
    planType: limits.planType || null,
    updatedAt: limits.updatedAt || null
  } : null;
  const rateLimitsByLimitId = Object.fromEntries(Object.entries(dashboard.rateLimitsByLimitId || {})
    .map(([limitId, limits]) => [limitId, snapshotLimits(limits)])
    .filter(([, limits]) => limits));
  return {
    rateLimits: snapshotLimits(dashboard.rateLimits),
    rateLimitsByLimitId,
    ordinaryUsageAllowed: typeof dashboard.ordinaryUsageAllowed === "boolean"
      ? dashboard.ordinaryUsageAllowed
      : null,
    rateLimitResetCredits: Number.isSafeInteger(dashboard.rateLimitResetCredits?.availableCount)
      ? {
          availableCount: Math.max(0, dashboard.rateLimitResetCredits.availableCount),
          expiresAt: Array.isArray(dashboard.rateLimitResetCredits.expiresAt)
            ? dashboard.rateLimitResetCredits.expiresAt.map((value) => Number.isSafeInteger(value) ? value : value === null ? null : "unknown")
            : null,
          detailsComplete: dashboard.rateLimitResetCredits.detailsComplete === true,
          updatedAt: dashboard.rateLimitResetCredits.updatedAt || null
        }
      : null,
    lastUserMessage: null,
    lastAgentMessage: null,
    lastCompletedTurn: turn ? {
      ts: turn.ts || null,
      status: turn.status || null,
      durationMs: turn.durationMs || null,
      error: turn.error ? "Previous turn failed" : null
    } : null
  };
}

function statusSnapshot(status) {
  const accounts = (status.accounts || []).map((account) => ({
    id: account.id,
    label: account.label,
    enabled: account.enabled,
    isSelected: account.id === status.selectedAccountId,
    auth: snapshotAuth(account.auth),
    appServer: { running: Boolean(account.appServer?.running) },
    settings: {},
    effectiveSettings: { scheduleTimes: account.effectiveSettings?.scheduleTimes || [] },
    thread: { threadId: account.thread?.threadId ? "Saved session" : null },
    dashboard: snapshotDashboard(account.dashboard)
  }));
  const selectedAccount = accounts.find((account) => account.id === status.selectedAccountId) || accounts[0] || null;
  const latestRun = status.latestRun ? {
    ts: status.latestRun.ts,
    status: status.latestRun.status,
    scheduledTime: status.latestRun.scheduledTime,
    reason: status.latestRun.reason,
    turnId: status.latestRun.turnId ? "saved" : null
  } : null;
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    status: {
      ts: status.ts,
      selectedAccountId: status.selectedAccountId,
      selectedAccount,
      accounts,
      auth: selectedAccount?.auth || snapshotAuth(),
      appServer: selectedAccount?.appServer || { running: false },
      scheduler: status.scheduler,
      thread: selectedAccount?.thread || { threadId: null },
      latestRun,
      dashboard: selectedAccount?.dashboard || snapshotDashboard()
    }
  };
}

function saveStatusSnapshot(status) {
  try {
    localStorage.setItem(STATUS_SNAPSHOT_STORAGE_KEY, JSON.stringify(statusSnapshot(status)));
  } catch {
    // Live status remains available when storage is disabled or full.
  }
}

function setSnapshotMode(snapshot = null) {
  const notice = $("#snapshotNotice");
  if (!notice) {
    return;
  }
  notice.hidden = !snapshot;
  document.querySelectorAll(".account-selector-rail, .account-management, .settings-panel, .manual-panel, .alerts-panel")
    .forEach((element) => element.toggleAttribute("inert", Boolean(snapshot)));
  const runButton = $("#runNowBtn");
  if (runButton) {
    runButton.disabled = Boolean(snapshot);
  }
  if (snapshot) {
    const savedAt = new Date(snapshot.savedAt);
    $("#snapshotMessage").textContent = Number.isFinite(savedAt.getTime())
      ? `Saved fleet status from ${savedAt.toLocaleString()}; loading live data.`
      : "Showing saved fleet status while live data loads.";
  }
}

function hydrateStatusSnapshot() {
  try {
    const snapshot = JSON.parse(localStorage.getItem(STATUS_SNAPSHOT_STORAGE_KEY) || "null");
    if (snapshot?.version !== 1 || !snapshot.status?.accounts) {
      return false;
    }
    updateStatus(snapshot.status);
    setSnapshotMode(snapshot);
    return true;
  } catch {
    return false;
  }
}

function accountResetCredits(account) {
  const summary = account?.dashboard?.rateLimitResetCredits;
  return {
    resetCreditsAvailable: Number.isSafeInteger(summary?.availableCount)
      ? Math.max(0, summary.availableCount)
      : null,
    resetCreditExpirations: Array.isArray(summary?.expiresAt)
      ? summary.expiresAt
          .map((value) => Number.isSafeInteger(value) ? value : value === null ? null : "unknown")
          .sort((a, b) => Number.isSafeInteger(a) ? Number.isSafeInteger(b) ? a - b : -1 : Number.isSafeInteger(b) ? 1 : 0)
      : null,
    resetCreditDetailsComplete: summary?.detailsComplete === true,
    resetCreditsUpdatedAt: summary?.updatedAt || null
  };
}

function accountWindow(account) {
  const limits = account?.dashboard?.rateLimits || {};
  const normalize = (entry) => {
    if (!entry) {
      return null;
    }
    const used = Number(entry.usedPercent);
    return {
      hasData: Number.isFinite(used),
      used: clampPercent(used),
      free: Number.isFinite(used) ? clampPercent(100 - used) : null,
      resetsAt: entry.resetsAt != null && Number.isFinite(Number(entry.resetsAt)) ? Number(entry.resetsAt) : null,
      windowDurationMins: entry.windowDurationMins != null && Number.isFinite(Number(entry.windowDurationMins)) ? Number(entry.windowDurationMins) : null
    };
  };
  const normalizedPrimary = normalize(limits.primary);
  const normalizedSecondary = normalize(limits.secondary);
  const ordinaryWindows = [normalizedPrimary, normalizedSecondary].filter(Boolean);
  const weekly = ordinaryWindows.find((entry) => entry.windowDurationMins === 10080) || null;
  const primary = ordinaryWindows.find((entry) => entry.windowDurationMins === 300)
    || (!weekly ? normalizedPrimary || normalizedSecondary : null);
  const secondary = ordinaryWindows.find((entry) => entry.windowDurationMins === 10080) || null;
  const reserveSnapshot = Object.values(account?.dashboard?.rateLimitsByLimitId || {})
    .filter((snapshot) => snapshot?.limitName === "gpt-reserve")
    .sort((a, b) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0))[0];
  const reserveWindows = reserveSnapshot
    ? [reserveSnapshot.primary, reserveSnapshot.secondary].map(normalize).filter(Boolean)
    : [];
  const reserveWeekly = reserveWindows.find((entry) => entry.windowDurationMins === 10080) || null;
  const resetCredits = accountResetCredits(account);
  if (!primary?.hasData && !secondary?.hasData && !reserveWeekly?.hasData
    && !Number.isSafeInteger(resetCredits.resetCreditsAvailable)) {
    return null;
  }
  return {
    primary,
    secondary: secondary === primary ? null : secondary,
    rateLimitReachedType: limits.rateLimitReachedType || null,
    planType: limits.planType ? String(limits.planType) : null,
    updatedAt: [limits.updatedAt, reserveSnapshot?.updatedAt, resetCredits.resetCreditsUpdatedAt]
      .filter(Boolean)
      .sort()
      .at(-1) || null,
    ordinaryUsageAllowed: typeof account?.dashboard?.ordinaryUsageAllowed === "boolean"
      ? account.dashboard.ordinaryUsageAllowed
      : null,
    ...resetCredits,
    reserve: reserveSnapshot ? {
      weekly: reserveWeekly,
      model: reserveSnapshot.normalModelSlug || null,
      updatedAt: reserveSnapshot.updatedAt || null
    } : null
  };
}

function effectiveWindow(win, now = Date.now()) {
  const ordinary = win?.primary || win?.secondary;
  if (!ordinary) {
    return null;
  }
  if (win.ordinaryUsageAllowed === false) {
    return { ...ordinary, used: 100, free: 0 };
  }
  const weeklyExhausted = win.secondary?.hasData
    && Number(win.secondary.resetsAt) * 1000 > now
    && win.secondary.free === 0;
  if (weeklyExhausted) {
    return { ...win.secondary, used: 100, free: 0 };
  }
  if (win.rateLimitReachedType && ordinary.used < 100) {
    return { ...ordinary, used: 100, free: 0 };
  }
  return ordinary;
}

function reserveState(win, now = Date.now()) {
  const weekly = win?.reserve?.weekly;
  if (!weekly?.hasData) {
    return null;
  }
  const resetMs = Number(weekly.resetsAt) * 1000;
  if (weekly.resetsAt != null && Number.isFinite(resetMs) && resetMs <= now) {
    return "stale";
  }
  if (weekly.free === 0) {
    return "exhausted";
  }
  if (win.ordinaryUsageAllowed === false) {
    return "active";
  }
  if (win.ordinaryUsageAllowed === true) {
    return "standby";
  }
  return "available";
}

function resetCreditPresentation(credits, now = Date.now()) {
  const count = Number.isSafeInteger(credits?.resetCreditsAvailable) && credits.resetCreditsAvailable >= 0
    ? credits.resetCreditsAvailable : null;
  const expirations = (Array.isArray(credits?.resetCreditExpirations) ? credits.resetCreditExpirations : [])
    .slice(0, count ?? 0).filter(Number.isSafeInteger);
  const future = expirations.filter(value => value * 1000 > now);
  const expiringCount = future.filter(value => value * 1000 - now <= 2 * 24 * 60 * 60 * 1000).length;
  const expiredCount = expirations.length - future.length;
  return {
    count,
    state: count === null ? "unknown" : count === 0 ? "empty" : expiringCount ? "expiring" : expiredCount ? "reported" : "available",
    expiringCount,
    expiredCount,
    nextExpiry: future.length ? Math.min(...future) : null
  };
}

function resetCreditItems(credits, now = Date.now()) {
  const count = resetCreditPresentation(credits, now).count;
  const expirations = Array.isArray(credits?.resetCreditExpirations) ? credits.resetCreditExpirations : [];
  return Array.from({ length: count || 0 }, (_, index) => {
    const value = expirations[index];
    const expiresAt = Number.isSafeInteger(value) ? value : value === null ? null : "unknown";
    return {
      index,
      expiresAt,
      state: Number.isSafeInteger(expiresAt)
        ? expiresAt * 1000 <= now ? "reported" : expiresAt * 1000 - now <= 2 * 24 * 60 * 60 * 1000 ? "expiring" : "available"
        : "available"
    };
  });
}

function resetCreditStack(credits, accountId, now = Date.now(), context = "overview") {
  const view = resetCreditPresentation(credits, now);
  const items = resetCreditItems(credits, now);
  const key = `${context}:${accountId}`;
  const selected = Math.max(0, Math.min(items.length - 1, state.resetCreditHovers.get(key) ?? state.resetCreditSelections.get(key) ?? 0));
  const initialStart = Math.floor(selected / 2) * 2;
  const initialEnd = Math.min(items.length, initialStart + 2);
  const idPrefix = `${context}-reset-credit-${accountId}`;
  const label = view.count === null ? "Reset credits not reported" : view.count === 0 ? "No reset credits"
    : `${view.count} ${view.expiredCount ? "reported " : ""}reset credit${view.count === 1 ? "" : "s"}`;
  const readAt = credits.resetCreditsUpdatedAt ? `Count read ${new Date(credits.resetCreditsUpdatedAt).toLocaleString()}.` : "Read time unavailable.";
  const cards = items.map(item => {
    const knownExpiry = Number.isSafeInteger(item.expiresAt);
    const expiryLabel = knownExpiry ? new Date(item.expiresAt * 1000).toLocaleString([], {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
    }) : item.expiresAt === null ? "No expiry" : "Expiry not reported";
    const note = item.state === "expiring" ? "Expires within 2 days" : item.state === "reported" ? "Expiry passed · refresh account state" : "";
    return `<div class="reset-credit-card" role="button" id="${escapeHtml(`${idPrefix}-card-${item.index}`)}" aria-label="${escapeHtml(`Reset credit ${item.index + 1}: ${expiryLabel}${note ? `. ${note}` : ""}`)}" aria-pressed="${item.index === selected}" tabindex="${item.index === selected ? 0 : -1}" ${item.index < initialStart || item.index >= initialEnd ? "hidden" : ""} data-front="${item.index === selected}" data-credit-side="${item.index < selected ? "before" : "after"}" data-credit-first="${item.index === initialStart}" data-credit-last="${item.index === initialEnd - 1}" data-credit-state="${item.state}" data-credit-index="${item.index}" style="--credit-before:${item.index - initialStart};--credit-after:${initialEnd - 1 - item.index}" title="${escapeHtml(`Reset credit ${item.index + 1}: ${expiryLabel}. ${readAt}`)}">
      <span class="reset-credit-content" aria-hidden="${item.index !== selected}">
      <span class="reset-credit-heading"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M6 9a4 4 0 1 1 1 4M6 5v4h4"/></svg><span class="reset-credit-count">Reset credit ${item.index + 1}</span></span>
      <span class="reset-credit-dates">${knownExpiry ? `Expires <time datetime="${new Date(item.expiresAt * 1000).toISOString()}">${escapeHtml(expiryLabel)}</time>` : expiryLabel}</span>
      ${note ? `<span class="reset-credit-urgency">${escapeHtml(note)}</span>` : ""}
      </span><span class="reset-credit-number" aria-hidden="true">${item.index + 1}</span>
    </div>`;
  }).join("");
  return `<div class="reset-credit-stack" data-credit-account="${escapeHtml(accountId || "")}" data-credit-context="${context}" data-credit-count="${items.length}" data-credit-state="${view.state}" data-credit-signature="${escapeHtml(JSON.stringify([view, items]))}">
    <span class="reset-credit-total">${escapeHtml(label)}</span>
    ${cards ? `<div class="reset-credit-deck" role="group" aria-label="Reset credit documents">${cards}</div>` : ""}
    ${items.length > 1 ? `<div class="reset-credit-pagination" ${items.length <= 2 ? "hidden" : ""}><span class="reset-credit-page-label" role="status">${initialStart + 1}–${initialEnd} of ${items.length}</span><div><button type="button" id="${escapeHtml(`${idPrefix}-previous`)}" data-credit-page="previous" aria-label="Previous reset credits" ${initialStart === 0 ? "disabled" : ""}>←</button><button type="button" id="${escapeHtml(`${idPrefix}-next`)}" data-credit-page="next" aria-label="Next reset credits" ${initialEnd === items.length ? "disabled" : ""}>→</button></div></div>` : ""}
  </div>`;
}

function resetCreditExpiry(win) {
  if (!Number.isSafeInteger(win?.resetCreditsAvailable)) {
    return { label: "Not reported", title: "Expiration details were not reported" };
  }
  if (win.resetCreditsAvailable === 0) {
    return { label: "None", title: "No usage resets are currently available" };
  }
  if (Array.isArray(win.resetCreditExpirations)) {
    const labels = win.resetCreditExpirations.map((expiresAt) =>
      Number.isSafeInteger(expiresAt) ? formatUnixSeconds(expiresAt) : expiresAt === null ? "No expiration" : "Expiration not reported");
    const missing = Math.max(0, win.resetCreditsAvailable - win.resetCreditExpirations.length);
    if (missing) {
      labels.push(`${missing} expiration${missing === 1 ? "" : "s"} not reported`);
    }
    if (labels.length) {
      const label = labels.join("; ");
      return { label, title: `Usage reset expirations: ${label}` };
    }
    if (win.resetCreditDetailsComplete) {
      return { label: "No expiration", title: "Available usage resets have no reported expiration" };
    }
  }
  return { label: "Not reported", title: "Expiration details were not returned by Codex" };
}

function isFreshWindow(win, now = Date.now()) {
  const resetMs = Number(effectiveWindow(win, now)?.resetsAt) * 1000;
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
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtWeeklyReset(ms) {
  if (!Number.isFinite(ms)) {
    return "reset unknown";
  }
  return new Date(ms).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function usageFree(sample, key) {
  if (key === "fiveHourUsed" && sample?.weeklyUsed >= 100) {
    return 0;
  }
  return Number.isFinite(sample?.[key]) ? clampPercent(100 - sample[key]) : null;
}

function formatPollingInterval(ms) {
  if (ms < 60 * 1000) {
    return "under 1 min";
  }
  const minutes = Math.round(ms / 60000);
  return `${minutes} min`;
}

const USAGE_ACCOUNT_COLORS = ["#e07a2f", "#27896d", "#5879d6", "#9a62c7", "#c84f67", "#8a751f", "#1685a5", "#b34e9b"];
const USAGE_ACCOUNT_DASHES = ["", "9 4", "2 3"];
const USAGE_CHART_LAYOUT = { height: 214, left: 43, right: 12, top: 13, bottom: 178 };
const usageChartModels = new WeakMap();
const usageChartResizeObservers = new WeakMap();
const usageChartWidths = new WeakMap();

function usageObservationAt(data, key) {
  if (key !== "fiveHourUsed") {
    return data.observedAt?.[key];
  }
  return [data.observedAt?.fiveHourUsed, data.observedAt?.weeklyUsed]
    .filter((value) => Number.isFinite(Date.parse(value || "")))
    .sort()
    .at(-1);
}

function buildUsageChartModel(histories, key, startMs, endMs) {
  const series = histories.map(({ account, index, data }) => {
    const samples = [data.baseline, ...(data.samples || [])].filter((sample) => sample && Number.isFinite(Date.parse(sample.ts)))
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const observedAt = usageObservationAt(data, key);
    const observedMs = Date.parse(observedAt || "");
    const observations = samples.filter((sample) => Date.parse(sample.ts) <= observedMs);
    const validSamples = observations.filter((sample) => Number.isFinite(usageFree(sample, key)));
    return { account, index, data, samples, observations, validSamples, observedAt, observedMs };
  });
  const timestampSet = new Set(series.flatMap((item) => item.observations.map((sample) => Date.parse(sample.ts))
    .filter((time) => time >= startMs && time <= endMs)));
  for (const item of series) {
    const beforeRange = item.observations.filter((sample) => Date.parse(sample.ts) < startMs).at(-1);
    if (beforeRange && Number.isFinite(usageFree(beforeRange, key)) && item.observedMs >= startMs) timestampSet.add(startMs);
    if (Number.isFinite(item.observedMs) && item.observedMs >= startMs && item.observedMs <= endMs
      && item.observations.some((sample) => Date.parse(sample.ts) <= item.observedMs)) {
      timestampSet.add(item.observedMs);
    }
  }
  const timestamps = [...timestampSet].sort((a, b) => a - b);
  return { key, startMs, endMs, series, timestamps };
}

function usageChartValueAt(series, key, timeMs) {
  const { observations, observedMs, data } = series;
  if (!Number.isFinite(observedMs)) return { value: null, status: "unavailable", sample: null };
  let low = 0;
  let high = observations.length - 1;
  let selected = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Date.parse(observations[middle].ts) <= timeMs) {
      selected = observations[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  if (!selected) return { value: null, status: "unavailable", sample: null };
  const value = usageFree(selected, key);
  return Number.isFinite(value)
    ? { value, status: data.savedSnapshot ? "cached" : timeMs > observedMs ? "last-known" : "available", sample: selected }
    : { value: null, status: "unavailable", sample: selected };
}

function usageChartTicks(startMs, endMs, width, rangeMs) {
  const { left, right } = USAGE_CHART_LAYOUT;
  const longRange = rangeMs >= USAGE_HISTORY_RANGES["24h"];
  const count = Math.max(2, Math.min(5, Math.floor((width - left - right) / (longRange ? 110 : 84)) + 1));
  return Array.from({ length: count }, (_, index) => {
    const time = startMs + ((endMs - startMs) * index) / (count - 1);
    const date = new Date(time);
    return {
      time,
      dateLabel: date.toLocaleDateString([], { month: "short", day: "numeric" }),
      clockLabel: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      includeDate: longRange
    };
  });
}

function nearestUsageTimestamp(timestamps, targetMs) {
  if (!timestamps.length) return -1;
  let low = 0;
  let high = timestamps.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (timestamps[mid] < targetMs) low = mid + 1;
    else high = mid;
  }
  if (low > 0 && targetMs - timestamps[low - 1] <= timestamps[low] - targetMs) return low - 1;
  return low;
}

function nextUsageCursorIndex(current, key, length) {
  if (!length) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowLeft") return Math.max(0, current - 1);
  if (key === "ArrowRight") return Math.min(length - 1, current + 1);
  return null;
}

function reconcileUsageCursorIndex(previousTimestamps, currentIndex, timestamps) {
  if (!timestamps.length) return -1;
  if (!previousTimestamps?.length || currentIndex === undefined || currentIndex >= previousTimestamps.length - 1) {
    return timestamps.length - 1;
  }
  return nearestUsageTimestamp(timestamps, previousTimestamps[currentIndex]);
}

function usageInsightStats(series, key, startMs, endMs) {
  return series.map((item) => {
    const inRange = item.observations.filter((sample) => Date.parse(sample.ts) >= startMs
      && Date.parse(sample.ts) <= Math.min(endMs, item.observedMs));
    const baseline = item.observations.filter((sample) => Date.parse(sample.ts) < startMs).at(-1);
    const samples = baseline && item.observedMs >= startMs ? [baseline, ...inRange] : inRange;
    const points = samples.filter((sample) => Number.isFinite(usageFree(sample, key)))
      .map((sample) => ({ sample, remaining: usageFree(sample, key) }));
    if (!points.length) return { account: item.account, summary: "No observations" };
    const first = points[0];
    const last = points.at(-1);
    const minimum = Math.min(...points.map((point) => point.remaining));
    const change = last.remaining - first.remaining;
    let consumptionPoints = 0;
    let fullResets = 0;
    let partialRefills = 0;
    let previousUsed = null;
    for (const sample of samples) {
      const remaining = usageFree(sample, key);
      if (!Number.isFinite(remaining)) {
        previousUsed = null;
        continue;
      }
      const currentUsed = 100 - remaining;
      if (previousUsed === null) {
        previousUsed = currentUsed;
        continue;
      }
      if (currentUsed > previousUsed) consumptionPoints += currentUsed - previousUsed;
      else if (currentUsed < previousUsed) {
        if (remaining === 100 && previousUsed > 0) fullResets += 1;
        else partialRefills += 1;
      }
      previousUsed = currentUsed;
    }
    const sign = change > 0 ? "+" : "";
    const replenishments = fullResets + partialRefills;
    return {
      account: item.account,
      summary: `${last.remaining}% latest · low ${minimum}% · ${sign}${change} pts net · ${consumptionPoints} pp observed use · ${replenishments} replenishment${replenishments === 1 ? "" : "s"}`,
      consumptionPoints,
      fullReplenishments: fullResets,
      partialReplenishments: partialRefills
    };
  });
}

function positionUsageLabels(points, { left, right, top, bottom }) {
  const labelWidth = 46;
  const labelHeight = 18;
  const gap = 3;
  const capacity = Math.max(1, Math.floor((bottom - top + gap) / (labelHeight + gap)));
  const ordered = [...points].sort((a, b) => a.y - b.y);
  const result = [];
  for (let offset = 0; offset < ordered.length; offset += capacity) {
    const column = ordered.slice(offset, offset + capacity);
    let nextTop = top;
    const positioned = column.map(point => {
      const labelY = Math.max(nextTop, Math.min(bottom - labelHeight, point.y - labelHeight / 2));
      nextTop = labelY + labelHeight + gap;
      const preferredX = point.x + 12 + labelWidth <= right ? point.x + 12 : point.x - labelWidth - 12;
      const labelX = Math.max(left, Math.min(right - labelWidth, ordered.length > capacity ? right - labelWidth - (offset / capacity) * (labelWidth + 6) : preferredX));
      return { ...point, labelX, labelY, width: labelWidth, height: labelHeight };
    });
    let ceiling = bottom;
    for (let index = positioned.length - 1; index >= 0; index--) {
      positioned[index].labelY = Math.min(positioned[index].labelY, ceiling - labelHeight);
      ceiling = positioned[index].labelY - gap;
    }
    result.push(...positioned);
  }
  return result;
}

function renderUsageChart(host, model, range, visibleAccounts, inspectorId) {
  const restoreFocus = host.contains(document.activeElement) && document.activeElement?.classList.contains("usage-hover-layer");
  const width = Math.max(240, Math.floor(host.clientWidth || host.getBoundingClientRect().width || 640) - 14);
  const compact = host.classList.contains("compact-usage-chart");
  const { height, left, right, top, bottom } = compact
    ? { height: 168, left: 36, right: 12, top: 10, bottom: 134 }
    : USAGE_CHART_LAYOUT;
  const plotRight = width - right;
  const x = (time) => left + ((time - model.startMs) / (model.endMs - model.startMs)) * (plotRight - left);
  const y = (value) => bottom - (value / 100) * (bottom - top);
  const rangeMs = model.endMs - model.startMs;
  const ticks = usageChartTicks(model.startMs, model.endMs, width, rangeMs);
  const tickMarkup = ticks.map((tick, index) => {
    const tickX = x(tick.time);
    const anchor = index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle";
    const label = tick.includeDate
      ? `<tspan x="${tickX.toFixed(1)}" dy="0">${escapeHtml(tick.dateLabel)}</tspan><tspan x="${tickX.toFixed(1)}" dy="12">${escapeHtml(tick.clockLabel)}</tspan>`
      : escapeHtml(tick.clockLabel);
    return `<line class="usage-grid usage-grid-vertical" x1="${tickX.toFixed(1)}" x2="${tickX.toFixed(1)}" y1="${top}" y2="${bottom}"></line><text class="usage-axis-x" x="${tickX.toFixed(1)}" y="${bottom + 16}" text-anchor="${anchor}">${label}</text>`;
  }).join("");
  const visible = model.series.filter(({ account }) => !visibleAccounts || visibleAccounts.has(account.id));
  const paths = visible.map((item) => {
    const samples = item.samples.filter((sample) => Date.parse(sample.ts) <= item.observedMs && Date.parse(sample.ts) <= model.endMs);
    const color = USAGE_ACCOUNT_COLORS[item.index % USAGE_ACCOUNT_COLORS.length];
    const dash = USAGE_ACCOUNT_DASHES[item.index % USAGE_ACCOUNT_DASHES.length];
    let path = "";
    let active = false;
    let previousValue = null;
    let baselineValue = null;
    for (const sample of samples) {
      const time = Date.parse(sample.ts);
      const value = usageFree(sample, model.key);
      if (time < model.startMs) {
        baselineValue = Number.isFinite(value) ? value : null;
        continue;
      }
      if (!Number.isFinite(value)) {
        if (active) path += ` H ${x(time).toFixed(1)}`;
        else if (!path && Number.isFinite(baselineValue)) {
          path = ` M ${x(model.startMs).toFixed(1)} ${y(baselineValue).toFixed(1)} H ${x(time).toFixed(1)}`;
        }
        active = false;
        previousValue = null;
        baselineValue = null;
        continue;
      }
      if (!active) {
        if (Number.isFinite(baselineValue)) {
          path += ` M ${x(model.startMs).toFixed(1)} ${y(baselineValue).toFixed(1)} H ${x(time).toFixed(1)} V ${y(value).toFixed(1)}`;
        } else path += ` M ${x(time).toFixed(1)} ${y(value).toFixed(1)}`;
        active = true;
      } else path += ` H ${x(time).toFixed(1)} V ${y(value).toFixed(1)}`;
      previousValue = value;
    }
    if (!path && Number.isFinite(baselineValue)) {
      path = ` M ${x(model.startMs).toFixed(1)} ${y(baselineValue).toFixed(1)}`;
      active = true;
      previousValue = baselineValue;
    }
    if (active && previousValue !== null && Number.isFinite(item.observedMs)) {
      const end = Math.min(model.endMs, item.observedMs);
      if (end >= model.startMs) path += ` H ${x(end).toFixed(1)}`;
    }
    return path ? `<path class="usage-line account-line" data-account-id="${escapeHtml(item.account.id)}" style="stroke:${color};${dash ? `stroke-dasharray:${dash};` : ""}" d="${path}"></path>` : "";
  }).join("");
  const savedIndex = state.usageHistoryCursorByChart.get(host.id);
  const cursorIndex = model.timestamps.length ? Math.min(savedIndex ?? model.timestamps.length - 1, model.timestamps.length - 1) : -1;
  const timeMs = cursorIndex < 0 ? null : model.timestamps[cursorIndex];
  const markers = visible.map((item, markerIndex) => {
    const reading = timeMs === null ? { value: null } : usageChartValueAt(item, model.key, timeMs);
    const color = USAGE_ACCOUNT_COLORS[item.index % USAGE_ACCOUNT_COLORS.length];
    const markerTime = Number.isFinite(item.observedMs) ? Math.min(timeMs, item.observedMs) : timeMs;
    return `<circle class="usage-cursor-point" data-account-id="${escapeHtml(item.account.id)}" cx="${timeMs === null ? left : x(Math.max(model.startMs, markerTime)).toFixed(1)}" cy="${Number.isFinite(reading.value) ? y(reading.value).toFixed(1) : top}" r="${3 + markerIndex * 0.8}" style="--point-color:${color};fill:none;stroke:${color};stroke-width:1.5" ${Number.isFinite(reading.value) ? "" : "display=\"none\""}></circle>`;
  }).join("");
  const labelsMarkup = selectedTime => {
    if (selectedTime === null) return "";
    const points = visible.flatMap(item => {
      const reading = usageChartValueAt(item, model.key, selectedTime);
      if (!Number.isFinite(reading.value)) return [];
      const markerTime = Number.isFinite(item.observedMs) ? Math.min(selectedTime, item.observedMs) : selectedTime;
      return [{ id: item.account.id, label: item.account.label, value: reading.value, status: reading.status,
        color: USAGE_ACCOUNT_COLORS[item.index % USAGE_ACCOUNT_COLORS.length],
        x: x(Math.max(model.startMs, markerTime)), y: y(reading.value) }];
    });
    return positionUsageLabels(points, { left, right: plotRight, top, bottom }).map(point => {
      const stale = ["cached", "last-known"].includes(point.status);
      const description = `${point.label}: ${point.value}% remaining${point.status === "cached" ? " · cached snapshot" : stale ? " · last recorded, earlier poll" : ""}`;
      const edgeX = point.labelX > point.x ? point.labelX : point.labelX + point.width;
      return `<g class="usage-point-label" data-account-id="${escapeHtml(point.id)}"><title>${escapeHtml(description)}</title><line class="usage-label-connector" x1="${point.x.toFixed(1)}" y1="${point.y.toFixed(1)}" x2="${edgeX.toFixed(1)}" y2="${(point.labelY + point.height / 2).toFixed(1)}" style="stroke:${point.color}"></line><rect x="${point.labelX.toFixed(1)}" y="${point.labelY.toFixed(1)}" width="${point.width}" height="${point.height}" rx="4" style="stroke:${point.color}"></rect><text class="usage-point-value" x="${(point.labelX + point.width / 2).toFixed(1)}" y="${(point.labelY + 12.5).toFixed(1)}" text-anchor="middle" style="fill:${point.color}">${point.value}%${stale ? "*" : ""}</text></g>`;
    }).join("");
  };
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="${escapeHtml(`${model.key === "fiveHourUsed" ? "5-hour" : "Weekly"} quota remaining over ${range}`)}">
    ${[0, 25, 50, 75, 100].map((value) => `<line class="usage-grid" x1="${left}" x2="${plotRight}" y1="${y(value)}" y2="${y(value)}"></line><text class="usage-axis-y" x="${left - 5}" y="${y(value) + 4}">${value}%</text>`).join("")}
    ${tickMarkup}${paths}
    <line class="usage-cursor-line" x1="${timeMs === null ? left : x(timeMs)}" x2="${timeMs === null ? left : x(timeMs)}" y1="${top}" y2="${bottom}" ${timeMs === null ? "display=\"none\"" : ""}></line>${markers}
    <g class="usage-point-labels" aria-hidden="true">${labelsMarkup(timeMs)}</g>
    <rect class="usage-hover-layer" x="${left}" y="${top}" width="${plotRight - left}" height="${bottom - top}" tabindex="0" aria-label="Quota history cursor. Use left and right arrows to move between observed times, Home for first, End for latest." aria-controls="${inspectorId}" aria-describedby="${inspectorId}"></rect>
  </svg>${compact ? "" : `<details class="chart-help"><summary>How to read this chart</summary><p class="usage-inspector-hint">Hover or tap to inspect a time. Use ←/→ to step through readings, Home/End for the range edges. Values come from the last reading at or before the cursor. Lines stop at the last poll; earlier readings are labeled. An asterisk marks a cached or earlier reading.</p></details>`}<div class="usage-inspector${compact ? " sr-only" : ""}" id="${inspectorId}" aria-live="polite"></div>`;
  const target = host.querySelector(".usage-hover-layer");
  if (!target || !model.timestamps.length) return;
  const markerByAccount = new Map([...host.querySelectorAll(".usage-cursor-point")]
    .map((marker) => [marker.dataset.accountId, marker]));
  const updateCursor = (index) => {
    const clamped = Math.max(0, Math.min(model.timestamps.length - 1, index));
    if (state.usageHistoryCursorByChart.get(host.id) === clamped) return;
    state.usageHistoryCursorByChart.set(host.id, clamped);
    const selectedTime = model.timestamps[clamped];
    const cursorX = x(selectedTime).toFixed(1);
    const cursorLine = host.querySelector(".usage-cursor-line");
    cursorLine?.setAttribute("x1", cursorX);
    cursorLine?.setAttribute("x2", cursorX);
    cursorLine?.removeAttribute("display");
    for (const item of visible) {
      const marker = markerByAccount.get(item.account.id);
      if (!marker) continue;
      const reading = usageChartValueAt(item, model.key, selectedTime);
      if (!Number.isFinite(reading.value)) {
        marker.setAttribute("display", "none");
        continue;
      }
      const markerTime = Number.isFinite(item.observedMs) ? Math.min(selectedTime, item.observedMs) : selectedTime;
      marker.setAttribute("cx", x(Math.max(model.startMs, markerTime)).toFixed(1));
      marker.setAttribute("cy", y(reading.value).toFixed(1));
      marker.removeAttribute("display");
    }
    host.querySelector(".usage-point-labels").innerHTML = labelsMarkup(selectedTime);
    renderUsageInspector(model, selectedTime, inspectorId, visibleAccounts);
  };
  const indexAtPointer = (event) => {
    const rect = target.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(rect.width, 1)));
    return nearestUsageTimestamp(model.timestamps, model.startMs + fraction * rangeMs);
  };
  target.addEventListener("pointermove", (event) => { if (event.pointerType === "mouse") updateCursor(indexAtPointer(event)); });
  target.addEventListener("pointerdown", (event) => updateCursor(indexAtPointer(event)));
  target.addEventListener("keydown", (event) => {
    const current = state.usageHistoryCursorByChart.get(host.id) ?? model.timestamps.length - 1;
    const next = nextUsageCursorIndex(current, event.key, model.timestamps.length);
    if (next === null) return;
    event.preventDefault();
    updateCursor(next);
  });
  target.addEventListener("focus", () => {
    const index = state.usageHistoryCursorByChart.get(host.id) ?? model.timestamps.length - 1;
    renderUsageInspector(model, model.timestamps[index], inspectorId, visibleAccounts);
  });
  renderUsageInspector(model, timeMs, inspectorId, visibleAccounts);
  if (restoreFocus) target.focus({ preventScroll: true });
}

function renderUsageInspector(model, timeMs, inspectorId, visibleAccounts) {
  const inspector = document.getElementById(inspectorId);
  if (!inspector || timeMs === null) return;
  const rows = model.series.map((item) => {
    const reading = usageChartValueAt(item, model.key, timeMs);
    const hidden = visibleAccounts && !visibleAccounts.has(item.account.id);
    const label = reading.status === "last-known" ? "Last recorded · earlier poll"
      : reading.status === "cached" ? "Cached snapshot"
        : reading.status === "unavailable" ? "Unavailable" : hidden ? "Hidden" : "Observed";
    const observedMs = reading.sample && timeMs >= item.observedMs ? item.observedMs : Date.parse(reading.sample?.ts || "");
    const observed = Number.isFinite(observedMs) ? new Date(observedMs).toLocaleString() : "No reading at or before this time";
    const color = USAGE_ACCOUNT_COLORS[item.index % USAGE_ACCOUNT_COLORS.length];
    return `<tr><th><i class="usage-legend" style="--account-color:${color}"></i>${escapeHtml(item.account.label)}</th><td>${Number.isFinite(reading.value) ? `${reading.value}%` : "—"}<small>${escapeHtml(observed)}</small></td><td>${label}${hidden ? " · hidden from chart" : ""}</td></tr>`;
  }).join("");
  inspector.innerHTML = `<div class="usage-inspector-heading"><strong>${escapeHtml(new Date(timeMs).toLocaleString())}</strong><small>${escapeHtml(model.key === "fiveHourUsed" ? "5-hour" : "Weekly")} remaining across all accounts</small></div><table><thead><tr><th>Account</th><th>Remaining · recorded at</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderUsageHistory() {
  const focusedSeriesId = document.activeElement?.closest(".usage-series-toggle")?.dataset.accountId;
  const fiveHourChart = $("#usageHistoryFiveHourChart");
  const weeklyChart = $("#usageHistoryWeeklyChart");
  const summary = $("#usageHistorySummary");
  const legend = $("#usageHistoryLegend");
  const latestHost = $("#usageHistoryLatest");
  const changesHost = $("#usageHistoryChanges");
  if (!fiveHourChart || !weeklyChart || !summary || !legend || !latestHost || !changesHost) {
    return;
  }
  document.querySelectorAll("#usageHistoryRanges [data-range]").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === state.usageHistoryRange);
    button.setAttribute("aria-pressed", String(button.dataset.range === state.usageHistoryRange));
  });
  const histories = state.accounts.map((account, index) => {
    const cached = state.usageHistory.get(`${account.id}:${state.usageHistoryRange}`);
    return cached?.data ? { account, index, data: cached.data } : null;
  }).filter(Boolean);
  const chartHistories = state.accounts.map((account, index) => ({
    account,
    index,
    data: state.usageHistory.get(`${account.id}:${state.usageHistoryRange}`)?.data || { samples: [], baseline: null, observedAt: {} }
  }));
  const rangeMs = USAGE_HISTORY_RANGES[state.usageHistoryRange] || USAGE_HISTORY_RANGES["24h"];
  const endMs = Date.now();
  const startMs = endMs - rangeMs;
  const chartModels = {};
  const tracked = histories.filter(({ data }) => data.baseline || data.samples?.length);
  const failedAccounts = state.accounts.filter((account) =>
    state.usageHistoryErrors.has(`${account.id}:${state.usageHistoryRange}`));
  const recordedChanges = histories.reduce((sum, { data }) => sum + (data.samples?.length || 0), 0);
  const polling = histories.map(({ data }) => data.polling).filter(Boolean)
    .sort((a, b) => (a.intervalMs || Infinity) - (b.intervalMs || Infinity))[0] || {};
  const nextCheck = Number.isFinite(Date.parse(polling.nextAt || ""))
    ? fmtCountdown(Date.parse(polling.nextAt) - endMs)
    : "pending";
  summary.innerHTML = [
    ["Accounts tracked", `${tracked.length}/${state.accounts.length}${failedAccounts.length ? ` · ${failedAccounts.length} failed` : ""}`],
    ["Recorded changes", recordedChanges],
    ["Visible range", state.usageHistoryRange],
    ["Polling", histories.some(({ data }) => data.savedSnapshot) ? "Saved snapshot" : Number.isFinite(polling.intervalMs) ? `${formatPollingInterval(polling.intervalMs)} · ${nextCheck}` : "Adaptive"]
  ].map(([label, value]) => `
    <span class="usage-summary-item">
      <b>${escapeHtml(String(value ?? "—"))}</b>
      <small>${escapeHtml(label)}</small>
    </span>`).join("");

  const renderChart = (host, key, chartRange = state.usageHistoryRange) => {
    if (!host) return;
    const model = buildUsageChartModel(chartHistories, key, endMs - USAGE_HISTORY_RANGES[chartRange], endMs);
    if (!host.classList.contains("compact-usage-chart")) chartModels[key] = model;
    const loading = state.accounts.some((account) => state.usageHistoryRequests.has(`${account.id}:${state.usageHistoryRange}`));
    if (!model.timestamps.length) {
      usageChartModels.delete(host);
      host.innerHTML = `<p class="board-empty">${loading ? "Loading fleet usage history..." : failedAccounts.length ? `History unavailable for ${failedAccounts.length} account${failedAccounts.length === 1 ? "" : "s"}.` : "No readings recorded for this window yet."}</p>`;
      return;
    }
    const inspectorId = `${host.id}Inspector`;
    const previousModel = usageChartModels.get(host)?.model;
    const cursorIndex = reconcileUsageCursorIndex(previousModel?.timestamps,
      state.usageHistoryCursorByChart.get(host.id), model.timestamps);
    state.usageHistoryCursorByChart.set(host.id, cursorIndex);
    usageChartModels.set(host, { model, range: chartRange, visibleAccounts: state.usageHistoryVisibleAccounts, inspectorId });
    renderUsageChart(host, model, chartRange, state.usageHistoryVisibleAccounts, inspectorId);
    if (model.timestamps.length) {
      renderUsageInspector(model, model.timestamps[state.usageHistoryCursorByChart.get(host.id)], inspectorId, state.usageHistoryVisibleAccounts);
    } else {
      host.querySelector(`#${inspectorId}`)?.replaceChildren();
    }
    if (typeof ResizeObserver !== "undefined" && !usageChartResizeObservers.has(host)) {
      let redrawFrame = 0;
      const observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width || host.clientWidth;
        const previousWidth = usageChartWidths.get(host);
        if (Number.isFinite(previousWidth) && Math.abs(width - previousWidth) < 1) return;
        usageChartWidths.set(host, width);
        if (redrawFrame) return;
        redrawFrame = requestAnimationFrame(() => {
          redrawFrame = 0;
          const current = usageChartModels.get(host);
          if (current) renderUsageChart(host, current.model, current.range, current.visibleAccounts, current.inspectorId);
        });
      });
      observer.observe(host);
      usageChartResizeObservers.set(host, observer);
    }
  };
  renderChart(fiveHourChart, "fiveHourUsed");
  renderChart(weeklyChart, "weeklyUsed");
  renderChart($("#overviewUsageChart"), "fiveHourUsed", "6h");
  $("#overviewUsageLegend").innerHTML = state.accounts.filter(account => !state.usageHistoryVisibleAccounts || state.usageHistoryVisibleAccounts.has(account.id)).map(account => {
    const index = state.accounts.findIndex(item => item.id === account.id);
    return `<span><i class="usage-legend pattern-${index % USAGE_ACCOUNT_DASHES.length}" style="--account-color:${USAGE_ACCOUNT_COLORS[index % USAGE_ACCOUNT_COLORS.length]}"></i>${escapeHtml(account.label)}</span>`;
  }).join("");
  legend.innerHTML = state.accounts.map((account, index) => {
    const selected = !state.usageHistoryVisibleAccounts || state.usageHistoryVisibleAccounts.has(account.id);
    const color = USAGE_ACCOUNT_COLORS[index % USAGE_ACCOUNT_COLORS.length];
    const dashClass = `pattern-${index % USAGE_ACCOUNT_DASHES.length}`;
    return `<button type="button" class="usage-series-toggle ${selected ? "" : "is-muted"} ${state.usageHistoryErrors.has(`${account.id}:${state.usageHistoryRange}`) ? "unavailable" : ""}" data-account-id="${escapeHtml(account.id)}" aria-pressed="${selected}" style="--account-color:${color}"><i class="usage-legend ${dashClass}"></i>${escapeHtml(account.label)}</button>`;
  }).join("") || '<span>No accounts configured.</span>';
  legend.querySelectorAll("[data-account-id]").forEach((button) => button.addEventListener("click", () => {
    if (!state.usageHistoryVisibleAccounts) state.usageHistoryVisibleAccounts = new Set(state.accounts.map((account) => account.id));
    const id = button.dataset.accountId;
    if (state.usageHistoryVisibleAccounts.has(id)) {
      if (state.usageHistoryVisibleAccounts.size > 1) state.usageHistoryVisibleAccounts.delete(id);
    } else state.usageHistoryVisibleAccounts.add(id);
    renderUsageHistory();
  }));
  if (focusedSeriesId) {
    [...legend.querySelectorAll(".usage-series-toggle")].find((button) => button.dataset.accountId === focusedSeriesId)?.focus({ preventScroll: true });
  }
  const latestRows = state.accounts.map((account, index) => {
    const historyKey = `${account.id}:${state.usageHistoryRange}`;
    const data = state.usageHistory.get(historyKey)?.data;
    const latest = data?.samples?.at(-1) || data?.baseline;
    const sourceLabel = data?.savedSnapshot ? "Cached snapshot · "
      : state.usageHistoryErrors.has(historyKey) ? "Refresh failed · " : "";
    const value = (key) => {
      const free = usageFree(latest, key);
      return Number.isFinite(free) ? `${free}%` : "—";
    };
    return `
      <tr>
        <th><i class="usage-legend pattern-${index % USAGE_ACCOUNT_DASHES.length}" style="--account-color:${USAGE_ACCOUNT_COLORS[index % USAGE_ACCOUNT_COLORS.length]}"></i>${escapeHtml(account.label)}</th>
        <td>${value("fiveHourUsed")}</td>
        <td>${value("weeklyUsed")}</td>
        <td>${latest?.ts ? escapeHtml(`${sourceLabel}${new Date(latest.ts).toLocaleString()}`) : state.usageHistoryErrors.has(historyKey) ? "Unavailable" : data?.savedSnapshot ? "Cached snapshot · no reading" : "Waiting"}</td>
      </tr>`;
  }).join("");
  const fiveHourInsights = new Map(usageInsightStats(chartModels.fiveHourUsed?.series || [], "fiveHourUsed", startMs, endMs)
    .map((item) => [item.account.id, item.summary]));
  const weeklyInsights = new Map(usageInsightStats(chartModels.weeklyUsed?.series || [], "weeklyUsed", startMs, endMs)
    .map((item) => [item.account.id, item.summary]));
  const insights = `<table><thead><tr><th>Account</th><th>5-hour changes</th><th>Weekly changes</th></tr></thead><tbody>${state.accounts.map((account) => `
    <tr><th>${escapeHtml(account.label)}</th><td>${escapeHtml(fiveHourInsights.get(account.id) || "No observations")}</td><td>${escapeHtml(weeklyInsights.get(account.id) || "No observations")}</td></tr>
  `).join("")}</tbody></table>`;
  latestHost.innerHTML = state.accounts.length ? `
    <div class="usage-history-insights"><p><strong>Range insights</strong> · low remaining, net change, observed use and replenishments</p>${insights}</div>
    <table>
      <thead><tr><th>Account</th><th>5h remaining</th><th>Weekly remaining</th><th>Last change / source</th></tr></thead>
      <tbody>${latestRows}</tbody>
    </table>` : "";
  const recentChanges = histories.flatMap(({ account, data }) => (data.samples || []).map((sample) => ({ account, sample })))
    .sort((a, b) => Date.parse(b.sample.ts) - Date.parse(a.sample.ts))
    .slice(0, 40);
  changesHost.innerHTML = recentChanges.length ? `
    <table>
      <thead><tr><th>Account</th><th>Observed</th><th>5h remaining</th><th>Weekly remaining</th></tr></thead>
      <tbody>${recentChanges.map(({ account, sample }) => `
        <tr>
          <th>${escapeHtml(account.label)}</th>
          <td><time datetime="${escapeHtml(sample.ts)}">${escapeHtml(new Date(sample.ts).toLocaleString())}</time></td>
          ${["fiveHourUsed", "weeklyUsed"].map((key) => {
            const free = usageFree(sample, key);
            return `<td>${Number.isFinite(free) ? `${free}%` : "—"}</td>`;
          }).join("")}
        </tr>`).join("")}</tbody>
    </table>` : '<p class="board-empty">No changes occurred inside this range.</p>';
}

function readUsageHistorySnapshot(accountId) {
  if (state.usageHistoryRange !== "24h") {
    return null;
  }
  try {
    const snapshots = JSON.parse(localStorage.getItem(USAGE_HISTORY_SNAPSHOT_STORAGE_KEY) || "{}");
    const data = snapshots?.[accountId];
    return data?.range === "24h" && Array.isArray(data.samples) ? { ...data, savedSnapshot: true } : null;
  } catch {
    return null;
  }
}

function saveUsageHistorySnapshot(accountId, data) {
  if (data.range !== "24h") {
    return;
  }
  try {
    const snapshots = JSON.parse(localStorage.getItem(USAGE_HISTORY_SNAPSHOT_STORAGE_KEY) || "{}");
    snapshots[accountId] = {
      ...data,
      samples: data.samples.slice(-1500),
      savedAt: new Date().toISOString()
    };
    localStorage.setItem(USAGE_HISTORY_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots));
  } catch {
    // Live history remains available when local storage is disabled or full.
  }
}

async function loadUsageHistory(accountId = selectedAccountId(), force = false) {
  if (!accountId || state.removingAccountIds.has(accountId) || !state.accounts.some(account => account.id === accountId)) {
    renderUsageHistory();
    return;
  }
  const key = `${accountId}:${state.usageHistoryRange}`;
  const requestedRange = state.usageHistoryRange;
  let cached = state.usageHistory.get(key);
  if (!cached) {
    const snapshot = readUsageHistorySnapshot(accountId);
    if (snapshot) {
      cached = { fetchedAt: 0, data: snapshot };
      state.usageHistory.set(key, cached);
      renderUsageHistory();
    }
  }
  if (!force && cached && Date.now() - cached.fetchedAt < 55_000) {
    renderUsageHistory();
    return;
  }
  if (!cached) {
    renderUsageHistory();
  }
  if (state.usageHistoryRequests.has(key)) {
    if (force) {
      state.usageHistoryRefreshQueued.add(key);
    }
    return state.usageHistoryRequests.get(key);
  }
  const generation = (state.usageHistoryGeneration.get(key) || 0) + 1;
  state.usageHistoryGeneration.set(key, generation);
  const controller = new AbortController();
  state.usageHistoryControllers.set(key, controller);
  const request = (async () => {
    try {
      const data = await api(`/api/usage-history?accountId=${encodeURIComponent(accountId)}&range=${encodeURIComponent(requestedRange)}`, { signal: controller.signal });
      if (controller.signal.aborted || state.usageHistoryGeneration.get(key) !== generation) {
        return;
      }
      state.usageHistory.set(key, { fetchedAt: Date.now(), data });
      state.usageHistoryErrors.delete(key);
      saveUsageHistorySnapshot(accountId, data);
      if (requestedRange === state.usageHistoryRange) {
        renderUsageHistory();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      state.usageHistoryErrors.set(key, error.message);
      if (requestedRange === state.usageHistoryRange && state.usageHistoryGeneration.get(key) === generation) {
        renderUsageHistory();
      }
    } finally {
      if (state.usageHistoryControllers.get(key) === controller) state.usageHistoryControllers.delete(key);
      if (state.usageHistoryRequests.get(key) === request) {
        state.usageHistoryRequests.delete(key);
      }
      if (state.usageHistoryRefreshQueued.delete(key)) {
        return loadUsageHistory(accountId, true);
      }
    }
  })();
  state.usageHistoryRequests.set(key, request);
  return request;
}

async function loadFleetUsageHistory(force = false) {
  const requests = state.accounts.map((account) => loadUsageHistory(account.id, force));
  renderUsageHistory();
  await Promise.allSettled(requests);
}

function fmtHorizonDay(ms) {
  return new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric" });
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
  const win = accountWindow({ dashboard });
  const resetCredits = accountResetCredits({ dashboard });
  const current = effectiveWindow(win);
  const remainingValue = current?.free;
  const reset = Number.isFinite(current?.resetsAt) ? formatUnixSeconds(current.resetsAt) : "Unknown";
  const duration = Number.isFinite(current?.windowDurationMins) ? `${current.windowDurationMins} min` : "Unknown";
  const plan = limits?.planType ? `${limits.planType} / ${duration}` : duration;
  const lastTurn = dashboard.lastCompletedTurn;

  $("#windowPlan").textContent = plan;
  const reserve = win?.reserve?.weekly;
  const reserveMode = reserveState(win);
  $("#windowReserve").textContent = reserve?.hasData ? `${reserve.free}% remaining` : "Unavailable";
  $("#windowReserveState").textContent = reserveMode
    ? `${reserveMode}${win.reserve.model ? ` / ${win.reserve.model}` : ""}`
    : "Not reported";
  $("#windowReserveReset").textContent = Number.isFinite(reserve?.resetsAt)
    ? formatUnixSeconds(reserve.resetsAt)
    : "Not reported";
  $("#windowResetCredits").textContent = Number.isSafeInteger(resetCredits.resetCreditsAvailable)
    ? `${resetCredits.resetCreditsAvailable}${resetCredits.resetCreditsUpdatedAt ? ` (read ${new Date(resetCredits.resetCreditsUpdatedAt).toLocaleString()})` : ""}`
    : "Not reported";
  $("#windowResetExpiry").textContent = resetCreditExpiry(resetCredits).label;
  const focusedCreditId = $("#accountResetCredits").contains(document.activeElement) ? document.activeElement.id : null;
  $("#accountResetCredits").innerHTML = resetCreditStack(resetCredits, selectedAccountId(), Date.now(), "account");
  syncResetCreditDecks();
  if (focusedCreditId) document.getElementById(focusedCreditId)?.focus({ preventScroll: true });
  $("#lastPing").textContent = compactText(dashboard.lastUserMessage?.text);
  $("#lastReply").textContent = compactText(dashboard.lastAgentMessage?.text);
  $("#windowUsageLabel").textContent = Number.isFinite(remainingValue) ? `${remainingValue}% remaining` : "Usage unknown";
  $("#windowResetHint").textContent = Number.isFinite(current?.resetsAt) ? `Limiting window resets ${reset}` : "Reset unknown";
  $("#windowUsageBar").style.width = `${clampPercent(remainingValue)}%`;

  if (lastTurn?.status === "completed" && !lastTurn.error) {
    badge($("#windowBadge"), `Last turn OK (${formatDuration(lastTurn.durationMs)})`, "ok");
  } else if (lastTurn?.status === "failed" || lastTurn?.error) {
    badge($("#windowBadge"), "Last turn failed", "bad");
  } else if (["interrupted", "cancelled"].includes(lastTurn?.status)) {
    badge($("#windowBadge"), "Last turn interrupted", "warn");
  } else if (limits || win?.reserve || Number.isSafeInteger(win?.resetCreditsAvailable)) {
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
  const authUncertain = status.auth.probeUnavailable || status.auth.logoutConfirmationPending;
  $("#authState").textContent = status.auth.probeUnavailable
    ? "Authentication check unavailable"
    : status.auth.logoutConfirmationPending
      ? "Logged-out status pending confirmation"
    : status.auth.detail || (status.auth.loggedIn ? "Logged in" : "Not logged in");
  $("#appServerState").textContent = status.appServer.running ? "Running" : "Stopped";
  $("#threadState").textContent = selectedAccount.thread?.threadId || status.thread.threadId || "None";
  state.schedulerEnabled = status.scheduler.enabled;
  $("#scheduleNext").textContent = status.scheduler.enabled
    ? `Next send · ${status.scheduler.next.nextLocal || "No sends scheduled"}` : "Paused · scheduled sends are on hold";
  $("#lastRun").textContent = formatRun(status.latestRun);
  renderNextSend(status.scheduler.next.nextLocal, status.scheduler.enabled);

  badge($("#serviceBadge"), status.auth.probeUnavailable ? "Auth check unavailable" : status.auth.logoutConfirmationPending ? "Auth check pending" : status.auth.loggedIn ? "Ready" : status.auth.authIssue ? "Auth issue" : "Needs login", authUncertain ? "warn" : status.auth.loggedIn ? "ok" : status.auth.authIssue ? "bad" : "warn");
  badge($("#loginBadge"), status.auth.probeUnavailable ? "Check unavailable" : status.auth.logoutConfirmationPending ? "Confirmation pending" : status.auth.loggedIn ? "Logged in" : status.auth.authIssue ? "Authentication failed" : "Logged out", authUncertain ? "warn" : status.auth.loggedIn ? "ok" : "bad");
  badge($("#schedulerBadge"), status.scheduler.enabled ? "Enabled" : "Paused", status.scheduler.enabled ? "ok" : "warn");
  renderScheduleSummary();
  updateWindowSummary(status.dashboard || {});
  renderFleet();
  renderUsageHistory();

  renderSchedulerToggle();
  renderDepartures();
}

function selectedAccountId() {
  return state.selectedAccountId || $("#accountSelect")?.value || null;
}

function renderAccounts() {
  const select = $("#accountSelect");
  if (!select) return;
  const selected = state.accounts.find((account) => account.id === state.selectedAccountId) || state.accounts[0];
  const changed = state.renderedAccountId !== selected?.id;
  if (changed) {
    state.renderedAccountId = selected?.id;
    state.loginSession = null;
    $("#loginOutput").textContent = "";
    $("#loginProgress").hidden = true;
    $("#accountOverrides").close();
    $("#accountDiagnostics").open = false;
    for (const id of ["accountMessage", "accountDetailsMessage", "accountOverridesMessage", "accountDangerMessage", "manualMessage", "runMessage", "loginMessage"]) feedback(id, "");
  }
  select.replaceChildren(...state.accounts.map((account) => new Option(account.label, account.id, false, account.id === selected?.id)));
  const draft = state.accountDrafts.get(selected?.id);
  $("#accountLabelInput").value = draft?.label ?? selected?.label ?? "";
  $("#accountEnabledInput").checked = selected?.enabled === true;
  if (changed || !draft?.overrides) {
    fillAccountOverrides(selected);
    if (draft?.overrides) {
      for (const [id, value] of Object.entries(draft.overrides)) $("#" + id).value = value;
    }
  } else if (selected?.auth?.loggedIn) void refreshModels(selected.id);
  $("#accountRunSettingsTitle").textContent = `Run settings · ${selected?.label || "Account"}`;
  const custom = selected?.settings || {};
  $("#accountRunSettingsSummary").textContent = `${custom.scheduleTimes?.length ? `Custom times: ${custom.scheduleTimes.join(", ")}` : "Shared schedule"} · ${custom.model || "Shared model"}${custom.promptTemplate ? " · Custom prompt" : ""}`;
  $("#sendTarget").textContent = selected
    ? `To ${selected.label} · leave the prompt empty to use this account’s scheduled prompt.`
    : "Add an account to send a message.";
  $("#runNowBtn").title = selected ? `Send the scheduled prompt to ${selected.label}` : "Add an account first";
  renderAccountAccess();
  updateAccountControls();
}

function updateAccountControls() {
  if (typeof document === "undefined") return;
  const account = state.accounts.find((item) => item.id === state.selectedAccountId);
  const signingIn = state.loginSession?.accountId === account?.id && state.loginSession?.status === "running";
  for (const id of ["accountSelect", "addAccountOpenBtn", "saveAccountBtn", "saveAccountOverridesBtn", "editAccountRunSettingsBtn", "accountEnabledInput", "logoutBtn", "removeAccountBtn"]) {
    const element = $("#" + id);
    if (element) element.disabled = Boolean(state.accountBusy || state.sendBusy || element.dataset.pending || (!account && id !== "addAccountOpenBtn") || (signingIn && ["logoutBtn", "removeAccountBtn"].includes(id)));
  }
  $("#deviceLoginBtn").disabled = Boolean(state.accountBusy || signingIn || !account);
  $("#removeAccountBtn").disabled ||= state.accounts.length <= 1;
  $("#removeAccountBtn").title = state.accounts.length <= 1 ? "Keep at least one account in the dashboard." : "";
  $("#confirmRemoveAccountBtn").disabled = Boolean(state.accountBusy || state.sendBusy || !state.removalTarget || state.accounts.length <= 1);
  for (const id of ["closeRemoveAccountBtn", "cancelRemoveAccountBtn"]) $("#" + id).disabled = state.removalBusy;
  for (const id of ["accountDetailsForm", "accountOverridesForm"]) $("#" + id).inert = state.accountBusy;
  if (!state.sendBusy) {
    $("#manualSendBtn").disabled = $("#runNowBtn").disabled = state.accountBusy || !account || !account.auth?.loggedIn;
  }
  if (account && !account.auth?.loggedIn) $("#sendTarget").textContent = `Sign in to ${account.label} in Accounts before sending.`;
}

async function refreshStatus() {
  const requestId = ++state.statusRequestId;
  const status = await api("/api/status");
  if (requestId !== state.statusRequestId || (state.selectingAccountId && status.selectedAccountId !== state.selectingAccountId)) return;
  updateStatus(status);
  saveStatusSnapshot(status);
  setSnapshotMode();
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
  const reloads = await Promise.allSettled(interactive
    ? [
        refreshStatus(),
        refreshSettings(),
        refreshActivity(),
        refreshLoginSession()
      ]
    : [refreshStatus(), refreshActivity()]);
  const reloadFailures = reloads.filter((result) => result.status === "rejected").length;
  await loadFleetUsageHistory(true);

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
        button.textContent = "Refresh account state";
      }
    }, 3000);
  } else {
    button.textContent = "Refresh account state";
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
  await loadFleetUsageHistory();
}

function startAutoRefresh() {
  setInterval(() => void refreshVisibleState(), VISIBLE_STATE_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshVisibleState();
    }
  });
}

async function selectAccount(accountId) {
  if (state.accountBusy) return;
  state.selectingAccountId = accountId;
  await accountAction($("#accountSelect"), "accountMessage", async () => {
    try {
      const result = await api("/api/accounts/select", { method: "POST", body: JSON.stringify({ accountId }) });
      state.selectedAccountId = result.selectedAccountId;
      state.accounts = result.accounts || state.accounts;
      renderAccounts();
      await refreshStatus();
      await Promise.all([loadFleetUsageHistory(), refreshLoginSession()]);
    } finally {
      state.selectingAccountId = null;
      $("#accountSelect").value = state.selectedAccountId || "";
    }
  });
}

async function patchSelectedAccount(patch, accountId = selectedAccountId()) {
  if (!accountId) return;
  await api(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: JSON.stringify(patch) });
  await refreshStatus();
}

function fillAccountOverrides(account) {
  const overrides = account?.settings || {};
  const effective = account?.effectiveSettings || {};
  $("#accountScheduleInput").value = (overrides.scheduleTimes || []).join(", ");
  $("#accountWorkspaceInput").value = overrides.workspaceDir || "";
  fillModelSelect($("#accountModelInput"), state.accountDrafts.get(account?.id)?.overrides?.accountModelInput ?? overrides.model ?? "", "Use shared model");
  $("#accountPromptInput").value = overrides.promptTemplate || "";
  $("#accountScheduleInput").placeholder = (effective.scheduleTimes || []).join(", ") || "Inherited";
  $("#accountWorkspaceInput").placeholder = effective.workspaceDir || "Inherited";
  if (account?.auth?.loggedIn) void refreshModels(account.id);
  else {
    $("#accountModelHint").textContent = "Sign in to see the models available to this account.";
  }
  $("#accountPromptInput").placeholder = "Inherited global template";
}

function fillModelSelect(select, value, defaultLabel) {
  const catalog = state.modelCatalogs.get(selectedAccountId());
  const models = catalog?.data || [];
  select.replaceChildren(new Option(defaultLabel, ""));
  for (const model of models) {
    select.add(new Option(`${model.displayName}${model.model === catalog.recommendedModel ? " · lowest cost preference" : ""}`, model.model));
  }
  if (value && !models.some((model) => model.model === value)) {
    select.add(new Option(`${value} · unavailable in catalog`, value));
  }
  select.value = value;
}

async function refreshModels(accountId) {
  if (!accountId || state.modelCatalogRequests.has(accountId)) return;
  const cached = state.modelCatalogs.get(accountId);
  if (cached && Date.now() - cached.loadedAt < (cached.data ? 300000 : 10000)) {
    if (cached.data && selectedAccountId() === accountId) renderModelCatalog(cached);
    return;
  }
  state.modelCatalogRequests.add(accountId);
  try {
    const catalog = await api(`/api/models?accountId=${encodeURIComponent(accountId)}`);
    state.modelCatalogs.set(accountId, { ...catalog, loadedAt: Date.now() });
    if (selectedAccountId() !== accountId) return;
    renderModelCatalog(catalog);
  } catch (error) {
    state.modelCatalogs.set(accountId, { loadedAt: Date.now() });
    if (selectedAccountId() === accountId) {
      $("#modelHint").textContent = $("#accountModelHint").textContent = `Could not load models: ${error.message}`;
    }
  } finally {
    state.modelCatalogRequests.delete(accountId);
  }
}

function renderModelCatalog(catalog) {
  fillModelSelect($("#modelInput"), $("#modelInput").value, "Automatic · prefer lowest cost");
  fillModelSelect($("#accountModelInput"), $("#accountModelInput").value, "Use shared model");
  $("#modelHint").textContent = `Automatic uses the lowest-cost preference available to each account (${catalog.recommendedModel} for the selected account).`;
  $("#accountModelHint").textContent = "Use the shared model or choose one for this account.";
}

async function saveAccountOverrides(event) {
  event.preventDefault();
  const accountId = selectedAccountId();
  const scheduleTimes = $("#accountScheduleInput").value.split(",").map((item) => item.trim()).filter(Boolean);
  const settings = {
    scheduleTimes: scheduleTimes.length ? scheduleTimes : null,
    workspaceDir: $("#accountWorkspaceInput").value.trim() || null,
    model: $("#accountModelInput").value.trim() || null,
    promptTemplate: $("#accountPromptInput").value.trim() || null
  };
  await accountAction($("#saveAccountOverridesBtn"), "accountOverridesMessage", async () => {
    feedback("accountOverridesMessage", "Saving…");
    await patchSelectedAccount({ settings }, accountId);
    const draft = state.accountDrafts.get(accountId);
    if (draft) delete draft.overrides;
    feedback("accountOverridesMessage", "Custom settings saved.", "success");
    renderAccounts();
  });
}

function renderSchedulerToggle() {
  const button = $("#schedulerToggleBtn");
  button.disabled = state.schedulerBusy;
  button.textContent = state.schedulerBusy ? "Updating…" : state.schedulerEnabled ? "Pause" : "Resume";
  button.setAttribute("aria-label", state.schedulerEnabled ? "Pause scheduler" : "Resume scheduler");
  button.setAttribute("aria-busy", String(state.schedulerBusy));
}

function schedulePromptPreview(settings, now = new Date()) {
  const template = settings.promptTemplate || "";
  if (!/\{\{(?:local_time|scheduled_time|reason)\}\}/.test(template)) return template;
  const timezone = settings.timezone || "Europe/Lisbon";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map(part => [part.type, part.value]));
  const localTime = `${parts.hour}:${parts.minute}`;
  const times = [...(settings.scheduleTimes || [])].sort();
  const todayNext = times.find(time => time > localTime);
  const scheduledTime = todayNext || times[0] || "";
  let date = timezoneDateKey(timezone, now);
  if (!todayNext && scheduledTime) {
    // Advance the local calendar date without applying the browser's timezone.
    const tomorrow = new Date(`${date}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    date = tomorrow.toISOString().slice(0, 10);
  }
  return template
    .replaceAll("{{local_time}}", `${date} ${scheduledTime || localTime} ${timezone}`)
    .replaceAll("{{scheduled_time}}", scheduledTime)
    .replaceAll("{{reason}}", "scheduled");
}

function renderScheduleSummary() {
  const settings = state.settings;
  if (!settings) return;
  $("#editScheduleBtn").disabled = false;
  $("#scheduleTimezone").textContent = `Every day · ${settings.timezone}`;
  $("#scheduleTimes").replaceChildren(...(settings.scheduleTimes || []).map(time => {
    const chip = document.createElement("span");
    chip.textContent = time;
    return chip;
  }));
  $("#schedulePrompt").textContent = schedulePromptPreview(settings) || "No scheduled message set.";
  $("#schedulePromptHint").hidden = !/\{\{(?:local_time|scheduled_time|reason)\}\}/.test(settings.promptTemplate || "");
  $("#scheduleOptions").textContent = `${settings.model || "Automatic model"} · ${settings.effort || "Default"} effort`;
}

function selectSettingsTab(name) {
  for (const tab of document.querySelectorAll(".settings-tabs [role=tab]")) {
    const selected = tab.id === `${name}-tab`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
  }
}

function markSettingsDirty() {
  state.settingsDirty = true;
  state.settingsRevision += 1;
  $("#editScheduleBtn").textContent = "Continue editing";
  feedback("scheduleMessage", "Unsaved changes in schedule editor.");
  feedback("settingsMessage", "Unsaved changes.");
}

function syncScheduleTimes() {
  $("#scheduleInput").value = [...document.querySelectorAll("#scheduleTimeInputs input")].map(input => input.value).filter(Boolean).join(", ");
}

function renderScheduleTimeInputs(times) {
  const rows = times.map((time, index) => {
    const row = document.createElement("div");
    row.className = "schedule-time-row";
    const input = document.createElement("input");
    input.type = "time";
    input.value = time;
    input.required = true;
    input.setAttribute("aria-label", `Send time ${index + 1}`);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "×";
    button.dataset.index = index;
    button.setAttribute("aria-label", `Remove send time ${index + 1}`);
    row.append(input, button);
    return row;
  });
  $("#scheduleTimeInputs").replaceChildren(...rows);
  syncScheduleTimes();
}

const ALERT_RULES = {
  "quota-threshold": ["telegramQuotaThresholdRulesRows", "telegramQuotaThresholdRulesSummary"],
  "quota-reset": ["telegramQuotaResetRulesRows", "telegramQuotaResetRulesSummary"],
  "reserve-active": ["telegramReserveActiveRows", "telegramReserveActiveSummary"],
  "reserve-recovered": ["telegramReserveRecoveredRows", "telegramReserveRecoveredSummary"],
  "reset-credit-count": ["telegramResetCreditRulesRows", "telegramResetCreditRulesSummary"],
  "auth-failure": ["telegramAuthFailureRows", "telegramAuthFailureSummary"],
  "send-failure": ["telegramSendFailureRows", "telegramSendFailureSummary"]
};
const QUOTA_WINDOWS = ["5h", "weekly", "reserve"];
const REMINDER_IDS = { "5h": "telegramReminder5hRows", weekly: "telegramReminderWeeklyRows", reserve: "telegramReminderReserveRows" };
function renderNumberRows(containerId, values, { kind, min, max, unit, firstId, addId, summaryId, removeName } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const rows = values.map((value, index) => {
    const row = document.createElement("div"); row.className = "telegram-expiry-reminder-row";
    const label = document.createElement("label"); label.textContent = `${kind} ${index + 1} (${unit})`;
    const input = document.createElement("input"); input.type = "number"; input.min = String(min); input.max = String(max); input.step = "1"; input.required = true; input.value = value ?? "";
    input.dataset.alertKind = kind; input.setAttribute("aria-label", `${kind} ${index + 1} ${unit}`);
    if (firstId && index === 0) input.id = firstId;
    label.append(input);
    const button = document.createElement("button"); button.type = "button"; button.textContent = "×"; button.dataset.index = index; button.setAttribute("aria-label", `Remove ${removeName || kind.toLowerCase()} ${index + 1}`);
    row.append(label, button); return row;
  });
  container.replaceChildren(...rows);
  if (addId) document.getElementById(addId).disabled = values.length >= 10;
  if (summaryId) document.getElementById(summaryId).textContent = values.length ? `${values.length} ${kind.toLowerCase()}${values.length === 1 ? "" : "s"} configured` : `${kind}s are off.`;
  updateAlertDisclosureCounts();
}
function numberRowValues(containerId) { return [...document.querySelectorAll(`#${containerId} input`)].map(input => input.value); }
function validateNumberRows(containerId, unit) {
  const inputs = [...document.querySelectorAll(`#${containerId} input`)];
  const values = inputs.map(input => input.value.trim());
  inputs.forEach((input, index) => input.setCustomValidity(values[index] && values.filter(value => value && Number(value) === Number(values[index])).length > 1 ? `Values must be distinct ${unit}.` : ""));
}
function renderTelegramExpiryReminders(hours = []) {
  renderNumberRows("telegramExpiryReminderRows", hours, { kind: "Reminder", min: 1, max: 720, unit: "hours before expiry", removeName: "expiry reminder", addId: "addTelegramExpiryReminderBtn", summaryId: "telegramExpiryReminderSummary" });
}
function updateTelegramExpiryReminderSummary() { const n = document.querySelectorAll("#telegramExpiryReminderRows input").length; $("#addTelegramExpiryReminderBtn").disabled = n >= 10; $("#telegramExpiryReminderSummary").textContent = n ? `${n} reminder${n === 1 ? "" : "s"} configured` : "Expiry reminders are off."; }
function telegramExpiryReminderValues() { return numberRowValues("telegramExpiryReminderRows"); }
function validateTelegramExpiryReminders() { validateNumberRows("telegramExpiryReminderRows", "hours"); }
function renderAlertRules(rules = {}, thresholds = [80, 95, 100]) {
  renderNumberRows("telegramQuotaThresholdRows", thresholds, { kind: "Threshold", min: 1, max: 100, unit: "percent used", firstId: "telegramQuotaThresholdInput", addId: "addTelegramQuotaThresholdBtn", summaryId: "telegramQuotaThresholdSummary" });
  for (const [key, [container, summary]] of Object.entries(ALERT_RULES)) {
    renderNumberRows(container, rules[key] ?? [0], { kind: "Notification", min: 0, max: 10080, unit: "minutes after event", summaryId: summary });
    const count = document.querySelectorAll(`#${container} input`).length;
    const add = document.querySelector(`[data-add-rule="${key}"]`);
    if (add) add.disabled = count >= 10;
  }
  for (const window of QUOTA_WINDOWS) {
    const id = REMINDER_IDS[window];
    renderNumberRows(id, (state.settings?.telegramQuotaReminderHours || {})[window] || [], { kind: "Reminder", min: 1, max: 720, unit: "hours before reset", summaryId: null });
    const add = document.querySelector(`[data-add-reminder="${window}"]`);
    const n = document.querySelectorAll(`#${id} input`).length;
    add.disabled = n >= 10;
    const summary = document.getElementById(`telegramReminder${window === "5h" ? "5h" : window === "weekly" ? "Weekly" : "Reserve"}Summary`);
    summary.textContent = n ? `${n} reminder${n === 1 ? "" : "s"}` : "Off";
  }
}
function validateAllAlertNumbers() {
  validateTelegramExpiryReminders(); validateNumberRows("telegramQuotaThresholdRows", "percent");
  for (const config of Object.values(ALERT_RULES)) validateNumberRows(config[0], "minutes");
  for (const id of Object.values(REMINDER_IDS)) validateNumberRows(id, "hours");
}
function updateAlertDisclosureCounts() {
  const count = id => document.querySelectorAll(`#${id} input`).length;
  const thresholds = count("telegramQuotaThresholdRows");
  const warningTimes = count("telegramQuotaThresholdRulesRows");
  const watched = { "5h": $("#telegramWatch5hInput").checked, weekly: $("#telegramWatchWeeklyInput").checked, reserve: $("#telegramWatchReserveInput").checked };
  const watching = Object.values(watched).some(Boolean);
  const beforeReset = Object.entries(REMINDER_IDS).reduce((n, [key, id]) => n + (watched[key] ? count(id) : 0), 0);
  const expiryTimes = $("#telegramResetExpiryInput").checked ? count("telegramExpiryReminderRows") : 0;
  const counts = {
    quota: watching && thresholds && warningTimes ? `${thresholds} thresholds · ${warningTimes} per crossing` : "Off",
    "quota-resets": watching ? `${count("telegramQuotaResetRulesRows")} after · ${beforeReset} before` : "Off",
    credits: `${expiryTimes ? `${expiryTimes} expiry` : "Expiry off"} · ${count("telegramResetCreditRulesRows")} count`,
    reserve: `${count("telegramReserveActiveRows")} activation · ${count("telegramReserveRecoveredRows")} recovery`,
    failures: `${count("telegramAuthFailureRows")} auth · ${count("telegramSendFailureRows")} scheduled turn`
  };
  for (const [key, value] of Object.entries(counts)) { const node = document.querySelector(`[data-alert-count="${key}"]`); if (node) node.textContent = value; }
}

function fillSettings(settings) {
  state.settings = settings;
  if (!state.settingsDirty) fillScheduleSettings(settings);
  if (!state.alertsDirty) fillAlertSettings(settings);
  renderScheduleSummary();
  renderAlertsSummary();
}

function fillScheduleSettings(settings) {
  $("#timezoneInput").value = settings.timezone || "";
  $("#scheduleInput").value = (settings.scheduleTimes || []).join(", ");
  renderScheduleTimeInputs(settings.scheduleTimes || []);
  $("#workspaceInput").value = settings.workspaceDir || "";
  fillModelSelect($("#modelInput"), settings.model || "", "Automatic · prefer lowest cost");
  $("#effortInput").value = settings.effort || "";
  $("#approvalInput").value = settings.approvalPolicy || "";
  $("#summaryInput").value = settings.summary || "";
  $("#networkInput").checked = Boolean(settings.networkAccess);
  $("#skipActiveInput").checked = Boolean(settings.skipIfActive);
  $("#promptInput").value = settings.promptTemplate || "";
}

function fillAlertSettings(settings) {
  $("#telegramEnabledInput").checked = Boolean(settings.telegramAlertsEnabled);
  $("#telegramEnabledInput").disabled = !settings.telegramConfigured && !settings.telegramAlertsEnabled;
  renderTelegramExpiryReminders(settings.telegramResetReminderHours ?? [48]);
  $("#telegramResetExpiryInput").checked = settings.telegramAlertResetExpiry !== false;
  renderAlertRules(settings.telegramAlertRules || {}, settings.telegramQuotaWarningPercents ?? [settings.telegramQuotaWarningPercent ?? 80, 95, 100]);
  const watched = settings.telegramQuotaWindows || QUOTA_WINDOWS;
  $("#telegramWatch5hInput").checked = watched.includes("5h");
  $("#telegramWatchWeeklyInput").checked = watched.includes("weekly");
  $("#telegramWatchReserveInput").checked = watched.includes("reserve");
  $("#telegramTestBtn").disabled = !settings.telegramConfigured;
  badge(
    $("#telegramStatus"),
    settings.telegramConfigured ? settings.telegramAlertsEnabled ? "Enabled" : "Configured" : "Credentials missing",
    settings.telegramConfigured ? settings.telegramAlertsEnabled ? "ok" : "warn" : "neutral"
  );
  updateAlertDisclosureCounts();
}

function renderAlertsSummary() {
  const settings = state.settings;
  if (!settings) return;
  $("#editAlertsBtn").disabled = false;
  badge($("#alertsStatus"), settings.telegramConfigured ? settings.telegramAlertsEnabled ? "Enabled" : "Off" : "Credentials missing",
    settings.telegramConfigured && settings.telegramAlertsEnabled ? "ok" : "neutral");
  const eventCount = Object.values(settings.telegramAlertRules || {}).filter(times => times.length).length;
  const reminders = (settings.telegramAlertResetExpiry ? settings.telegramResetReminderHours?.length || 0 : 0)
    + Object.entries(settings.telegramQuotaReminderHours || {}).reduce((count, [key, times]) => count + (settings.telegramQuotaWindows?.includes(key) ? times.length : 0), 0);
  $("#alertsOverview").textContent = settings.telegramConfigured
    ? settings.telegramAlertsEnabled ? `${eventCount} event types configured · ${reminders} reset reminder${reminders === 1 ? "" : "s"}.`
      : "Telegram alerts are off. Your notification settings are saved."
    : "Configure Telegram credentials on the server to enable notifications.";
  const rules = settings.telegramAlertRules || {};
  const ruleTimes = key => {
    const count = (rules[key] || []).length;
    return `${count} notification time${count === 1 ? "" : "s"}`;
  };
  const thresholds = settings.telegramQuotaWarningPercents || [];
  const resetReminders = Object.values(settings.telegramQuotaReminderHours || {}).reduce((count, times) => count + times.length, 0);
  const expiryReminders = (settings.telegramResetReminderHours || []).length;
  const summary = [
    ["Quota warnings", thresholds.length ? `At ${thresholds.map(value => `${value}%`).join(", ")} used · ${ruleTimes("quota-threshold")}` : "No warning thresholds"],
    ["Quota resets", `${resetReminders} reminders before resets · ${ruleTimes("quota-reset")} after reset`],
    ["Reset credits", `${settings.telegramAlertResetExpiry ? `${expiryReminders} expiry reminder${expiryReminders === 1 ? "" : "s"}` : "Expiry reminders off"} · ${ruleTimes("reset-credit-count")} when the count changes`],
    ["Reserve status", `Active: ${ruleTimes("reserve-active")} · Recovered: ${ruleTimes("reserve-recovered")}`],
    ["Failures", `Sign-in: ${ruleTimes("auth-failure")} · Scheduled sends: ${ruleTimes("send-failure")}`]
  ];
  $("#alertRulesSummary").innerHTML = summary.map(([title, detail], index) => `<div class="alert-summary-row"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p></div><button type="button" data-edit-alert-section="${index}" aria-label="Edit ${escapeHtml(title.toLowerCase())}">Edit</button></div>`).join("");
}

function markAlertsDirty() {
  state.alertsDirty = true;
  state.alertsRevision += 1;
  $("#editAlertsBtn").textContent = "Continue editing alerts";
  feedback("alertsMessage", "Unsaved changes in alerts editor.");
  feedback("alertsFormMessage", "Unsaved changes.");
}

async function refreshSettings() {
  const settings = await api("/api/settings");
  fillSettings(settings);
}

function stringifyPayload(payload) {
  if (!payload || Object.keys(payload).length === 0) {
    return "";
  }
  return JSON.stringify(payload, null, 2);
}

function activityTone(event) {
  const turn = event.payload?.turn;
  if (event.severity === "error" || event.message === "turn/failed" || turn?.status === "failed" || turn?.error
    || (event.message === "thread/status/changed" && event.payload?.status?.type === "systemError")) return "error";
  if (event.severity === "warn" || ["turn/cancelled", "turn/interrupted"].includes(event.message)
    || ["cancelled", "interrupted"].includes(turn?.status)) return "warn";
  if (event.message === "turn/completed" && turn?.status === "completed") return "success";
  if (event.message === "turn/started" || event.message === "Started Codex turn") return "active";
  return "info";
}

function eventPriority(event) {
  if (["error", "warn"].includes(activityTone(event))) {
    return true;
  }
  if (event.message === "Device login output") return false;
  if (event.source === "refresh" && event.message === "State refresh completed") return false;
  if (event.source === "server" && ["Service starting", "Web server listening"].includes(event.message)) return false;
  if (event.source !== "codex") return true;
  return new Set([
    "turn/started",
    "turn/completed",
    "turn/failed",
    "turn/cancelled",
    "turn/interrupted",
    "item/completed"
  ]).has(event.message);
}

function shouldShowEvent(event, showRawEvents = state.showRawEvents) {
  if (showRawEvents) {
    return true;
  }
  if (event.message === "Device login output" || !eventPriority(event)) {
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

  if (event.severity === "error" && !event.message?.startsWith("turn/")) {
    return {
      kind: "error",
      title: event.message || "Error",
      body: compactText(payload.error?.message || payload.error || payload.message || stringifyPayload(payload), ""),
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
      body: "",
      tags: [],
      payload
    };
  }

  if (["turn/completed", "turn/failed", "turn/cancelled", "turn/interrupted"].includes(event.message)) {
    const tone = activityTone(event);
    const status = payload.turn?.status || event.message.split("/")[1];
    const title = tone === "error" ? "Turn failed"
      : tone === "warn" ? status === "cancelled" ? "Turn cancelled" : "Turn interrupted" : "Turn completed";
    const error = payload.turn?.error || payload.error;
    const message = typeof error === "string" ? error : error?.message;
    const duration = Number.isFinite(payload.turn?.durationMs) ? formatDuration(payload.turn.durationMs) : null;
    return {
      kind: "turn",
      title,
      body: [duration, message].filter(Boolean).join(" · "),
      tags: [],
      payload: {
        ...payload,
        status,
        duration,
        error,
        threadId: payload.threadId,
        turnId: payload.turn?.id || payload.turnId
      }
    };
  }

  if (event.message === "Started Codex turn") {
    return {
      kind: "turn",
      title: payload.reason === "manual" ? "Manual run started" : "Scheduled run started",
      body: payload.reason === "manual" ? "" : `Reason: ${payload.reason || "unknown"}`,
      tags: [],
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
  const events = [...state.activityEvents].filter((event) => !state.hiddenActivityIds.has(event.id) && shouldShowEvent(event)).slice(state.showRawEvents ? -300 : -40).reverse();
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
    item.className = `activity-item ${activityTone(event)} ${summary.kind || "system"}`;
    item.dataset.eventId = event.id;
    const payload = stringifyPayload(summary.payload);
    const tags = [accountTag, ...(summary.tags || [])]
      .filter((tag) => tag && (state.showRawEvents || !["info", "codex", "ok"].includes(tag)) && !tag.startsWith("turn ") && !tag.startsWith("thread "))
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
    item.textContent = state.showRawEvents ? "No activity yet." : "No recent runs or changes. Routine updates are in Raw events.";
    list.append(item);
  }
  $("#activityHint").textContent = state.showRawEvents
    ? "Showing all raw app-server and service events."
    : "Recent runs, messages, settings, and errors. Routine updates are in Raw events.";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loginPresentation(session, now = Date.now()) {
  if (!session || session.status === "none") return { status: "none", code: "", url: "" };
  const output = (session.output || []).map((entry) => entry.text || "").join("").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const rawUrl = (output.match(/https?:\/\/[^\s<>"']+/g) || []).find((value) => {
    try {
      const url = new URL(value);
      return url.origin === "https://auth.openai.com" && url.pathname === "/codex/device" && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }) || "";
  const code = output.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/)?.[0] || "";
  const minutes = Number(output.match(/expires? in\s+(\d+)\s+minutes?/i)?.[1]);
  const expired = session.status === "running" && minutes > 0 && Number.isFinite(Date.parse(session.startedAt))
    && now >= Date.parse(session.startedAt) + minutes * 60_000;
  return { status: expired ? "expired" : session.status, code: session.status === "running" && !expired ? code : "", url: rawUrl };
}

function renderAccountAccess() {
  const account = state.accounts.find((item) => item.id === state.selectedAccountId);
  const auth = account?.auth || {};
  const uncertain = auth.probeUnavailable || auth.logoutConfirmationPending;
  $(".account-access-head").hidden = Boolean(auth.loggedIn && !auth.authIssue && !uncertain && state.loginSession?.status !== "running");
  $("#accountAccessTitle").textContent = auth.loggedIn ? `Connected to ${account.label}` : `Connect ${account?.label || "an account"}`;
  $("#accountAccessHint").textContent = auth.logoutConfirmationPending ? "Confirming this account’s sign-in status…"
    : auth.probeUnavailable ? "The latest sign-in check is unavailable. Refresh to check again."
    : auth.loggedIn ? "Ready for messages. Scheduled sends follow the switch below."
      : auth.authIssue ? "Your sign-in needs attention. Sign in again to reconnect." : "Sign in with ChatGPT to read usage and send messages.";
  $("#deviceLoginBtn").hidden = Boolean(auth.loggedIn && !auth.authIssue && !uncertain);
  $("#deviceLoginBtn").textContent = auth.authIssue ? "Sign in again" : "Sign in";
  const session = state.loginSession?.accountId === account?.id ? state.loginSession : null;
  if (!session || session.status === "none") {
    $("#loginProgress").hidden = true;
    return;
  }
  const view = loginPresentation(session);
  if (view.status === "running") {
    $("#accountAccessTitle").textContent = `Connecting ${account.label}`;
    $("#accountAccessHint").textContent = "Follow the steps below to connect this account.";
    $("#deviceLoginBtn").hidden = true;
  }
  $("#loginProgress").hidden = false;
  $("#loginProgress").dataset.state = view.status;
  const copy = {
    running: [view.code ? "Finish signing in" : "Preparing sign-in", view.code ? "Enter your code on OpenAI’s sign-in page." : "Waiting for a sign-in code from Codex…", "Waiting", "neutral"],
    completed: ["Sign-in complete", "You can now send messages and enable scheduled sends.", "Connected", "ok"],
    failed: ["Sign-in did not complete", "Try signing in again. Open diagnostics if you need the details.", "Try again", "bad"],
    expired: ["Sign-in code expired", "Wait for this sign-in attempt to finish, then sign in again for a new code.", "Expired", "warn"]
  }[view.status] || ["Sign-in status", "Check diagnostics for details.", "Unknown", "neutral"];
  $("#loginTitle").textContent = copy[0];
  $("#loginHint").textContent = copy[1];
  badge($("#loginStatus"), copy[2], copy[3]);
  $("#loginSteps").hidden = !(view.status === "running" && view.code && view.url);
  $("#loginCode").textContent = view.code;
  if (view.status === "running" && view.url) $("#loginLink").href = view.url;
  else $("#loginLink").removeAttribute("href");
  if (view.status !== "running") feedback("loginMessage", "");
}

function renderLoginOutput(session) {
  if (!session || session.accountId !== selectedAccountId()) return;
  if (state.loginSession?.status !== session.status || state.loginSession?.id !== session.id) $(".login-diagnostics").open = false;
  state.loginSession = session;
  // Terminal output is text only and is never stored in browser snapshots.
  $("#loginOutput").textContent = (session.output || []).map((entry) => `[${entry.stream}] ${entry.text}`).join("\n");
  renderAccountAccess();
  updateAccountControls();
}

async function refreshLoginSession() {
  const accountId = selectedAccountId();
  if (!accountId) return;
  const session = await api(`/api/auth/device/current?accountId=${encodeURIComponent(accountId)}`);
  if (accountId === selectedAccountId()) renderLoginOutput(session);
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
      dateLine.textContent = `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}`;
      $("#clockTimezone").textContent = timezone.replaceAll("_", " ");
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
  $(".next-module").dataset.state = schedulerEnabled ? "enabled" : "paused";
  const signature = `${time}|${day}`;
  if (strip.dataset.signature === signature) {
    return;
  }
  const chars = time.replace(":", "");
  const previous = strip.dataset.chars || "";
  strip.dataset.signature = signature;
  strip.dataset.chars = chars;
  strip.innerHTML = "";
  [...chars].forEach((char, index) => {
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
  host.style.setProperty("--board-columns", String(Math.max(times.length, 1)));
  if (!accounts.length || !times.length) {
    host.innerHTML = '<p class="board-empty">No enabled accounts with schedule times. Enable one in Accounts or Schedule.</p>';
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
  if (tierA === 3) {
    const freeA = effectiveWindow(winA, now).free;
    const freeB = effectiveWindow(winB, now).free;
    if (freeA !== freeB) {
      return freeB - freeA;
    }
  }
  return String(a.label).localeCompare(String(b.label));
}

function quotaLevel(remaining) {
  return !Number.isFinite(remaining) ? "unknown" : remaining > 70 ? "good" : remaining >= 30 ? "caution" : "low";
}

function resetIsSoon(resetMs, now) {
  return Number.isFinite(resetMs) && resetMs > now && resetMs - now < 60 * 60 * 1000;
}

function renderFleet() {
  const rowsHost = $("#fleetRows");
  const timetableHost = $("#fleetTimetable");
  const weeklyHorizonHost = $("#fleetWeeklyHorizon");
  if (!rowsHost || !timetableHost || !weeklyHorizonHost) {
    return;
  }
  const now = Date.now();
  const accounts = [...state.accounts].sort((a, b) => compareFleetAccounts(a, b, now));
  const accountReadings = accounts.map((account) => ({ account, win: accountWindow(account) }));
  const readings = accountReadings.filter(
    (entry) => entry.account.auth?.loggedIn && isFreshWindow(entry.win, now)
  );
  const staleReadings = accountReadings.filter(
    (entry) => entry.account.auth?.loggedIn
      && effectiveWindow(entry.win, now)
      && !isFreshWindow(entry.win, now)
  );
  const trackedReadings = accountReadings.filter(
    (entry) => entry.account.auth?.loggedIn && entry.win
  );
  const authIssues = accounts.filter((account) => account.auth?.authIssue);
  const loggedOut = accounts.filter((account) => !account.auth?.loggedIn && !account.auth?.authIssue);
  const weeklyReadings = accountReadings.filter(
    (entry) => entry.account.auth?.loggedIn
      && entry.win?.secondary?.hasData
      && Number(entry.win.secondary.resetsAt) * 1000 > now
  );
  const reserveReadings = accountReadings.filter(
    (entry) => entry.account.auth?.loggedIn
      && entry.win?.reserve?.weekly?.hasData
      && reserveState(entry.win, now) !== "stale"
  );
  const reserveReady = reserveReadings.filter((entry) => entry.win.reserve.weekly.free > 0);
  const reserveActive = reserveReadings.filter((entry) => reserveState(entry.win, now) === "active");
  const nearLimit = readings.filter((entry) => effectiveWindow(entry.win, now).used >= NEAR_LIMIT_USED);
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
    win?.secondary?.resetsAt ?? "",
    win?.ordinaryUsageAllowed ?? "",
    win?.reserve?.weekly?.used ?? "",
    win?.reserve?.weekly?.resetsAt ?? ""
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

  const meanFree = readings.length
    ? Math.round(readings.reduce((sum, entry) => sum + effectiveWindow(entry.win, now).free, 0) / readings.length)
    : null;
  const weeklyMeanFree = weeklyReadings.length
    ? Math.round(weeklyReadings.reduce((sum, entry) => sum + entry.win.secondary.free, 0) / weeklyReadings.length)
    : null;
  for (const [id, remaining] of [["fleetMeanFree", meanFree], ["fleetWeeklyMeanFree", weeklyMeanFree]]) {
    const value = $("#" + id);
    value.textContent = remaining === null ? "—" : `${remaining}%`;
    value.closest(".fleet-stat").dataset.quotaLevel = quotaLevel(remaining);
  }
  $("#fleetReserveReady").textContent = reserveReadings.length
    ? `${reserveReady.length}/${reserveReadings.length}`
    : "—";
  $("#fleetReserveLabel").textContent = reserveActive.length
    ? `reserve ready · ${reserveActive.length} active`
    : "reserve ready";
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
  } else if (!trackedReadings.length && !authIssues.length && !loggedOut.length) {
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
    if (authIssues.length) {
      issues.push(`${authIssues.length} auth issue${authIssues.length === 1 ? "" : "s"}`);
    }
    if (loggedOut.length) {
      issues.push(`${loggedOut.length} logged out`);
    }
    fleetBadge.textContent = issues.join(" · ") || "All clear";
    fleetBadge.className = `badge ${nearLimit.length || authIssues.length ? "bad" : staleReadings.length || loggedOut.length ? "warn" : "ok"}`;
  }

  const focusedCreditId = rowsHost.contains(document.activeElement) ? document.activeElement.id : null;
  rowsHost.innerHTML = !accounts.length
    ? '<p class="board-empty">No accounts configured yet. Add one in Accounts.</p>'
    : accounts.map((account) => {
        const win = accountWindow(account);
        const resetCredits = accountResetCredits(account);
        const loggedIn = Boolean(account.auth?.loggedIn);
        let rowClasses = "strip-row";
        let trackCell;
        let metaCell = "";
        const labelCell = `
          <span class="strip-label-stack">
            <span class="strip-label"><a class="account-name-link" href="#account" data-open-account="${escapeHtml(account.id)}">${escapeHtml(account.label)}</a></span>
            <span class="account-row-state">${account.enabled ? "Scheduled sends on" : "Scheduled sends off"}</span>
            ${win?.planType && win.planType !== "unknown" ? `<span class="mini-badge neutral strip-plan">${escapeHtml(win.planType)}</span>` : ""}
          </span>`;
        if (account.auth?.authIssue) {
          rowClasses += " muted";
          trackCell = `<span class="strip-note" title="${escapeHtml(account.auth.detail || "Authentication failed")}">authentication issue - re-login from Accounts</span>`;
        } else if (!loggedIn) {
          rowClasses += " muted";
          trackCell = '<span class="strip-note">logged out — re-login from Accounts</span>';
        } else if (!win) {
          rowClasses += " muted";
          trackCell = '<span class="strip-note">no reading yet — waiting for a live quota refresh</span>';
        } else {
          const current = effectiveWindow(win, now);
          const reserve = win.reserve?.weekly;
          const reserveMode = reserveState(win, now);
          const fresh = current ? isFreshWindow(win, now) : false;
          if (fresh && current?.used >= NEAR_LIMIT_USED) {
            rowClasses += " near";
          }
          if (current && !fresh) {
            rowClasses += " stale";
          }
          if (!account.enabled) {
            rowClasses += " muted";
          }
          trackCell = `
            <div class="strip-cell">
              ${current ? `
              <div class="strip-track" data-quota-level="${quotaLevel(fresh ? current.free : null)}" role="img" aria-label="${escapeHtml(
                fresh
                  ? `${account.label}: ${current.free}% of the limiting quota remaining`
                  : `${account.label}: stale reading, last reported ${current.free}% remaining`
              )}">
                <div class="strip-fill" style="width:${current.free}%"></div>
              </div>` : '<span class="strip-note">ordinary quota not reported</span>'}
              ${win.secondary?.hasData ? `
              <div class="strip-week ${Number(win.secondary.resetsAt) * 1000 > now ? "" : "stale"}">
                <span class="week-tag">wk</span>
                <div class="week-track" data-quota-level="${quotaLevel(Number(win.secondary.resetsAt) * 1000 > now ? win.secondary.free : null)}" role="img" aria-label="${escapeHtml(
                  Number(win.secondary.resetsAt) * 1000 > now
                    ? `${account.label} weekly window: ${win.secondary.free}% remaining`
                    : `${account.label} weekly window: stale reading, last reported ${win.secondary.free}% remaining`
                )}">
                  <div class="week-fill" style="width:${win.secondary.free}%"></div>
                </div>
                <span class="week-free" data-week-free="${win.secondary.free}">${win.secondary.free}% ${Number(win.secondary.resetsAt) * 1000 > now ? "remaining" : "last"}</span>
                <span class="week-reset">${
                  win.secondary.resetsAt
                    ? `<span data-week-resets="${win.secondary.resetsAt}" title="Weekly quota reset: ${escapeHtml(formatUnixSeconds(win.secondary.resetsAt))}"></span>`
                    : "reset unknown"
                }</span>
              </div>` : ""}
              ${reserve?.hasData ? `
              <div class="strip-week strip-reserve reserve-${reserveMode}">
                <span class="week-tag">reserve</span>
                <div class="week-track" data-quota-level="${quotaLevel(reserveMode !== "stale" ? reserve.free : null)}" role="img" aria-label="${escapeHtml(
                  `${account.label} Reserve weekly allowance: ${reserve.free}% remaining, ${reserveMode}`
                )}">
                  <div class="week-fill" style="width:${reserve.free}%"></div>
                </div>
                <span class="week-free">${reserve.free}% remaining</span>
                <span class="week-reset" title="${escapeHtml(Number.isFinite(reserve.resetsAt) ? `Luna Reserve resets ${formatUnixSeconds(reserve.resetsAt)}` : "Luna Reserve reset not reported")}">${reserveMode}${win.reserve.model ? ` · ${escapeHtml(win.reserve.model)}` : ""}${Number.isFinite(reserve.resetsAt) ? ` · resets ${escapeHtml(fmtWeeklyReset(reserve.resetsAt * 1000))}` : " · reset unknown"}</span>
              </div>` : ""}
            </div>`;
          metaCell = current ? `
            <div class="strip-meta">
              <span class="free-num">${current.free}<small>${fresh ? "% remaining" : "% last reported"}</small></span>
              <span class="reset-line">${
                current.resetsAt
                  ? `<span data-resets="${current.resetsAt}" title="${
                      fresh ? "Window resets at this time" : "Reading expired; waiting for Codex to report the next window"
                    }"></span>`
                  : "reset unknown"
              }</span>
            </div>` : "";
        }
        return `<div class="${rowClasses}" data-account-row="${escapeHtml(account.id)}">${labelCell}${trackCell}${metaCell}${resetCreditStack(resetCredits, account.id, now)}</div>`;
      }).join("");

  filterAccountRows();
  if (focusedCreditId) document.getElementById(focusedCreditId)?.focus({ preventScroll: true });

  const weeklyHorizonLanes = accountReadings.map(({ account, win }) => {
    if (!account.auth?.loggedIn) {
      return null;
    }
    const resets = [
      { kind: "ordinary", short: "WK", label: "Weekly", resetsAt: win?.secondary?.resetsAt },
      { kind: "reserve", short: "R", label: "Reserve", resetsAt: win?.reserve?.weekly?.resetsAt }
    ].filter((reset) => {
      const resetMs = Number(reset.resetsAt) * 1000;
      return Number.isFinite(resetMs) && resetMs > now && resetMs <= now + WEEKLY_HORIZON_MS;
    }).sort((a, b) => a.resetsAt - b.resetsAt);
    return resets.length ? { account, resets } : null;
  }).filter(Boolean).sort((a, b) =>
    Math.min(...a.resets.map((reset) => reset.resetsAt))
      - Math.min(...b.resets.map((reset) => reset.resetsAt)));
  weeklyHorizonHost.innerHTML = !weeklyHorizonLanes.length
    ? '<p class="tt-empty">No weekly reset dates reported in the next seven days.</p>'
    : `
      <div class="weekly-horizon-lane weekly-horizon-scale" aria-hidden="true">
        <span class="weekly-horizon-name">account / exact reset</span>
        <div class="weekly-horizon-axis">
          ${Array.from({ length: 7 }, (_, index) => `
            <span class="weekly-day" style="left:${(index / 7) * 100}%">${escapeHtml(fmtHorizonDay(now + index * 24 * 60 * 60 * 1000))}</span>
          `).join("")}
        </div>
      </div>
      ${weeklyHorizonLanes.map(({ account, resets }) => `
        <div class="weekly-horizon-lane">
          <div class="weekly-horizon-name">
            <strong title="${escapeHtml(account.label)}">${escapeHtml(account.label)}</strong>
            <span class="weekly-horizon-dates">
              ${resets.map((reset) => `<span class="${reset.kind}"><b>${reset.short}</b> ${escapeHtml(fmtWeeklyReset(Number(reset.resetsAt) * 1000))}</span>`).join("")}
            </span>
          </div>
          <div class="weekly-horizon-axis">
            ${resets.map((reset) => `
              <span
                class="weekly-horizon-marker ${reset.kind}"
                data-weekly-horizon-reset="${reset.resetsAt}"
                data-marker="${reset.short}"
                title="${escapeHtml(`${account.label} ${reset.label} resets ${formatUnixSeconds(reset.resetsAt)}`)}"
                aria-label="${escapeHtml(`${account.label} ${reset.label} resets ${formatUnixSeconds(reset.resetsAt)}`)}"
                role="img"
              ></span>
            `).join("")}
          </div>
        </div>
      `).join("")}`;

  const lanes = accounts.filter((account) => {
    const resetsAt = effectiveWindow(accountWindow(account), now)?.resetsAt;
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
        const resetsAt = effectiveWindow(accountWindow(account), now).resetsAt;
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
  for (const card of document.querySelectorAll(".reset-credit-stack[data-credit-account]")) {
    const account = state.accounts.find(item => item.id === card.dataset.creditAccount);
    if (!account) continue;
    const credits = accountResetCredits(account);
    if (card.dataset.creditSignature !== JSON.stringify([resetCreditPresentation(credits, now), resetCreditItems(credits, now)])) {
      const focusedCreditId = card.contains(document.activeElement) ? document.activeElement.id : null;
      card.outerHTML = resetCreditStack(credits, account.id, now, card.dataset.creditContext);
      if (focusedCreditId) document.getElementById(focusedCreditId)?.focus({ preventScroll: true });
    }
  }
  syncResetCreditDecks();


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
    el.classList.toggle("reset-soon", resetIsSoon(resetMs, now));
    if (resetMs <= now) {
      const track = el.closest(".strip-row")?.querySelector(".strip-track");
      if (track) track.dataset.quotaLevel = "unknown";
    }
    el.title = resetMs > now
      ? "Window resets at this time"
      : "Reading expired; waiting for Codex to report the next window";
  });

  document.querySelectorAll("#fleetRows [data-week-resets]").forEach((el) => {
    const resetMs = Number(el.dataset.weekResets) * 1000;
    const stale = resetMs <= now;
    const row = el.closest(".strip-week");
    row?.classList.toggle("stale", stale);
    el.classList.toggle("reset-soon", resetIsSoon(resetMs, now));
    if (stale) {
      const track = row?.querySelector(".week-track");
      if (track) track.dataset.quotaLevel = "unknown";
    }
    const free = row?.querySelector("[data-week-free]");
    if (free) {
      free.textContent = `${free.dataset.weekFree}% ${stale ? "last" : "free"}`;
    }
    el.textContent = `${fmtWeeklyReset(resetMs)} · ${fmtCountdown(resetMs - now)}`;
  });

  document.querySelectorAll("#fleetWeeklyHorizon [data-weekly-horizon-reset]").forEach((el) => {
    const resetMs = Number(el.dataset.weeklyHorizonReset) * 1000;
    const position = clampPercent(((resetMs - now) / WEEKLY_HORIZON_MS) * 100);
    el.style.left = `${Math.max(1.5, Math.min(98.5, position))}%`;
  });

  const nextResetsAt = state.accounts
    .filter((account) => account.enabled && account.auth?.loggedIn)
    .map((account) => effectiveWindow(accountWindow(account), now)?.resetsAt)
    .filter((resetsAt) => Number.isFinite(resetsAt) && resetsAt * 1000 > now)
    .sort((a, b) => a - b)[0];
  $("#fleetNextReset").closest(".fleet-stat").classList.toggle("reset-soon", resetIsSoon(nextResetsAt * 1000, now));
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
      void refreshStatus().catch(() => {});
      if (event.payload?.accountId) {
        void loadUsageHistory(event.payload.accountId, true);
      }
    }
  });
  events.addEventListener("login", async () => {
    await Promise.allSettled([refreshLoginSession(), refreshStatus()]);
  });
  events.addEventListener("status", async () => {
    await Promise.allSettled([refreshStatus(), loadFleetUsageHistory(true)]);
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

function scheduleSettingsBody() {
  const scheduleTimes = $("#scheduleInput").value.split(",").map(time => time.trim()).filter(Boolean);
  return {
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
}

function alertSettingsBody() {
  return {
    telegramAlertsEnabled: $("#telegramEnabledInput").checked,
    telegramQuotaWarningPercents: numberRowValues("telegramQuotaThresholdRows").map(Number),
    telegramQuotaWindows: QUOTA_WINDOWS.filter(window => ({ "5h": $("#telegramWatch5hInput").checked, weekly: $("#telegramWatchWeeklyInput").checked, reserve: $("#telegramWatchReserveInput").checked }[window])),
    telegramQuotaReminderHours: Object.fromEntries(QUOTA_WINDOWS.map(window => [window, numberRowValues(REMINDER_IDS[window]).map(Number)])),
    telegramAlertRules: Object.fromEntries(Object.entries(ALERT_RULES).map(([key, config]) => [key, numberRowValues(config[0]).map(Number)])),
    telegramResetReminderHours: telegramExpiryReminderValues().map(Number),
    telegramAlertResetExpiry: $("#telegramResetExpiryInput").checked
  };
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const alerts = form.id === "alertsForm";
  if (alerts) validateAllAlertNumbers();
  const invalid = form.querySelector("input:invalid, select:invalid, textarea:invalid");
  if (invalid) {
    const panel = invalid.closest("[role=tabpanel]");
    if (panel) selectSettingsTab(panel.id.replace("-tab-panel", ""));
    const disclosure = invalid.closest("details");
    if (disclosure) disclosure.open = true;
    invalid.reportValidity();
    invalid.focus();
    return;
  }
  const body = alerts ? alertSettingsBody() : scheduleSettingsBody();
  const revisionKey = alerts ? "alertsRevision" : "settingsRevision";
  const dirtyKey = alerts ? "alertsDirty" : "settingsDirty";
  const formMessage = alerts ? "alertsFormMessage" : "settingsMessage";
  const panelMessage = alerts ? "alertsMessage" : "scheduleMessage";
  const editButton = alerts ? $("#editAlertsBtn") : $("#editScheduleBtn");
  const dialog = alerts ? $("#alertsDialog") : $("#scheduleDialog");
  const revision = state[revisionKey];
  await buttonAction(form.querySelector("button[type=submit]"), formMessage, async () => {
    feedback(formMessage, "Saving…");
    const settings = await api("/api/settings", { method: "PATCH", body: JSON.stringify(body) });
    state.settings = settings;
    if (revision === state[revisionKey]) {
      state[dirtyKey] = false;
      fillSettings(settings);
      feedback(formMessage, "Saved.", "success");
      feedback(panelMessage, alerts ? "Alerts saved." : "Schedule saved.", "success");
      editButton.textContent = alerts ? "Configure alerts" : "Edit schedule";
      dialog.close();
    } else {
      fillSettings(settings);
      feedback(formMessage, "Saved. Your newer edits are still unsaved.");
    }
    await refreshStatus();
  });
}

async function runNow(prompt = null) {
  const body = { accountId: selectedAccountId() };
  if (prompt) {
    body.prompt = prompt;
  }
  return api("/api/run-now", { method: "POST", body: JSON.stringify(body) });
}

async function sendMessage(button, messageId, prompt = null) {
  if (state.sendBusy || state.accountBusy) return;
  state.sendBusy = true;
  updateAccountControls();
  $("#runNowBtn").disabled = $("#manualSendBtn").disabled = true;
  try {
    await buttonAction(button, messageId, async () => {
      feedback(messageId, "Starting turn…");
      const run = await runNow(prompt);
      const description = run.status === "failed" ? run.error || "Turn failed to start. Check Activity for details."
        : run.status === "skipped_active_turn" ? "A turn is already running. No new message was sent."
        : run.status === "completed" ? "Turn completed. See Activity for the reply." : "Turn started. Follow its progress in Activity.";
      feedback(messageId, description, run.status === "failed" ? "error" : run.status === "completed" ? "success" : "neutral");
      await refreshStatus();
    });
  } finally { state.sendBusy = false; updateAccountControls(); }
}

async function setScheduler(enabled) {
  if (state.schedulerBusy) return;
  state.schedulerBusy = true;
  renderSchedulerToggle();
  feedback("schedulerMessage", enabled ? "Resuming…" : "Pausing…");
  try {
    await api(`/api/scheduler/${enabled ? "resume" : "pause"}`, { method: "POST", body: "{}" });
    feedback("schedulerMessage", enabled ? "Scheduler resumed." : "Scheduler paused.", "success");
    await refreshStatus();
  } catch (error) { feedback("schedulerMessage", error.message, "error"); }
  finally {
    state.schedulerBusy = false;
    renderSchedulerToggle();
  }
}

async function removeConfirmedAccount() {
  if (state.removalBusy) return;
  if (state.accountBusy || state.sendBusy) {
    feedback("removeAccountMessage", "Wait for the current action to finish, then try again.");
    return;
  }
  const target = state.removalTarget;
  if (!target) return;
  if (!state.accounts.some(account => account.id === target.id) || state.accounts.length <= 1) {
    feedback("removeAccountMessage", "This account can no longer be removed. Close this dialog and refresh the account list.", "error");
    return;
  }
  state.removalBusy = state.accountBusy = true;
  state.removingAccountIds.add(target.id);
  state.statusRequestId += 1;
  const button = $("#confirmRemoveAccountBtn");
  button.textContent = "Removing…";
  button.setAttribute("aria-busy", "true");
  feedback("removeAccountMessage", `Removing ${target.label}…`);
  updateAccountControls();
  for (const [key, controller] of state.usageHistoryControllers) {
    if (!key.startsWith(`${target.id}:`)) continue;
    state.usageHistoryRefreshQueued.delete(key);
    controller.abort();
  }
  let removed = false;
  try {
    let result;
    try {
      result = await api(`/api/accounts/${encodeURIComponent(target.id)}`, { method: "DELETE" });
    } catch (error) {
      // A lost response does not mean deletion failed. Reconcile before offering a retry.
      const accounts = await api("/api/accounts").catch(() => null);
      if (!accounts) throw new Error("Removal could not be confirmed. Refresh the account list before trying again.");
      if (accounts.accounts.some(account => account.id === target.id)) throw error;
      result = accounts;
    }
    state.statusRequestId += 1;
    state.selectedAccountId = result.selectedAccountId;
    state.accounts = result.accounts;
    state.accountDrafts.delete(target.id);
    try {
      localStorage.removeItem(STATUS_SNAPSHOT_STORAGE_KEY);
      const histories = JSON.parse(localStorage.getItem(USAGE_HISTORY_SNAPSHOT_STORAGE_KEY) || "{}");
      delete histories[target.id];
      localStorage.setItem(USAGE_HISTORY_SNAPSHOT_STORAGE_KEY, JSON.stringify(histories));
    } catch {}
    renderAccounts();
    $("#removeAccountDialog").close();
    feedback("accountMessage", `Removed ${target.label}.`, "success");
    removed = true;
  } catch (error) {
    feedback("removeAccountMessage", error.message, "error");
  } finally {
    state.removingAccountIds.delete(target.id);
    state.removalBusy = state.accountBusy = false;
    button.textContent = "Remove account";
    button.removeAttribute("aria-busy");
    updateAccountControls();
  }
  if (removed) {
    $("#accountSelect").focus({ preventScroll: true });
    const results = await Promise.allSettled([refreshStatus(), refreshLoginSession(), refreshActivity()]);
    if (results.some(result => result.status === "rejected") && $("#accountMessage").textContent === `Removed ${target.label}.`) {
      feedback("accountMessage", `Removed ${target.label}. Some details could not refresh; use Refresh to update them.`);
    }
  }
}

function resetCreditCapacity(width, edge) {
  return Math.max(1, Math.min(4, 1 + Math.floor((width - 160) / edge)));
}

let resetCreditResizeObserver;
const observedResetCreditStacks = new Set();

function syncResetCreditDecks() {
  const stacks = new Set(document.querySelectorAll(".reset-credit-stack"));
  if (!resetCreditResizeObserver && typeof ResizeObserver !== "undefined") {
    resetCreditResizeObserver = new ResizeObserver(entries => {
      for (const { target } of entries) layoutResetCreditDeck(target);
    });
  }
  for (const stack of observedResetCreditStacks) {
    if (stacks.has(stack)) continue;
    resetCreditResizeObserver?.unobserve(stack);
    observedResetCreditStacks.delete(stack);
  }
  for (const stack of stacks) {
    if (!observedResetCreditStacks.has(stack)) {
      observedResetCreditStacks.add(stack);
      resetCreditResizeObserver?.observe(stack);
    }
    layoutResetCreditDeck(stack);
  }
}

function layoutResetCreditDeck(stack) {
  const key = `${stack.dataset.creditContext}:${stack.dataset.creditAccount}`;
  selectResetCredit(stack, state.resetCreditHovers.get(key) ?? state.resetCreditSelections.get(key) ?? 0);
}

function selectResetCredit(stack, index, persist = false) {
  const cards = [...stack.querySelectorAll(".reset-credit-card")];
  if (!cards.length) return;
  const selected = Math.max(0, Math.min(cards.length - 1, index));
  const key = `${stack.dataset.creditContext}:${stack.dataset.creditAccount}`;
  if (persist) state.resetCreditSelections.set(key, selected);
  const deck = stack.querySelector(".reset-credit-deck");
  const width = deck.getBoundingClientRect().width;
  const edge = parseFloat(getComputedStyle(deck).getPropertyValue("--credit-edge")) || 24;
  const capacity = width > 0 ? resetCreditCapacity(width, edge) : Number(stack.dataset.creditCapacity) || 2;
  const start = Math.floor(selected / capacity) * capacity;
  const end = Math.min(cards.length, start + capacity);
  stack.dataset.creditCapacity = String(capacity);
  stack.dataset.creditStart = String(start);
  for (const card of cards) {
    const cardIndex = Number(card.dataset.creditIndex);
    const active = Number(card.dataset.creditIndex) === selected;
    const wasFront = card.dataset.front === "true";
    card.hidden = cardIndex < start || cardIndex >= end;
    card.setAttribute("aria-pressed", String(active));
    card.tabIndex = active ? 0 : -1;
    card.dataset.front = String(active);
    card.dataset.creditSide = cardIndex < selected ? "before" : "after";
    card.dataset.creditFirst = String(cardIndex === start);
    card.dataset.creditLast = String(cardIndex === end - 1);
    card.style.setProperty("--credit-before", cardIndex - start);
    card.style.setProperty("--credit-after", end - 1 - cardIndex);
    card.style.setProperty("--credit-layer", cardIndex < selected ? cardIndex - start : end - cardIndex);
    card.querySelector(".reset-credit-content").setAttribute("aria-hidden", String(!active));
    if (active !== wasFront) {
      for (const animation of card.getAnimations()) if (animation.id === "reset-credit-slide") animation.cancel();
      if (active && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        card.animate([{ transform: "translate(12px, 0)" }, { transform: "translate(0, -2px)" }], {
          id: "reset-credit-slide", duration: 520, easing: "cubic-bezier(.25,.65,.3,1)"
        });
      }
    }
  }
  const pagination = stack.querySelector(".reset-credit-pagination");
  if (pagination) {
    pagination.hidden = cards.length <= capacity;
    const label = pagination.querySelector(".reset-credit-page-label");
    const text = `${start + 1}–${end} of ${cards.length}`;
    if (label.textContent !== text) label.textContent = text;
    pagination.querySelector('[data-credit-page="previous"]').disabled = start === 0;
    pagination.querySelector('[data-credit-page="next"]').disabled = end === cards.length;
  }
}

function bindResetCreditDecks() {
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-credit-page]");
    if (!button || button.disabled) return;
    const stack = button.closest(".reset-credit-stack");
    const key = `${stack.dataset.creditContext}:${stack.dataset.creditAccount}`;
    state.resetCreditHovers.delete(key);
    const offset = Number(stack.dataset.creditCapacity) * (button.dataset.creditPage === "next" ? 1 : -1);
    selectResetCredit(stack, Number(stack.dataset.creditStart) + offset, true);
  });
  document.addEventListener("pointerover", event => {
    const tab = event.target.closest(".reset-credit-card[role=button]");
    if (!tab || event.pointerType !== "mouse" || tab.contains(event.relatedTarget)) return;
    const stack = tab.closest(".reset-credit-stack");
    const index = Number(tab.dataset.creditIndex);
    state.resetCreditHovers.set(`${stack.dataset.creditContext}:${stack.dataset.creditAccount}`, index);
    selectResetCredit(stack, index);
  });
  document.addEventListener("pointerout", event => {
    const stack = event.target.closest(".reset-credit-stack");
    if (!stack || stack.contains(event.relatedTarget)) return;
    const key = `${stack.dataset.creditContext}:${stack.dataset.creditAccount}`;
    state.resetCreditHovers.delete(key);
    selectResetCredit(stack, state.resetCreditSelections.get(key) ?? 0);
  });
  for (const type of ["click", "focusin"]) document.addEventListener(type, event => {
    const tab = event.target.closest(".reset-credit-card[role=button]");
    if (!tab) return;
    selectResetCredit(tab.closest(".reset-credit-stack"), Number(tab.dataset.creditIndex), true);
  });
  document.addEventListener("keydown", event => {
    const tab = event.target.closest(".reset-credit-card[role=button]");
    if (!tab) return;
    const stack = tab.closest(".reset-credit-stack");
    const tabs = [...stack.querySelectorAll(".reset-credit-card")];
    const index = Number(tab.dataset.creditIndex);
    const next = ["Enter", " "].includes(event.key) ? index : event.key === "Home" || event.key === "Escape" ? 0 : event.key === "End" ? tabs.length - 1
      : ["ArrowRight", "ArrowDown"].includes(event.key) ? (index + 1) % tabs.length
        : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (index - 1 + tabs.length) % tabs.length : null;
    if (next === null) return;
    event.preventDefault();
    state.resetCreditHovers.delete(`${stack.dataset.creditContext}:${stack.dataset.creditAccount}`);
    selectResetCredit(stack, next, true);
    tabs[next].focus({ preventScroll: true });
    tabs[next].scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function bindActions() {
  bindResetCreditDecks();
  $("#usageHistoryRanges").addEventListener("click", (event) => {
    const button = event.target.closest("[data-range]");
    if (!button || !USAGE_HISTORY_RANGES[button.dataset.range]) {
      return;
    }
    state.usageHistoryRange = button.dataset.range;
    state.usageHistoryCursorByChart.clear();
    renderUsageHistory();
    void loadFleetUsageHistory(true);
  });
  $("#refreshBtn").addEventListener("click", () => {
    void refreshAllState();
  });
  $("#runNowBtn").addEventListener("click", () => void sendMessage($("#runNowBtn"), "runMessage"));
  $("#manualSendBtn").addEventListener("click", () => void sendMessage($("#manualSendBtn"), "manualMessage", $("#manualPromptInput").value.trim() || null));
  $("#schedulerToggleBtn").addEventListener("click", () => void setScheduler(!state.schedulerEnabled));
  $("#editScheduleBtn").addEventListener("click", () => {
    if (!state.settingsDirty) { fillSettings(state.settings); feedback("settingsMessage", ""); }
    selectSettingsTab("schedule");
    $("#scheduleDialog").showModal();
  });
  $("#closeScheduleBtn").addEventListener("click", () => {
    if (!$("#settingsForm button[type=submit]").disabled) $("#scheduleDialog").close();
  });
  $("#scheduleDialog").addEventListener("close", () => $("#editScheduleBtn").focus({ preventScroll: true }));
  $("#scheduleDialog").addEventListener("cancel", (event) => {
    if ($("#settingsForm button[type=submit]").disabled) event.preventDefault();
  });
  $("#cancelScheduleBtn").addEventListener("click", () => {
    if ($("#settingsForm button[type=submit]").disabled) return;
    state.settingsRevision += 1;
    state.settingsDirty = false;
    fillSettings(state.settings);
    feedback("settingsMessage", "");
    $("#editScheduleBtn").textContent = "Edit schedule";
    feedback("scheduleMessage", "");
    $("#scheduleDialog").close();
  });
  let alertsReturnSection = null;
  $("#editAlertsBtn").addEventListener("click", () => {
    alertsReturnSection = null;
    if (!state.alertsDirty) { fillSettings(state.settings); feedback("alertsFormMessage", ""); }
    $("#alertsDialog").showModal();
  });
  $("#alertRulesSummary").addEventListener("click", event => {
    const button = event.target.closest("[data-edit-alert-section]");
    if (!button) return;
    $("#editAlertsBtn").click();
    alertsReturnSection = button.dataset.editAlertSection;
    const group = document.querySelectorAll("#alertsEditor .telegram-alert-section")[Number(alertsReturnSection)];
    if (group) {
      group.open = true;
      group.querySelector("summary").focus();
      group.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  });
  $("#closeAlertsBtn").addEventListener("click", () => {
    if (!$("#alertsForm button[type=submit]").disabled) $("#alertsDialog").close();
  });
  $("#alertsDialog").addEventListener("close", () => {
    const opener = alertsReturnSection === null ? null : document.querySelector(`[data-edit-alert-section="${alertsReturnSection}"]`);
    (opener || $("#editAlertsBtn")).focus({ preventScroll: true });
  });
  $("#alertsDialog").addEventListener("cancel", (event) => {
    if ($("#alertsForm button[type=submit]").disabled) event.preventDefault();
  });
  $("#cancelAlertsBtn").addEventListener("click", () => {
    if ($("#alertsForm button[type=submit]").disabled) return;
    state.alertsRevision += 1;
    state.alertsDirty = false;
    fillSettings(state.settings);
    feedback("alertsFormMessage", "");
    feedback("alertsMessage", "");
    $("#editAlertsBtn").textContent = "Configure alerts";
    $("#alertsDialog").close();
  });
  $(".settings-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[role=tab]");
    if (tab) selectSettingsTab(tab.id.replace("-tab", ""));
  });
  $(".settings-tabs").addEventListener("keydown", (event) => {
    const tabs = [...document.querySelectorAll(".settings-tabs [role=tab]")];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    selectSettingsTab(tabs[next].id.replace("-tab", ""));
    tabs[next].focus();
  });
  for (const form of [$("#settingsForm"), $("#alertsForm")]) form.addEventListener("invalid", (event) => {
    const panel = event.target.closest("[role=tabpanel]");
    if (panel) selectSettingsTab(panel.id.replace("-tab-panel", ""));
    const disclosure = event.target.closest("details");
    if (disclosure) disclosure.open = true;
  }, true);
  $("#addScheduleTimeBtn").addEventListener("click", () => {
    const times = [...document.querySelectorAll("#scheduleTimeInputs input")].map(input => input.value);
    renderScheduleTimeInputs([...times, ""]);
    $("#scheduleTimeInputs").lastElementChild.querySelector("input").focus();
    markSettingsDirty();
  });
  $("#alertsForm").addEventListener("click", (event) => {
    const addRule = event.target.closest("[data-add-rule]");
    const addReminder = event.target.closest("[data-add-reminder]");
    const addThreshold = event.target.closest("#addTelegramQuotaThresholdBtn");
    if (addThreshold) {
      const values = numberRowValues("telegramQuotaThresholdRows");
      if (values.length >= 10) return;
      renderNumberRows("telegramQuotaThresholdRows", [...values, ""], { kind: "Threshold", min: 1, max: 100, unit: "percent used", firstId: "telegramQuotaThresholdInput", addId: "addTelegramQuotaThresholdBtn", summaryId: "telegramQuotaThresholdSummary" });
      document.querySelectorAll("#telegramQuotaThresholdRows input").item(values.length)?.focus(); updateAlertDisclosureCounts(); markAlertsDirty(); return;
    }
    if (addRule) {
      const [container, summary] = ALERT_RULES[addRule.dataset.addRule];
      const inputs = numberRowValues(container);
      if (inputs.length >= 10) return;
      renderNumberRows(container, [...inputs, ""], { kind: "Notification", min: 0, max: 10080, unit: "minutes after event", summaryId: summary });
      const add = document.querySelector(`[data-add-rule="${addRule.dataset.addRule}"]`); add.disabled = inputs.length + 1 >= 10;
      document.querySelectorAll(`#${container} input`).item(inputs.length)?.focus(); updateAlertDisclosureCounts(); markAlertsDirty(); return;
    }
    if (addReminder) {
      const window = addReminder.dataset.addReminder, id = REMINDER_IDS[window], values = numberRowValues(id);
      if (values.length >= 10) return;
      renderNumberRows(id, [...values, ""], { kind: "Reminder", min: 1, max: 720, unit: "hours before reset" });
      addReminder.disabled = values.length + 1 >= 10;
      const summary = document.getElementById(`telegramReminder${window === "5h" ? "5h" : window === "weekly" ? "Weekly" : "Reserve"}Summary`);
      summary.textContent = `${values.length + 1} reminders`;
      document.querySelectorAll(`#${id} input`).item(values.length)?.focus(); updateAlertDisclosureCounts(); markAlertsDirty(); return;
    }
    const remove = event.target.closest(".telegram-alert-rows button");
    if (remove) {
      const container = remove.closest(".telegram-alert-rows"), id = container.id;
      const values = [...container.querySelectorAll("input")].map(input => input.value); values.splice(Number(remove.dataset.index), 1);
      if (id === "telegramQuotaThresholdRows") renderNumberRows(id, values, { kind: "Threshold", min: 1, max: 100, unit: "percent used", firstId: "telegramQuotaThresholdInput", addId: "addTelegramQuotaThresholdBtn", summaryId: "telegramQuotaThresholdSummary" });
      else if (Object.values(ALERT_RULES).some(config => config[0] === id)) {
        const key = Object.keys(ALERT_RULES).find(key => ALERT_RULES[key][0] === id), summary = ALERT_RULES[key][1];
        renderNumberRows(id, values, { kind: "Notification", min: 0, max: 10080, unit: "minutes after event", summaryId: summary });
        const add = document.querySelector(`[data-add-rule="${key}"]`); add.disabled = values.length >= 10;
      } else { renderNumberRows(id, values, { kind: "Reminder", min: 1, max: 720, unit: "hours before reset" }); const window = Object.keys(REMINDER_IDS).find(key => REMINDER_IDS[key] === id); document.getElementById(`telegramReminder${window === "5h" ? "5h" : window === "weekly" ? "Weekly" : "Reserve"}Summary`).textContent = values.length ? `${values.length} reminders` : "Off"; }
      validateAllAlertNumbers(); updateAlertDisclosureCounts();
      const remaining = container.querySelectorAll("input").length;
      const nextRemove = container.querySelector(`button[data-index="${Math.min(Number(remove.dataset.index), remaining - 1)}"]`);
      const fallback = id === "telegramQuotaThresholdRows" ? $("#addTelegramQuotaThresholdBtn") : Object.values(ALERT_RULES).some(config => config[0] === id) ? document.querySelector(`[data-add-rule="${Object.keys(ALERT_RULES).find(key => ALERT_RULES[key][0] === id)}"]`) : document.querySelector(`[data-add-reminder="${Object.keys(REMINDER_IDS).find(key => REMINDER_IDS[key] === id)}"]`);
      (nextRemove || fallback)?.focus(); markAlertsDirty(); return;
    }
  });
  $("#alertsForm").addEventListener("input", event => {
    if (event.target.matches(".telegram-alert-rows input, #telegramExpiryReminderRows input")) { validateAllAlertNumbers(); updateAlertDisclosureCounts(); }
    if (event.target.closest("#alertsEditor")) updateAlertDisclosureCounts();
  });
  $("#addTelegramExpiryReminderBtn").addEventListener("click", () => {
    if (document.querySelectorAll("#telegramExpiryReminderRows input").length >= 10) return;
    renderTelegramExpiryReminders([...telegramExpiryReminderValues(), ""]);
    $("#telegramExpiryReminderRows").lastElementChild.querySelector("input").focus();
    markAlertsDirty();
  });
  $("#telegramExpiryReminderRows").addEventListener("input", () => {
    validateTelegramExpiryReminders();
    updateTelegramExpiryReminderSummary(telegramExpiryReminderValues());
  });
  $("#telegramExpiryReminderRows").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const values = telegramExpiryReminderValues();
    const index = Number(button.dataset.index);
    values.splice(index, 1);
    renderTelegramExpiryReminders(values);
    validateTelegramExpiryReminders();
    ($(`#telegramExpiryReminderRows button[data-index="${Math.min(index, values.length - 1)}"]`) || $("#addTelegramExpiryReminderBtn")).focus();
    updateAlertDisclosureCounts(); markAlertsDirty();
  });
  $("#scheduleTimeInputs").addEventListener("input", syncScheduleTimes);
  $("#scheduleTimeInputs").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const times = [...document.querySelectorAll("#scheduleTimeInputs input")].map(input => input.value);
    const index = Number(button.dataset.index);
    times.splice(index, 1);
    renderScheduleTimeInputs(times);
    syncScheduleTimes();
    ($(`#scheduleTimeInputs button[data-index="${Math.min(index, times.length - 1)}"]`) || $("#addScheduleTimeBtn")).focus();
    markSettingsDirty();
  });
  $("#deviceLoginBtn").addEventListener("click", () => void accountAction($("#deviceLoginBtn"), "accountMessage", async () => {
    feedback("accountMessage", "Preparing sign-in…");
    renderLoginOutput(await api("/api/auth/device/start", { method: "POST", body: JSON.stringify({ accountId: selectedAccountId() }) }));
    feedback("accountMessage", "");
  }));
  $("#copyLoginCodeBtn").addEventListener("click", () => void buttonAction($("#copyLoginCodeBtn"), "loginMessage", async () => {
    try {
      await navigator.clipboard.writeText($("#loginCode").textContent);
      feedback("loginMessage", "Code copied.", "success");
    } catch {
      feedback("loginMessage", "Select the code above and copy it manually.");
    }
  }));
  $("#logoutBtn").addEventListener("click", () => void accountAction($("#logoutBtn"), "accountDangerMessage", async () => {
    const accountId = selectedAccountId();
    const result = await api("/api/auth/logout", { method: "POST", body: JSON.stringify({ accountId }) });
    if (result.code !== 0) throw new Error("Sign-out did not complete. Try again or check Activity.");
    state.loginSession = null;
    await refreshStatus();
    feedback("accountDangerMessage", "Signed out.", "success");
  }));
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#alertsForm").addEventListener("submit", saveSettings);
  $("#telegramTestBtn").addEventListener("click", async () => {
    const button = $("#telegramTestBtn");
    button.disabled = true;
    $("#telegramMessage").textContent = "Sending...";
    try {
      await api("/api/alerts/telegram/test", { method: "POST" });
      $("#telegramMessage").textContent = "Test alert sent.";
    } catch (error) {
      $("#telegramMessage").textContent = error.message;
    } finally {
      button.disabled = !state.settings?.telegramConfigured;
    }
  });
  $("#clearActivityBtn").addEventListener("click", () => {
    for (const event of state.activityEvents) state.hiddenActivityIds.add(event.id);
    try { sessionStorage.setItem("window-runner:hidden-activity", JSON.stringify([...state.hiddenActivityIds].slice(-1000))); } catch {}
    renderActivity();
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
  $("#settingsForm").addEventListener("input", markSettingsDirty);
  $("#alertsForm").addEventListener("input", markAlertsDirty);
  $("#accountSelect").addEventListener("change", (event) => void selectAccount(event.target.value));
  $("#accountDetailsForm").addEventListener("input", () => {
    const draft = state.accountDrafts.get(selectedAccountId()) || {};
    draft.label = $("#accountLabelInput").value;
    state.accountDrafts.set(selectedAccountId(), draft);
    feedback("accountDetailsMessage", "Unsaved changes.");
  });
  $("#accountDetailsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void accountAction($("#saveAccountBtn"), "accountDetailsMessage", async () => {
      const accountId = selectedAccountId();
      const label = $("#accountLabelInput").value.trim();
      if (!label) throw new Error("Enter an account name.");
      await patchSelectedAccount({ label }, accountId);
      const draft = state.accountDrafts.get(accountId);
      if (draft) delete draft.label;
      feedback("accountDetailsMessage", "Name saved.", "success");
      renderAccounts();
    });
  });
  $("#accountOverridesForm").addEventListener("input", () => {
    const draft = state.accountDrafts.get(selectedAccountId()) || {};
    draft.overrides = Object.fromEntries(["accountScheduleInput", "accountWorkspaceInput", "accountModelInput", "accountPromptInput"].map((id) => [id, $("#" + id).value]));
    state.accountDrafts.set(selectedAccountId(), draft);
    feedback("accountOverridesMessage", "Unsaved changes.");
  });
  $("#accountOverridesForm").addEventListener("submit", saveAccountOverrides);
  $("#editAccountRunSettingsBtn").addEventListener("click", () => $("#accountOverrides").showModal());
  $("#closeAccountRunSettingsBtn").addEventListener("click", () => {
    if (!state.accountBusy) $("#accountOverrides").close();
  });
  $("#accountOverrides").addEventListener("cancel", event => { if (state.accountBusy) event.preventDefault(); });
  $("#accountOverrides").addEventListener("close", () => $("#editAccountRunSettingsBtn").focus({ preventScroll: true }));
  $("#removeAccountBtn").addEventListener("click", () => {
    const account = state.accounts.find(item => item.id === selectedAccountId());
    if (!account || state.accountBusy || state.sendBusy || state.accounts.length <= 1) return;
    state.removalTarget = { id: account.id, label: account.label };
    $("#removeAccountName").textContent = account.label;
    feedback("removeAccountMessage", "");
    updateAccountControls();
    $("#removeAccountDialog").showModal();
    $("#cancelRemoveAccountBtn").focus();
  });
  $("#confirmRemoveAccountBtn").addEventListener("click", () => void removeConfirmedAccount());
  for (const id of ["closeRemoveAccountBtn", "cancelRemoveAccountBtn"]) $("#" + id).addEventListener("click", () => {
    if (!state.removalBusy) $("#removeAccountDialog").close();
  });
  $("#removeAccountDialog").addEventListener("cancel", event => {
    if (state.removalBusy) event.preventDefault();
  });
  $("#removeAccountDialog").addEventListener("close", () => {
    const targetStillExists = state.accounts.some(account => account.id === state.removalTarget?.id);
    state.removalTarget = null;
    const opener = $("#removeAccountBtn");
    (targetStillExists && opener.getClientRects().length && !opener.disabled ? opener : $("#accountSelect")).focus({ preventScroll: true });
  });
  $("#accountEnabledInput").addEventListener("change", (event) => {
    const enabled = event.target.checked;
    void accountAction($("#accountEnabledInput"), "accountMessage", async () => {
      try {
        await patchSelectedAccount({ enabled });
        feedback("accountMessage", enabled ? "Included in scheduled sends." : "Scheduled sends paused for this account.", "success");
      } catch (error) {
        event.target.checked = !enabled;
        throw error;
      }
    });
  });
  $("#addAccountOpenBtn").addEventListener("click", () => {
    $("#addAccountForm").reset();
    feedback("addAccountMessage", "");
    $("#addAccountDialog").showModal();
  });
  for (const id of ["closeAddAccountBtn", "cancelAddAccountBtn"]) $("#" + id).addEventListener("click", () => $("#addAccountDialog").close());
  $("#addAccountForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void accountAction($("#addAccountBtn"), "addAccountMessage", async () => {
      const label = $("#newAccountLabelInput").value.trim();
      if (!label) throw new Error("Enter an account name.");
      const result = await api("/api/accounts", { method: "POST", body: JSON.stringify({ label, enabled: false }) });
      state.selectedAccountId = result.selectedAccountId;
      state.accounts = result.accounts || [];
      renderAccounts();
      $("#addAccountDialog").close();
      await refreshStatus();
      await refreshLoginSession();
      navigateDashboard("#account");
      $("#accountAccess").scrollIntoView({ block: "center", behavior: "smooth" });
      feedback("accountMessage", "Account added. Sign in to connect it.", "success");
    }).then(() => $("#deviceLoginBtn").focus({ preventScroll: true }));
  });
}

const DASHBOARD_VIEWS = {
  fleet: ["Overview", "Account capacity and today’s scheduled sends."],
  account: ["Accounts", "Manage sign-in, account settings, and messages."],
  usage: ["Usage", "Compare quota history and inspect recorded readings."],
  schedule: ["Schedule", "Control when and how scheduled messages are sent."],
  alerts: ["Alerts", "Choose the events and reminders you want to hear about."],
  activity: ["Activity", "Follow runs, replies, and changes across your accounts."]
};

function dashboardView(hash) {
  const id = hash.replace(/^#/, "");
  if (id === "send") return "account";
  if (id === "board") return "fleet";
  return Object.hasOwn(DASHBOARD_VIEWS, id) ? id : "fleet";
}

function filterAccountRows() {
  const query = $("#accountSearchInput")?.value.trim().toLocaleLowerCase() || "";
  const filter = $("#accountFilterInput")?.value || "all";
  let count = 0;
  for (const row of document.querySelectorAll("[data-account-row]")) {
    const account = state.accounts.find(item => item.id === row.dataset.accountRow);
    const needsAttention = !account?.auth?.loggedIn || account.auth.authIssue || row.classList.contains("near") || row.classList.contains("stale");
    const visible = (!query || account?.label.toLocaleLowerCase().includes(query))
      && (filter !== "scheduled" || account?.enabled)
      && (filter !== "attention" || needsAttention);
    row.hidden = !visible;
    if (visible) count++;
  }
  const counter = $("#accountResultCount");
  if (counter) counter.textContent = `${count} of ${state.accounts.length}`;
  let empty = $("#noAccountResults");
  if (!empty) {
    empty = document.createElement("p");
    empty.id = "noAccountResults";
    empty.className = "no-account-results";
    $("#fleetRows")?.after(empty);
  }
  empty.hidden = count > 0 || state.accounts.length === 0;
  empty.textContent = "No accounts match. Try another name or filter.";
}

function navigateDashboard(hash) {
  if (location.hash !== hash) history.pushState(null, "", hash);
  window.dispatchEvent(new Event("dashboardnavigate"));
}

function initDashboardNavigation() {
  const nav = $(".mobile-dock");
  const links = [...nav.querySelectorAll("a")];
  const indicator = document.createElement("span");
  indicator.className = "nav-indicator";
  indicator.setAttribute("aria-hidden", "true");
  indicator.hidden = true;
  nav.prepend(indicator);
  let indicatorMode = null;
  const updateIndicator = () => {
    const active = links.find(link => link.getAttribute("aria-current") === "page");
    if (!active) return;
    const underline = getComputedStyle(nav).getPropertyValue("--nav-indicator-style").trim() === "underline";
    const mode = underline ? "underline" : "pill";
    const navBounds = nav.getBoundingClientRect();
    const bounds = active.getBoundingClientRect();
    const inset = underline ? 8 : 0;
    const left = bounds.left - navBounds.left - nav.clientLeft + nav.scrollLeft + inset;
    const top = (underline ? bounds.bottom - 2 : bounds.top) - navBounds.top - nav.clientTop + nav.scrollTop;
    // First paint and breakpoint changes snap into place; section changes slide.
    const snap = indicator.hidden || indicatorMode !== mode;
    if (snap) indicator.style.transition = "none";
    indicator.style.width = `${Math.max(0, bounds.width - inset * 2)}px`;
    indicator.style.height = `${underline ? 3 : bounds.height}px`;
    indicator.style.transform = `translate(${left}px, ${top}px)`;
    indicator.hidden = false;
    indicatorMode = mode;
    if (snap) {
      indicator.getBoundingClientRect();
      indicator.style.removeProperty("transition");
    }
  };
  let indicatorFrame = 0;
  const scheduleIndicator = () => {
    if (indicatorFrame) return;
    indicatorFrame = requestAnimationFrame(() => { indicatorFrame = 0; updateIndicator(); });
  };
  window.addEventListener("resize", scheduleIndicator);
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(scheduleIndicator);
    observer.observe(nav);
    links.forEach(link => observer.observe(link));
  }
  document.fonts?.ready.then(scheduleIndicator);
  const render = ({ focus = false } = {}) => {
    const view = dashboardView(location.hash);
    for (const panel of document.querySelectorAll("[data-view]")) panel.hidden = panel.dataset.view !== view;
    for (const link of links) {
      if (link.dataset.section === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    updateIndicator();
    const [title, description] = DASHBOARD_VIEWS[view];
    $("#pageTitle").textContent = title;
    $("#pageDescription").textContent = description;
    document.title = `${title} · Codex Window Runner`;
    // Keep a predictable start position; focus moves only after navigation, not polling.
    if (focus) {
      $("#mainContent").focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "instant" });
      if (location.hash === "#send") {
        $("#manualPromptInput").focus({ preventScroll: true });
        $("#send").scrollIntoView({ block: "start", behavior: "instant" });
      }
    }
  };
  window.addEventListener("dashboardnavigate", () => render({ focus: true }));
  // The browser applies fragment scrolling during history traversal; restore the view afterward.
  window.addEventListener("hashchange", () => requestAnimationFrame(() => render({ focus: true })));
  document.addEventListener("click", event => {
    const link = event.target.closest('a[href^="#"]');
    if (event.defaultPrevented || !link || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (link.hash === "#mainContent") {
      event.preventDefault();
      $("#mainContent").focus({ preventScroll: true });
      $("#mainContent").scrollIntoView({ block: "start", behavior: "instant" });
      return;
    }
    const id = link.hash.slice(1);
    if (!Object.hasOwn(DASHBOARD_VIEWS, id) && !["send", "board"].includes(id)) return;
    event.preventDefault();
    navigateDashboard(link.hash);
  });
  $("#accountSearchInput").addEventListener("input", filterAccountRows);
  $("#accountFilterInput").addEventListener("change", filterAccountRows);
  $("#fleetRows").addEventListener("click", async event => {
    const link = event.target.closest("[data-open-account]");
    if (!link || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (state.accountBusy || state.sendBusy) return;
    // Switch the view first so a selection error remains visible in its account context.
    navigateDashboard("#account");
    await selectAccount(link.dataset.openAccount);
  });
  render({ focus: location.hash === "#send" });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("/service-worker.js").catch((error) => {
        console.warn("Service worker registration failed", error);
      });
    });
  }
}

async function init() {
  initTheme();
  try { state.hiddenActivityIds = new Set(JSON.parse(sessionStorage.getItem("window-runner:hidden-activity") || "[]")); } catch {}
  bindActions();
  initDashboardNavigation();
  registerServiceWorker();
  startClock();
  const hydrated = hydrateStatusSnapshot();
  if (hydrated) {
    void loadFleetUsageHistory();
  }
  connectEvents();
  await Promise.all([refreshSettings(), refreshStatus(), refreshActivity()]);
  await loadFleetUsageHistory();
  await refreshLoginSession();
  setInterval(tickFleet, 1000);
  setInterval(() => {
    if (document.visibilityState === "visible" && state.loginSession?.status === "running") void refreshLoginSession().then(() => refreshStatus()).catch(() => {});
  }, 3000);
  startAutoRefresh();
}

if (typeof document !== "undefined") {
  init().catch((error) => {
    const banner = $("#connectionBanner");
    const message = $("#connectionMessage");
    if (banner && message) {
      message.textContent = `${error.message}. Reconnect to the server, then retry.`;
      banner.hidden = false;
      $("#retryConnectionBtn")?.addEventListener("click", () => location.reload());
      window.addEventListener("online", () => location.reload(), { once: true });
    }
  });
}

export {
  schedulePromptPreview,
  dashboardView,
  positionUsageLabels,
  loginPresentation,
  activityTone,
  shouldShowEvent,
  summarizeEvent,
  accountResetCredits,
  accountWindow,
  buildUsageChartModel,
  effectiveWindow,
  nearestUsageTimestamp,
  nextUsageCursorIndex,
  reconcileUsageCursorIndex,
  reserveState,
  resetCreditExpiry,
  resetCreditPresentation,
  resetCreditItems,
  resetCreditCapacity,
  resetIsSoon,
  snapshotDashboard,
  usageChartTicks,
  usageChartValueAt,
  usageFree,
  usageInsightStats,
  usageObservationAt
};
