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
  fleetSignature: null,
  usageHistory: new Map(),
  usageHistoryErrors: new Map(),
  usageHistoryRequests: new Map(),
  usageHistoryRefreshQueued: new Set(),
  usageHistoryGeneration: new Map(),
  usageHistoryRange: "24h"
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#161e28" : "#ffffff");
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
  document.querySelectorAll(".account-selector-rail, .account-management, .settings-panel, .manual-panel")
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
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  return Number.isFinite(sample?.[key]) ? clampPercent(100 - sample[key]) : null;
}

function formatPollingInterval(ms) {
  if (ms < 60 * 1000) {
    return "under 1 min";
  }
  const minutes = Math.round(ms / 60000);
  return `${minutes} min`;
}

function usageStepPath(samples, key, startMs, endMs, observedAt) {
  const left = 52;
  const right = 982;
  const top = 18;
  const bottom = 202;
  const x = (ts) => left + clampPercent(((Date.parse(ts) - startMs) / (endMs - startMs)) * 100) / 100 * (right - left);
  const y = (free) => bottom - (free / 100) * (bottom - top);
  const observedMs = Math.min(endMs, Date.parse(observedAt || ""));
  if (!Number.isFinite(observedMs) || observedMs <= startMs) {
    return "";
  }
  let path = "";
  let active = false;
  for (const sample of samples) {
    if (Date.parse(sample.ts) > observedMs) {
      continue;
    }
    const pointX = x(sample.ts);
    const free = usageFree(sample, key);
    if (!Number.isFinite(free)) {
      if (active) {
        path += ` H ${pointX.toFixed(2)}`;
        active = false;
      }
      continue;
    }
    if (!active) {
      path += ` M ${pointX.toFixed(2)} ${y(free).toFixed(2)}`;
      active = true;
    } else {
      path += ` H ${pointX.toFixed(2)} V ${y(free).toFixed(2)}`;
    }
  }
  return active ? `${path} H ${x(new Date(observedMs).toISOString()).toFixed(2)}` : path;
}

const USAGE_ACCOUNT_COLORS = ["#e07a2f", "#27896d", "#5879d6", "#9a62c7", "#c84f67", "#8a751f"];
const USAGE_ACCOUNT_DASHES = ["none", "10 5", "2 4"];

function renderUsageHistory() {
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
  const rangeMs = USAGE_HISTORY_RANGES[state.usageHistoryRange] || USAGE_HISTORY_RANGES["24h"];
  const endMs = Date.now();
  const startMs = endMs - rangeMs;
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

  const startLabel = new Date(startMs).toLocaleString([], rangeMs <= USAGE_HISTORY_RANGES["24h"]
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric" });
  const endLabel = new Date(endMs).toLocaleString([], { hour: "2-digit", minute: "2-digit" });
  const renderChart = (host, key, label) => {
    const paths = histories.map(({ account, index, data }) => {
      const samples = [data.baseline, ...(data.samples || [])].filter(Boolean)
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      const path = usageStepPath(samples, key, startMs, endMs, data.observedAt?.[key]);
      const color = USAGE_ACCOUNT_COLORS[index % USAGE_ACCOUNT_COLORS.length];
      const dash = USAGE_ACCOUNT_DASHES[Math.floor(index / USAGE_ACCOUNT_COLORS.length) % USAGE_ACCOUNT_DASHES.length];
      return path ? `<path class="usage-line account-line" style="stroke:${color};stroke-dasharray:${dash}" d="${path}"><title>${escapeHtml(`${account.label}: ${label}`)}</title></path>` : "";
    }).join("");
    if (!paths) {
      const loading = state.accounts.some((account) =>
        state.usageHistoryRequests.has(`${account.id}:${state.usageHistoryRange}`));
      host.innerHTML = `<p class="board-empty">${loading
        ? "Loading fleet usage history..."
        : failedAccounts.length ? `History unavailable for ${failedAccounts.length} account${failedAccounts.length === 1 ? "" : "s"}.` : "No readings recorded for this window yet."}</p>`;
      return;
    }
    host.innerHTML = `
      <svg viewBox="0 0 1000 240" role="img" aria-label="${escapeHtml(`${label} by account over ${state.usageHistoryRange}`)}" aria-describedby="usageHistoryChanges">
        <title>${escapeHtml(`${label} by account over ${state.usageHistoryRange}`)}</title>
        <desc>Each colored step line represents one account. Lines change only when a new value is observed.</desc>
        ${[0, 25, 50, 75, 100].map((free) => {
          const y = 202 - (free / 100) * 184;
          return `<line class="usage-grid" x1="52" x2="982" y1="${y}" y2="${y}"></line><text class="usage-axis-y" x="45" y="${y + 4}">${free}%</text>`;
        }).join("")}
        ${paths}
        <text class="usage-axis-x" x="52" y="229">${escapeHtml(startLabel)}</text>
        <text class="usage-axis-x" x="982" y="229" text-anchor="end">${escapeHtml(endLabel)}</text>
      </svg>`;
  };
  renderChart(fiveHourChart, "fiveHourUsed", "5-hour quota remaining");
  renderChart(weeklyChart, "weeklyUsed", "Weekly quota remaining");
  legend.innerHTML = state.accounts.map((account, index) => `
    <span class="${state.usageHistoryErrors.has(`${account.id}:${state.usageHistoryRange}`) ? "unavailable" : ""}"><i class="usage-legend pattern-${Math.floor(index / USAGE_ACCOUNT_COLORS.length) % USAGE_ACCOUNT_DASHES.length}" style="--account-color:${USAGE_ACCOUNT_COLORS[index % USAGE_ACCOUNT_COLORS.length]}"></i>${escapeHtml(account.label)}</span>
  `).join("") || '<span>No accounts configured.</span>';
  const latestRows = state.accounts.map((account, index) => {
    const data = state.usageHistory.get(`${account.id}:${state.usageHistoryRange}`)?.data;
    const latest = data?.samples?.at(-1) || data?.baseline;
    const value = (key) => {
      const free = usageFree(latest, key);
      return Number.isFinite(free) ? `${free}%` : "—";
    };
    return `
      <tr>
        <th><i class="usage-legend pattern-${Math.floor(index / USAGE_ACCOUNT_COLORS.length) % USAGE_ACCOUNT_DASHES.length}" style="--account-color:${USAGE_ACCOUNT_COLORS[index % USAGE_ACCOUNT_COLORS.length]}"></i>${escapeHtml(account.label)}</th>
        <td>${value("fiveHourUsed")}</td>
        <td>${value("weeklyUsed")}</td>
        <td>${latest?.ts ? escapeHtml(new Date(latest.ts).toLocaleString()) : state.usageHistoryErrors.has(`${account.id}:${state.usageHistoryRange}`) ? "Unavailable" : "Waiting"}</td>
      </tr>`;
  }).join("");
  latestHost.innerHTML = state.accounts.length ? `
    <table>
      <thead><tr><th>Account</th><th>5h remaining</th><th>Weekly remaining</th><th>Last change</th></tr></thead>
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
  if (!accountId) {
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
  const request = (async () => {
    try {
      const data = await api(`/api/usage-history?accountId=${encodeURIComponent(accountId)}&range=${encodeURIComponent(requestedRange)}`);
      if (state.usageHistoryGeneration.get(key) !== generation) {
        return;
      }
      state.usageHistory.set(key, { fetchedAt: Date.now(), data });
      state.usageHistoryErrors.delete(key);
      saveUsageHistorySnapshot(accountId, data);
      if (requestedRange === state.usageHistoryRange) {
        renderUsageHistory();
      }
    } catch (error) {
      state.usageHistoryErrors.set(key, error.message);
      if (requestedRange === state.usageHistoryRange && state.usageHistoryGeneration.get(key) === generation) {
        renderUsageHistory();
      }
    } finally {
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
  const remaining = Number.isFinite(remainingValue) ? `${remainingValue}%` : "Unknown";
  const reset = Number.isFinite(current?.resetsAt) ? formatUnixSeconds(current.resetsAt) : "Unknown";
  const duration = Number.isFinite(current?.windowDurationMins) ? `${current.windowDurationMins} min` : "Unknown";
  const plan = limits?.planType ? `${limits.planType} / ${duration}` : duration;
  const lastTurn = dashboard.lastCompletedTurn;

  $("#windowUsage").textContent = remaining;
  $("#windowReset").textContent = reset;
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
  $("#lastPing").textContent = compactText(dashboard.lastUserMessage?.text);
  $("#lastReply").textContent = compactText(dashboard.lastAgentMessage?.text);
  $("#windowUsageLabel").textContent = Number.isFinite(remainingValue) ? `${remainingValue}% remaining` : "Usage unknown";
  $("#windowResetHint").textContent = Number.isFinite(current?.resetsAt) ? `Limiting window resets ${reset}` : "Reset unknown";
  $("#windowUsageBar").style.width = `${clampPercent(remainingValue)}%`;

  if (lastTurn?.status === "completed" && !lastTurn.error) {
    badge($("#windowBadge"), `Last turn OK (${formatDuration(lastTurn.durationMs)})`, "ok");
  } else if (lastTurn?.error) {
    badge($("#windowBadge"), "Last turn failed", "bad");
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
  $("#localTime").textContent = status.scheduler.next.localNow;
  $("#lastRun").textContent = formatRun(status.latestRun);
  renderNextSend(status.scheduler.next.nextLocal, status.scheduler.enabled);

  badge($("#serviceBadge"), status.auth.probeUnavailable ? "Auth check unavailable" : status.auth.logoutConfirmationPending ? "Auth check pending" : status.auth.loggedIn ? "Ready" : status.auth.authIssue ? "Auth issue" : "Needs login", authUncertain ? "warn" : status.auth.loggedIn ? "ok" : status.auth.authIssue ? "bad" : "warn");
  badge($("#loginBadge"), status.auth.probeUnavailable ? "Check unavailable" : status.auth.logoutConfirmationPending ? "Confirmation pending" : status.auth.loggedIn ? "Logged in" : status.auth.authIssue ? "Authentication failed" : "Logged out", authUncertain ? "warn" : status.auth.loggedIn ? "ok" : "bad");
  badge($("#schedulerBadge"), status.scheduler.enabled ? "Enabled" : "Paused", status.scheduler.enabled ? "ok" : "warn");
  updateWindowSummary(status.dashboard || {});
  renderFleet();
  renderUsageHistory();

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
    const authLabel = account.auth?.loggedIn ? "logged in" : account.auth?.authIssue ? "auth issue" : "logged out";
    const enabledTone = account.enabled ? "ok" : "warn";
    card.innerHTML = `
      <span>
        <strong>${escapeHtml(account.label)}</strong>
        <small>${escapeHtml(account.thread?.threadId ? `thread ${shortId(account.thread.threadId)}` : "no thread yet")}</small>
      </span>
      <span class="account-card-badges">
        <span class="mini-badge ${authTone}" title="${escapeHtml(account.auth?.detail || authLabel)}">${authLabel}</span>
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
  await api("/api/accounts/select", { method: "POST", body: JSON.stringify({ accountId }) });
  await refreshStatus();
  await loadFleetUsageHistory();
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
  $("#telegramEnabledInput").checked = Boolean(settings.telegramAlertsEnabled);
  $("#telegramEnabledInput").disabled = !settings.telegramConfigured && !settings.telegramAlertsEnabled;
  $("#telegramQuotaThresholdInput").value = settings.telegramQuotaWarningPercent ?? 80;
  $("#telegramExpiryHoursInput").value = settings.telegramResetExpiryHours ?? 24;
  $("#telegramQuotaResetsInput").checked = settings.telegramAlertQuotaResets !== false;
  $("#telegramReserveInput").checked = settings.telegramAlertReserve !== false;
  $("#telegramResetCreditsInput").checked = settings.telegramAlertResetCredits !== false;
  $("#telegramFailuresInput").checked = settings.telegramAlertFailures !== false;
  $("#telegramTestBtn").disabled = !settings.telegramConfigured;
  badge(
    $("#telegramStatus"),
    settings.telegramConfigured ? settings.telegramAlertsEnabled ? "Enabled" : "Configured" : "Credentials missing",
    settings.telegramConfigured ? settings.telegramAlertsEnabled ? "ok" : "warn" : "neutral"
  );
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
  if (tierA === 3) {
    const freeA = effectiveWindow(winA, now).free;
    const freeB = effectiveWindow(winB, now).free;
    if (freeA !== freeB) {
      return freeB - freeA;
    }
  }
  return String(a.label).localeCompare(String(b.label));
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

  $("#fleetMeanFree").textContent = readings.length
    ? `${Math.round(readings.reduce((sum, entry) => sum + effectiveWindow(entry.win, now).free, 0) / readings.length)}%`
    : "—";
  $("#fleetWeeklyMeanFree").textContent = weeklyReadings.length
    ? `${Math.round(weeklyReadings.reduce((sum, entry) => sum + entry.win.secondary.free, 0) / weeklyReadings.length)}%`
    : "—";
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

  rowsHost.innerHTML = !accounts.length
    ? '<p class="board-empty">No accounts configured yet. Add one in Account console.</p>'
    : accounts.map((account) => {
        const win = accountWindow(account);
        const resetCredits = accountResetCredits(account);
        const loggedIn = Boolean(account.auth?.loggedIn);
        let rowClasses = "strip-row";
        let trackCell;
        let metaCell = "";
        const creditExpiry = resetCreditExpiry(resetCredits);
        const creditExpiryDates = resetCredits.resetCreditsAvailable === 0
          ? ["None available"]
          : Array.isArray(resetCredits.resetCreditExpirations) && resetCredits.resetCreditExpirations.length
            ? [
                ...resetCredits.resetCreditExpirations.map((expiresAt) => Number.isSafeInteger(expiresAt)
                  ? new Date(expiresAt * 1000).toLocaleDateString([], { month: "short", day: "numeric" })
                  : expiresAt === null ? "No expiry" : "Expiry unknown"),
                ...Array(Math.max(0, resetCredits.resetCreditsAvailable - resetCredits.resetCreditExpirations.length)).fill("Expiry unknown")
              ]
            : ["Expiry unknown"];
        const creditExpiryShort = creditExpiryDates.join(" · ");
        const labelCell = `
          <span class="strip-label-stack">
            <span class="strip-label" title="${escapeHtml(account.label)}">${escapeHtml(account.label)}</span>
            ${win?.planType && win.planType !== "unknown" ? `<span class="mini-badge neutral strip-plan">${escapeHtml(win.planType)}</span>` : ""}
            ${Number.isSafeInteger(resetCredits.resetCreditsAvailable) ? `
              <span class="reset-credit-card" title="${escapeHtml(`${creditExpiry.title}. ${resetCredits.resetCreditsUpdatedAt ? `Count read ${new Date(resetCredits.resetCreditsUpdatedAt).toLocaleString()}` : "Read time unavailable"}`)}">
                <span class="reset-credit-count">${resetCredits.resetCreditsAvailable} reset${resetCredits.resetCreditsAvailable === 1 ? "" : "s"}</span>
                <span class="reset-credit-dates"><b>${resetCredits.resetCreditsAvailable ? "Expires" : "Status"}</b> ${escapeHtml(creditExpiryShort)}</span>
              </span>` : ""}
          </span>`;
        if (account.auth?.authIssue) {
          rowClasses += " muted";
          trackCell = `<span class="strip-note" title="${escapeHtml(account.auth.detail || "Authentication failed")}">authentication issue - re-login from Account console</span>`;
        } else if (!loggedIn) {
          rowClasses += " muted";
          trackCell = '<span class="strip-note">logged out — re-login from Account console</span>';
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
              <div class="strip-track" role="img" aria-label="${escapeHtml(
                fresh
                  ? `${account.label}: ${current.free}% of the limiting quota remaining`
                  : `${account.label}: stale reading, last reported ${current.free}% remaining`
              )}">
                <div class="strip-fill" style="width:${current.free}%"></div>
              </div>` : '<span class="strip-note">ordinary quota not reported</span>'}
              ${win.secondary?.hasData ? `
              <div class="strip-week ${Number(win.secondary.resetsAt) * 1000 > now ? "" : "stale"}">
                <span class="week-tag">wk</span>
                <div class="week-track" role="img" aria-label="${escapeHtml(
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
                <div class="week-track" role="img" aria-label="${escapeHtml(
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
        return `<div class="${rowClasses}">${labelCell}${trackCell}${metaCell}</div>`;
      }).join("");

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
      if (event.payload?.accountId) {
        void loadUsageHistory(event.payload.accountId, true);
      }
    }
  });
  events.addEventListener("login", async () => {
    renderLoginOutput(await api(`/api/auth/device/current?accountId=${encodeURIComponent(selectedAccountId() || "")}`));
    await refreshStatus();
  });
  events.addEventListener("status", async () => {
    await refreshStatus();
    await loadFleetUsageHistory(true);
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
    telegramAlertsEnabled: $("#telegramEnabledInput").checked,
    telegramQuotaWarningPercent: Number.parseInt($("#telegramQuotaThresholdInput").value, 10),
    telegramResetExpiryHours: Number.parseInt($("#telegramExpiryHoursInput").value, 10),
    telegramAlertQuotaResets: $("#telegramQuotaResetsInput").checked,
    telegramAlertReserve: $("#telegramReserveInput").checked,
    telegramAlertResetCredits: $("#telegramResetCreditsInput").checked,
    telegramAlertFailures: $("#telegramFailuresInput").checked,
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
  $("#usageHistoryRanges").addEventListener("click", (event) => {
    const button = event.target.closest("[data-range]");
    if (!button || !USAGE_HISTORY_RANGES[button.dataset.range]) {
      return;
    }
    state.usageHistoryRange = button.dataset.range;
    renderUsageHistory();
    void loadFleetUsageHistory(true);
  });
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
    await loadFleetUsageHistory();
  });
}

function initMobileDock() {
  const links = [...document.querySelectorAll(".mobile-dock a")];
  const sections = links
    .map((link) => document.getElementById(link.dataset.section))
    .filter(Boolean);
  if (!links.length || !sections.length || !("IntersectionObserver" in window)) {
    return;
  }
  const setCurrent = (id) => {
    for (const link of links) {
      if (link.dataset.section === id) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  };
  setCurrent(location.hash.slice(1) || "fleet");
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) {
      setCurrent(visible.target.id);
    }
  }, { rootMargin: "-15% 0px -65%", threshold: [0, 0.25, 0.5] });
  sections.forEach((section) => observer.observe(section));
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
  bindActions();
  initMobileDock();
  registerServiceWorker();
  startClock();
  const hydrated = hydrateStatusSnapshot();
  if (hydrated) {
    void loadFleetUsageHistory();
  }
  connectEvents();
  await Promise.all([refreshSettings(), refreshStatus(), refreshActivity()]);
  await loadFleetUsageHistory();
  renderLoginOutput(await api(`/api/auth/device/current?accountId=${encodeURIComponent(selectedAccountId() || "")}`));
  setInterval(tickFleet, 1000);
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

export { accountResetCredits, accountWindow, effectiveWindow, reserveState, resetCreditExpiry, snapshotDashboard };
