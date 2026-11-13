import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { advanceAuthenticationFailure, interpretCodexLoginStatus, mergeAuthenticationProbe } from "./auth-status.mjs";
import { recordRateLimitsNotification, recordRateLimitsRead } from "./rate-limits.mjs";
import { buildQuotaAlertEvents, buildQuotaResetReminderEvents, buildResetReminderEvents, formatTelegramAlertMessages, pruneResetReminderState, recordQuotaResetReminder, recordResetReminder, telegramEventStillRelevant, validateResetReminderHours, withoutTelegramCredentials } from "./telegram-alerts.mjs";
import { normalizeTelegramSettings, patchTelegramSettings, TELEGRAM_EVENT_TYPES, TELEGRAM_QUOTA_WINDOWS } from "./telegram-policy.mjs";
import { adaptivePollingInterval, appendUsageSample, latestUsageActivityAt, normalizeUsageHistory, observedUsageKeys } from "./usage-history.mjs";
import { chooseModel, readModelCatalog } from "./models.mjs";
import { CLAUDE_POLL_MS, CLAUDE_SESSION_ID, ClaudeError, claudeClient } from "./claude-client.mjs";
import { bindMetricsIdentity, buildUsageMetrics, emptyMetrics, normalizeBilling, normalizeExtraUsage, normalizeMetrics, recordQuotaObservations, updateBilling } from "./usage-metrics.mjs";
import { createMetricsCollector } from "./metrics-collector.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const CODEX_HOME = process.env.CODEX_HOME || path.join(DATA_DIR, "codex-home");
const ACCOUNTS_DIR = process.env.CODEX_ACCOUNTS_DIR || path.join(path.dirname(CODEX_HOME), "codex-accounts");
const DEFAULT_WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const SERVICE_NAME = "codex-window-runner";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const claude = claudeClient(process.env.CLAUDE_WORKER_SOCKET, process.env.CLAUDE_QUOTA_VERIFIED_VERSION);

process.env.TZ ||= "Europe/Lisbon";

const DEFAULT_PROMPT = `Scheduled Codex window ping at {{local_time}}.

Continue the active goal in this thread. If no goal is set, summarize current state and ask me to set one. Prefer small, reversible progress. Do not start unrelated work. Stop and ask before destructive actions, credential handling, broad network access, or anything requiring approval.`;
const CLAUDE_PROMPT = "Scheduled Claude window ping at {{local_time}}. Reply with a short acknowledgment.";

const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const VALID_APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "granular", "never"]);

const DEFAULT_THREAD_STATE = {
  threadId: null,
  sessionId: null,
  name: null,
  lastScheduleKey: null,
  updatedAt: null
};

const DEFAULT_DASHBOARD = {
  rateLimits: null,
  rateLimitsByLimitId: {},
  ordinaryUsageAllowed: null,
  rateLimitResetCredits: null,
  lastUserMessage: null,
  lastAgentMessage: null,
  lastCompletedTurn: null
};

function normalizeApprovalPolicy(value) {
  if (value === "unlessTrusted") {
    return "on-request";
  }
  return VALID_APPROVAL_POLICIES.has(value) ? value : "on-request";
}

const DEFAULT_STORE = {
  version: 1,
  settings: {
    timezone: "Europe/Lisbon",
    scheduleTimes: ["08:00", "13:05", "18:10", "23:15"],
    schedulerEnabled: true,
    promptTemplate: DEFAULT_PROMPT,
    model: "",
    effort: "medium",
    summary: "concise",
    approvalPolicy: "on-request",
    networkAccess: false,
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    skipIfActive: true,
    telegramAlertsEnabled: false,
    telegramQuotaWarningPercent: 80,
    telegramAlertQuotaResets: true,
    telegramAlertReserve: true,
    telegramAlertResetCredits: true,
    telegramResetReminderHours: [48],
    telegramAlertFailures: true,
    ...normalizeTelegramSettings()
  },
  selectedAccountId: "default",
  accounts: [],
  threadState: structuredClone(DEFAULT_THREAD_STATE),
  scheduledRuns: [],
  activityEvents: [],
  authEvents: [],
  telegramAlertOutbox: [],
  telegramAlertState: { authIssues: {}, authFailureCounts: {}, intentionalLogouts: {}, resetReminders: {}, quotaReminders: {} },
  dashboard: structuredClone(DEFAULT_DASHBOARD)
};

let store = structuredClone(DEFAULT_STORE);
let saveChain = Promise.resolve();
const sseClients = new Set();
const authStatusCacheByAccount = new Map();
const authStatusRefreshByAccount = new Map();
const authStatusProbeAtByAccount = new Map();
const appServers = new Map();
const loginSessions = new Map();
const deletingAccountIds = new Set();
const accountProcesses = new Map();
const claudeRuns = new Map();
const claudeQuota = new Map();
const claudeRefreshes = new Map();
let stateRefreshPromise = null;
let authStatusBroadcastPromise = null;
let telegramFlushPromise = null;
let telegramSendingItemId = null;
let telegramRetryTimer = null;
let claudeRefreshTimer = null;
let shuttingDown = false;
const refreshAccountMetrics = createMetricsCollector({
  read: (account, method, params) => getAppServer(account.id).send(method, params, 30000),
  isCurrent: account => !deletingAccountIds.has(account.id) && store.accounts.includes(account),
  revision: account => getAppServer(account.id, false)?.proc,
  changed: async account => {
    if (!store.accounts.includes(account)) return;
    await saveStore();
    broadcast("metrics", { accountId: account.id });
  }
});

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultAccount() {
  return {
    id: "default",
    provider: "codex",
    label: "Default account",
    enabled: true,
    codeHome: CODEX_HOME,
    settings: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    threadState: clone(DEFAULT_THREAD_STATE),
    dashboard: clone(DEFAULT_DASHBOARD),
    usageHistory: [],
    metrics: emptyMetrics(),
    billing: [],
    usageObservedAt: { fiveHourUsed: null, weeklyUsed: null, reserveUsed: null }
  };
}

function createAccount(label = "New account", provider = "codex") {
  const id = `acct_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return {
    id,
    provider,
    label,
    enabled: provider === "codex",
    ...(provider === "codex" ? { codeHome: path.join(ACCOUNTS_DIR, id) } : {}),
    settings: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    threadState: clone(DEFAULT_THREAD_STATE),
    dashboard: clone(DEFAULT_DASHBOARD),
    usageHistory: [],
    metrics: emptyMetrics(provider),
    billing: [],
    usageObservedAt: { fiveHourUsed: null, weeklyUsed: null, reserveUsed: null }
  };
}

const ACCOUNT_SETTING_KEYS = ["scheduleTimes", "promptTemplate", "model", "workspaceDir"];

function normalizeAccountSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out = {};
  for (const key of ACCOUNT_SETTING_KEYS) {
    if (value[key] === undefined || value[key] === null) {
      continue;
    }
    if (key === "scheduleTimes") {
      if (Array.isArray(value.scheduleTimes) && value.scheduleTimes.length > 0 && value.scheduleTimes.every(validateTime)) {
        out.scheduleTimes = [...new Set(value.scheduleTimes)].sort();
      }
      continue;
    }
    if (typeof value[key] === "string" && value[key].trim()) {
      out[key] = value[key].trim();
    }
  }
  return out;
}

function applyAccountSettings(current, patch) {
  const merged = { ...(current || {}) };
  for (const key of ACCOUNT_SETTING_KEYS) {
    if (patch[key] === undefined) {
      continue;
    }
    delete merged[key];
    const normalized = normalizeAccountSettings({ [key]: patch[key] });
    if (normalized[key] !== undefined) {
      merged[key] = normalized[key];
    }
  }
  return merged;
}

function effectiveSettings(account) {
  if (account?.provider === "claude") {
    return {
      scheduleTimes: account.settings.scheduleTimes || store.settings.scheduleTimes,
      promptTemplate: account.settings.promptTemplate || CLAUDE_PROMPT
    };
  }
  return { ...store.settings, ...(account?.settings || {}) };
}

function normalizeUsageObservedAt(value) {
  const legacy = Number.isFinite(Date.parse(typeof value === "string" ? value : "")) ? value : null;
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(["fiveHourUsed", "weeklyUsed", "reserveUsed"].map((key) => [
    key,
    Number.isFinite(Date.parse(source[key] || "")) ? source[key] : legacy
  ]));
}

function normalizeAccount(account, fallback = defaultAccount()) {
  const normalized = {
    ...fallback,
    ...account,
    id: account?.id || fallback.id,
    label: account?.label || fallback.label,
    enabled: account?.enabled !== false,
    codeHome: account?.codeHome || fallback.codeHome,
    settings: normalizeAccountSettings(account?.settings),
    threadState: mergeDefaults(account?.threadState || {}, DEFAULT_THREAD_STATE),
    dashboard: mergeDefaults(account?.dashboard || {}, DEFAULT_DASHBOARD),
    usageHistory: normalizeUsageHistory(account?.usageHistory),
    metrics: normalizeMetrics(account?.metrics, account?.provider),
    billing: normalizeBilling(account?.billing),
    usageObservedAt: normalizeUsageObservedAt(account?.usageObservedAt)
  };
  normalized.updatedAt ||= nowIso();
  normalized.createdAt ||= normalized.updatedAt;
  normalized.provider = account?.provider === "claude" ? "claude" : "codex";
  if (normalized.provider === "claude") {
    delete normalized.codeHome;
    delete normalized.settings.model;
    delete normalized.settings.workspaceDir;
  }
  return normalized;
}

function getAccount(accountId = store.selectedAccountId) {
  const id = accountId || store.selectedAccountId || "default";
  return store.accounts.find((account) => account.id === id) || store.accounts[0];
}

function requireAccount(accountId) {
  const id = accountId ?? store.selectedAccountId;
  if (deletingAccountIds.has(id)) {
    const error = new Error("This account is being removed. Wait for removal to finish.");
    error.statusCode = 409;
    throw error;
  }
  const account = id ? store.accounts.find((item) => item.id === id) : store.accounts[0];
  if (!account) {
    const error = new Error("Account not found");
    error.statusCode = 404;
    throw error;
  }
  return account;
}

function publicAccount(account) {
  const auth = authStatusCacheByAccount.get(account.id)?.status || {
    loggedIn: false,
    credentialPresent: false,
    authIssue: false,
    mode: "unknown",
    detail: "Not checked yet"
  };
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    enabled: account.enabled,
    isSelected: account.id === store.selectedAccountId,
    auth,
    appServer: { running: account.provider === "claude" ? claudeRuns.has(account.id) : getAppServer(account.id, false)?.running || false },
    ...(account.provider === "claude" ? {
      quotaStatus: claudeQuotaStatus(account)
    } : {}),
    settings: clone(account.settings || {}),
    billing: clone(account.billing || []),
    effectiveSettings: effectiveSettings(account),
    thread: account.threadState,
    dashboard: account.dashboard
  };
}

function mergeDefaults(target, defaults) {
  if (!target || typeof target !== "object") {
    return clone(defaults);
  }
  const merged = Array.isArray(defaults) ? [] : {};
  for (const [key, value] of Object.entries(defaults)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = mergeDefaults(target[key], value);
    } else if (target[key] === undefined) {
      merged[key] = clone(value);
    } else {
      merged[key] = target[key];
    }
  }
  for (const [key, value] of Object.entries(target)) {
    if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function redactString(value) {
  return value
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/(refresh_token["'\s:=]+)[^"',\s]+/gi, "$1[REDACTED]")
    .replace(/(access_token["'\s:=]+)[^"',\s]+/gi, "$1[REDACTED]")
    .replace(/(id_token["'\s:=]+)[^"',\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_\-]{12,})/g, "[REDACTED_API_KEY]");
}

function redact(value, depth = 0) {
  if (depth > 6) {
    return "[MAX_DEPTH]";
  }
  if (typeof value === "string") {
    const redacted = redactString(value);
    return redacted.length > 4000 ? `${redacted.slice(0, 4000)}... [TRUNCATED]` : redacted;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redact(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|secret|password|credential|auth/i.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redact(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}

async function ensureDirs() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(CODEX_HOME, { recursive: true });
  await mkdir(ACCOUNTS_DIR, { recursive: true });
  const accounts = store?.accounts?.length ? store.accounts : [defaultAccount()];
  for (const account of accounts) {
    if (!deletingAccountIds.has(account.id)) await ensureAccountDirs(account);
  }
}

async function ensureAccountDirs(account) {
  if (account.provider === "claude" || deletingAccountIds.has(account.id)) return;
  await mkdir(account.codeHome, { recursive: true });
  if (deletingAccountIds.has(account.id)) return;
  const configPath = path.join(account.codeHome, "config.toml");
  if (!existsSync(configPath)) {
    await writeFile(configPath, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  }
}

async function removeAccountHome(codeHome) {
  if (!codeHome) {
    return false;
  }
  const resolved = path.resolve(codeHome);
  const allowedRoots = [path.resolve(CODEX_HOME), path.resolve(ACCOUNTS_DIR)];
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    return false;
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return true;
}

async function loadStore() {
  await ensureDirs();
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    const saved = JSON.parse(raw);
    saved.settings = normalizeTelegramSettings(saved.settings);
    store = mergeDefaults(saved, DEFAULT_STORE);
  } catch (error) {
    if (error.code !== "ENOENT") {
      // Keep the unreadable file: saving defaults over it would drop every account.
      const kept = `${STORE_PATH}.corrupt-${Date.now()}`;
      await rename(STORE_PATH, kept);
      console.error(`Failed to read ${STORE_PATH}; kept it as ${kept} and started with defaults`, error);
    }
    store = structuredClone(DEFAULT_STORE);
    await saveStore();
  }
  normalizeStore();
  await saveStore();
}

function normalizeStore() {
  store.settings = normalizeTelegramSettings(store.settings);
  store.settings.approvalPolicy = normalizeApprovalPolicy(store.settings.approvalPolicy);
  for (const key of [
    "telegramAlertsEnabled",
    "telegramAlertQuotaResets",
    "telegramAlertReserve",
    "telegramAlertResetCredits",
    "telegramAlertFailures"
  ]) {
    if (typeof store.settings[key] !== "boolean") {
      store.settings[key] = DEFAULT_STORE.settings[key];
    }
  }
  if (!Number.isInteger(store.settings.telegramQuotaWarningPercent)
    || store.settings.telegramQuotaWarningPercent < 1
    || store.settings.telegramQuotaWarningPercent > 100) {
    store.settings.telegramQuotaWarningPercent = DEFAULT_STORE.settings.telegramQuotaWarningPercent;
  }
  store.telegramAlertOutbox = Array.isArray(store.telegramAlertOutbox)
    ? store.telegramAlertOutbox.filter((item) => item
      && typeof item === "object"
      && typeof item.id === "string"
      && typeof item.text === "string"
      && item.text.length > 0
      && item.text.length <= 4000).slice(-500).map((item) => ({
        id: item.id,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
        accountId: typeof item.accountId === "string" ? item.accountId : null,
        accountLabel: typeof item.accountLabel === "string" ? item.accountLabel.slice(0, 200) : "Unknown account",
        eventTypes: Array.isArray(item.eventTypes) ? item.eventTypes.filter((value) => typeof value === "string").slice(0, 20) : [],
        text: item.text,
        attempts: Number.isSafeInteger(item.attempts) && item.attempts >= 0 ? item.attempts : 0,
        nextAttemptAt: Number.isFinite(Date.parse(item.nextAttemptAt || "")) ? item.nextAttemptAt : null,
        deliveredAt: Number.isFinite(Date.parse(item.deliveredAt || "")) ? item.deliveredAt : null,
        scheduledAt: Number.isFinite(Date.parse(item.scheduledAt || "")) ? item.scheduledAt : null,
        alert: item.alert && TELEGRAM_EVENT_TYPES.includes(item.alert.event?.type)
          && Number.isInteger(item.alert.delayMinutes) && item.alert.delayMinutes >= 0 && item.alert.delayMinutes <= 10080
          && Number.isFinite(item.alert.event.observedAtMs)
          ? { event: item.alert.event, delayMinutes: item.alert.delayMinutes } : null,
        quotaReminder: TELEGRAM_QUOTA_WINDOWS.includes(item.quotaReminder?.windowKey)
          ? { windowKey: item.quotaReminder.windowKey } : null,
        resetReminder: item.resetReminder && Number.isSafeInteger(item.resetReminder.expiresAt)
          && validateResetReminderHours([item.resetReminder.hoursBefore])
          ? { expiresAt: item.resetReminder.expiresAt, hoursBefore: item.resetReminder.hoursBefore }
          : null
      }))
    : [];
  if (!store.telegramAlertState || typeof store.telegramAlertState !== "object" || Array.isArray(store.telegramAlertState)) {
    store.telegramAlertState = { authIssues: {} };
  }
  if (!store.telegramAlertState.authIssues
    || typeof store.telegramAlertState.authIssues !== "object"
    || Array.isArray(store.telegramAlertState.authIssues)) {
    store.telegramAlertState.authIssues = {};
  }
  store.telegramAlertState.authIssues = Object.fromEntries(
    Object.entries(store.telegramAlertState.authIssues).filter(([, value]) => typeof value === "boolean")
  );
  if (!store.telegramAlertState.authFailureCounts
    || typeof store.telegramAlertState.authFailureCounts !== "object"
    || Array.isArray(store.telegramAlertState.authFailureCounts)) {
    store.telegramAlertState.authFailureCounts = {};
  }
  store.telegramAlertState.authFailureCounts = Object.fromEntries(
    Object.entries(store.telegramAlertState.authFailureCounts)
      .filter(([, value]) => Number.isSafeInteger(value) && value >= 0)
  );
  if (!store.telegramAlertState.intentionalLogouts
    || typeof store.telegramAlertState.intentionalLogouts !== "object"
    || Array.isArray(store.telegramAlertState.intentionalLogouts)) {
    store.telegramAlertState.intentionalLogouts = {};
  }
  store.telegramAlertState.intentionalLogouts = Object.fromEntries(
    Object.entries(store.telegramAlertState.intentionalLogouts).filter(([, value]) => value === true)
  );
  store.telegramAlertState.resetReminders = Object.fromEntries(
    Object.entries(store.telegramAlertState.resetReminders || {})
      .map(([accountId, sent]) => [accountId, pruneResetReminderState(sent)])
  );
  store.telegramAlertState.quotaReminders = Object.fromEntries(
    Object.entries(store.telegramAlertState.quotaReminders || {}).map(([accountId, windows]) => [accountId,
      Object.fromEntries(TELEGRAM_QUOTA_WINDOWS.filter((key) => Number.isSafeInteger(windows?.[key]?.resetsAt)
        && validateResetReminderHours(windows[key].hours)).map((key) => [key, windows[key]]))])
  );
  if (!Array.isArray(store.accounts) || store.accounts.length === 0) {
    const migrated = defaultAccount();
    migrated.threadState = mergeDefaults(store.threadState || {}, DEFAULT_THREAD_STATE);
    migrated.dashboard = mergeDefaults(store.dashboard || {}, DEFAULT_DASHBOARD);
    store.accounts = [migrated];
    store.selectedAccountId = migrated.id;
  } else {
    store.accounts = store.accounts.map((account, index) => {
      const fallback = index === 0 ? defaultAccount() : createAccount(account?.label || `Account ${index + 1}`);
      return normalizeAccount(account, fallback);
    });
    if (!store.accounts.some((account) => account.id === store.selectedAccountId)) {
      store.selectedAccountId = store.accounts[0].id;
    }
  }
  const selected = getAccount();
  store.threadState = selected?.threadState || clone(DEFAULT_THREAD_STATE);
  store.dashboard = selected?.dashboard || clone(DEFAULT_DASHBOARD);
  reconcileScheduledRuns();
}

function saveStore() {
  const pending = saveChain.then(async () => {
    await ensureDirs();
    for (const account of store.accounts) {
      account.usageHistory = normalizeUsageHistory(account.usageHistory);
    }
    const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, STORE_PATH);
  });
  saveChain = pending.catch((error) => {
    console.error("Failed to save store", error);
  });
  return pending;
}

function broadcast(eventName, data) {
  const encoded = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(encoded);
  }
}

function logActivityEvent(event) {
  const line = JSON.stringify({
    type: "activity",
    ts: event.ts,
    source: event.source,
    severity: event.severity,
    message: event.message,
    payload: event.payload
  });
  if (event.severity === "error") {
    console.error(line);
  } else if (event.severity === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function addActivity(source, severity, message, payload = {}) {
  const event = {
    id: randomUUID(),
    ts: nowIso(),
    source,
    severity,
    message,
    payload: redact(payload)
  };
  store.activityEvents.push(event);
  store.activityEvents = store.activityEvents.slice(-1500);
  logActivityEvent(event);
  broadcast("activity", event);
  void saveStore();
  return event;
}

function telegramConfigured() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

function publicSettings() {
  return { ...store.settings, telegramConfigured: telegramConfigured() };
}

async function deliverTelegramMessage(text) {
  if (!telegramConfigured()) {
    throw new Error("Telegram credentials are not configured");
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000)
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) {
      const errorCode = Number.isInteger(result?.error_code) ? result.error_code : response.status;
      const error = new Error(result?.description || `Telegram returned an invalid HTTP ${response.status} response`);
      error.transient = errorCode === 408 || errorCode === 429 || errorCode >= 500 || !result;
      error.configuration = errorCode === 401 || errorCode === 403;
      error.retryAfterMs = Number.isFinite(result?.parameters?.retry_after)
        ? result.parameters.retry_after * 1000
        : null;
      throw error;
    }
  } catch (error) {
    let safeMessage = redactString(error.message || String(error));
    for (const secret of [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]) {
      if (secret) {
        safeMessage = safeMessage.replaceAll(secret, "[REDACTED]");
      }
    }
    const safeError = new Error(safeMessage);
    safeError.transient = error.transient !== false;
    safeError.configuration = error.configuration === true;
    safeError.retryAfterMs = error.retryAfterMs || null;
    throw safeError;
  }
}

function pendingTelegramReminder(item, account) {
  if (item.resetReminder) return buildResetReminderEvents(account.dashboard, store.settings,
    store.telegramAlertState.resetReminders[account.id]).find((event) => event.expiresAt === item.resetReminder.expiresAt);
  if (item.quotaReminder) return buildQuotaResetReminderEvents(account.dashboard, store.settings,
    store.telegramAlertState.quotaReminders[account.id]).find((event) => event.windowKey === item.quotaReminder.windowKey);
  return null;
}

function telegramItemCurrent(item) {
  const account = store.accounts.find((account) => account.id === item.accountId);
  if (!account || deletingAccountIds.has(account.id)) return false;
  if (account.provider === "claude" && !claudeQuotaStatus(account).live
    && (item.quotaReminder || item.alert?.event.type.startsWith("quota-"))) return false;
  if (item.resetReminder || item.quotaReminder) return Boolean(pendingTelegramReminder(item, account));
  if (!item.alert) return true; // Messages already queued by an older release.
  if (!store.settings.telegramAlertRules[item.alert.event.type]?.includes(item.alert.delayMinutes)) return false;
  const latestSuccessfulRunAtMs = Math.max(0, ...store.scheduledRuns
    .filter((run) => run.accountId === account.id && run.status === "completed")
    .map((run) => Date.parse(run.completedAt || run.ts) || 0));
  return telegramEventStillRelevant(account.dashboard, item.alert.event, store.settings, {
    authIssue: store.telegramAlertState.authIssues[account.id] === true,
    intentionalLogout: store.telegramAlertState.intentionalLogouts[account.id] === true,
    latestSuccessfulRunAtMs
  });
}

function removeTelegramItem(item) {
  const index = store.telegramAlertOutbox.findIndex((entry) => entry.id === item.id);
  if (index >= 0) store.telegramAlertOutbox.splice(index, 1);
}

function flushTelegramOutbox() {
  if (telegramFlushPromise || !telegramConfigured() || !store.settings.telegramAlertsEnabled || !store.telegramAlertOutbox.length) {
    return telegramFlushPromise;
  }
  telegramFlushPromise = (async () => {
    // Persist queued messages before making any external send.
    await saveStore();
    while (store.telegramAlertOutbox.length && store.settings.telegramAlertsEnabled) {
      const obsolete = store.telegramAlertOutbox.find((item) => item.deliveredAt || !telegramItemCurrent(item));
      if (obsolete) {
        removeTelegramItem(obsolete);
        await saveStore();
        continue;
      }
      const item = store.telegramAlertOutbox.find((item) => !(Date.parse(item.nextAttemptAt || "") > Date.now())
        && !(Date.parse(item.scheduledAt || "") > Date.now()));
      if (!item) break;
      const account = store.accounts.find((account) => account.id === item.accountId);
      const sentReminder = pendingTelegramReminder(item, account);
      if (sentReminder) {
        item.text = formatTelegramAlertMessages(account.label, [sentReminder])[0];
      }
      telegramSendingItemId = item.id;
      try {
        await deliverTelegramMessage(item.text);
        telegramSendingItemId = null;
        item.deliveredAt = nowIso();
        if (sentReminder && store.accounts.some((account) => account.id === item.accountId)) {
          if (item.resetReminder) {
            const sent = store.telegramAlertState.resetReminders[item.accountId] ||= {};
            recordResetReminder(sent, sentReminder);
          } else {
            const sent = store.telegramAlertState.quotaReminders[item.accountId] ||= {};
            recordQuotaResetReminder(sent, sentReminder);
          }
        }
        await saveStore();
        removeTelegramItem(item);
        await saveStore();
        addActivity("telegram", "info", "Telegram alert sent", {
          accountId: item.accountId,
          accountLabel: item.accountLabel,
          eventTypes: item.eventTypes,
          attempts: item.attempts + 1
        });
      } catch (error) {
        telegramSendingItemId = null;
        if (item.deliveredAt) {
          addActivity("telegram", "error", "Telegram alert was delivered but outbox persistence failed", {
            error: error.message,
            accountId: item.accountId,
            eventTypes: item.eventTypes
          });
          break;
        }
        if (error.configuration) {
          item.attempts += 1;
          item.nextAttemptAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
          await saveStore();
          addActivity("telegram", "error", "Telegram rejected the configured credentials or destination", {
            error: error.message,
            attempts: item.attempts,
            nextAttemptAt: item.nextAttemptAt
          });
          break;
        }
        if (!error.transient) {
          removeTelegramItem(item);
          await saveStore();
          addActivity("telegram", "error", "Telegram permanently rejected an alert", {
            error: error.message,
            accountId: item.accountId,
            eventTypes: item.eventTypes
          });
          continue;
        }
        item.attempts += 1;
        const retryMs = error.retryAfterMs || Math.min(60, 2 ** Math.min(item.attempts - 1, 6)) * 60 * 1000;
        item.nextAttemptAt = new Date(Date.now() + retryMs).toISOString();
        await saveStore();
        addActivity("telegram", "warn", "Telegram alert delivery deferred", {
          error: error.message,
          attempts: item.attempts,
          nextAttemptAt: item.nextAttemptAt
        });
        break;
      }
    }
  })().catch((error) => {
    addActivity("telegram", "error", "Telegram outbox processing failed", { error: error.message });
  }).finally(() => {
    telegramSendingItemId = null;
    telegramFlushPromise = null;
  });
  return telegramFlushPromise;
}

function queueTelegramEvents(account, events) {
  if (!store.settings.telegramAlertsEnabled || !telegramConfigured()) {
    return false;
  }
  if (!events.length) {
    return false;
  }
  let queued = false;
  const observedAtMs = Date.now();
  for (const source of events) {
    const event = { ...source, observedAtMs };
    const reminder = ["reset-credit-expiry", "quota-reset-reminder"].includes(event.type);
    const delays = reminder ? [0] : store.settings.telegramAlertRules[event.type] || [];
    if (!reminder && delays.length) {
      // A new occurrence replaces undelivered notifications for the same condition.
      const identity = (value) => JSON.stringify([value.type, value.windowKey, value.threshold, value.runId]);
      store.telegramAlertOutbox = store.telegramAlertOutbox.filter((item) => item.id === telegramSendingItemId
        || item.accountId !== account.id || !item.alert || identity(item.alert.event) !== identity(event));
    }
    for (const delayMinutes of delays) {
      if (store.telegramAlertOutbox.length >= 500) {
        addActivity("telegram", "error", "Telegram alert outbox is full; new alerts are paused", { accountId: account.id, eventTypes: [event.type] });
        break;
      }
      const text = delayMinutes === 0 ? event.text
        : `${event.text}\nFollow-up ${delayMinutes} min after the event reported ${new Date(observedAtMs).toLocaleString("en-GB", { timeZone: store.settings.timezone })}.`;
      store.telegramAlertOutbox.push({
        id: randomUUID(), createdAt: nowIso(), accountId: account.id, accountLabel: account.label,
        eventTypes: [event.type], text: formatTelegramAlertMessages(account.label, [{ text }])[0],
        resetReminder: event.type === "reset-credit-expiry" ? { expiresAt: event.expiresAt, hoursBefore: event.hoursBefore } : null,
        quotaReminder: event.type === "quota-reset-reminder" ? { windowKey: event.windowKey } : null,
        alert: reminder ? null : { event, delayMinutes },
        scheduledAt: new Date(observedAtMs + delayMinutes * 60_000).toISOString(),
        attempts: 0, nextAttemptAt: null
      });
      queued = true;
    }
  }
  if (queued) {
    void saveStore()
      .then(() => flushTelegramOutbox())
      .catch((error) => {
        console.error("Failed to persist a queued Telegram alert", error);
      });
  }
  return queued;
}

function queueAccountQuotaAlerts(account, previousDashboard) {
  queueTelegramEvents(account, buildQuotaAlertEvents(previousDashboard, account.dashboard, store.settings));
  queueAccountResetReminders(account);
  queueAccountWindowReminders(account);
}

function queueAccountResetReminders(account) {
  if (deletingAccountIds.has(account.id)) return;
  const sent = pruneResetReminderState(store.telegramAlertState.resetReminders[account.id]);
  store.telegramAlertState.resetReminders[account.id] = sent;
  for (const event of buildResetReminderEvents(account.dashboard, store.settings, sent)) {
    const pending = store.telegramAlertOutbox.find((item) => !item.deliveredAt
      && item.accountId === account.id && item.resetReminder?.expiresAt === event.expiresAt);
    if (pending) {
      // Delivery rebuilds the message from the latest inventory and most urgent due time.
      // Keep a single pending reminder per expiry, including while delivery is in flight.
      continue;
    }
    queueTelegramEvents(account, [event]);
  }
}

function queueResetReminders() {
  for (const account of store.accounts) {
    queueAccountResetReminders(account);
    queueAccountWindowReminders(account);
  }
}

function queueAccountWindowReminders(account) {
  if (deletingAccountIds.has(account.id)) return;
  if (account.provider === "claude" && !claudeQuotaStatus(account).live) return;
  const sent = store.telegramAlertState.quotaReminders[account.id] ||= {};
  for (const event of buildQuotaResetReminderEvents(account.dashboard, store.settings, sent)) {
    if (store.telegramAlertOutbox.some((item) => !item.deliveredAt && item.accountId === account.id
      && item.quotaReminder?.windowKey === event.windowKey)) continue;
    queueTelegramEvents(account, [event]);
  }
}

function queueOperationalFailureAlert(account, message, type = "send-failure", details = {}) {
  return queueTelegramEvents(account, [{ type, text: message, ...details }]);
}

function recordAuthenticationFailure(account, message) {
  if (store.telegramAlertState.intentionalLogouts[account.id]) {
    return false;
  }
  const next = advanceAuthenticationFailure(
    store.telegramAlertState.authFailureCounts[account.id],
    store.telegramAlertState.authIssues[account.id]
  );
  store.telegramAlertState.authFailureCounts[account.id] = next.count;
  void saveStore();
  if (!next.shouldAlert) {
    return false;
  }
  if (queueOperationalFailureAlert(account, message, "auth-failure")) {
    store.telegramAlertState.authIssues[account.id] = true;
    void saveStore();
    return true;
  }
  return false;
}

function clearAuthenticationFailure(account) {
  store.telegramAlertState.authFailureCounts[account.id] = 0;
  store.telegramAlertState.authIssues[account.id] = false;
  delete store.telegramAlertState.intentionalLogouts[account.id];
  void saveStore();
}

function addAuthEvent(message, payload = {}) {
  const event = {
    id: randomUUID(),
    ts: nowIso(),
    message,
    payload: redact(payload)
  };
  store.authEvents.push(event);
  store.authEvents = store.authEvents.slice(-200);
  void saveStore();
  addActivity("auth", "info", message, payload);
  return event;
}

function getFirstTextContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  const textPart = content.find((part) => part?.type === "text" && typeof part.text === "string");
  return textPart?.text || "";
}

function workspaceCwd() {
  const configured = store.settings.workspaceDir || DEFAULT_WORKSPACE_DIR;
  return existsSync(configured) ? configured : ROOT_DIR;
}

function codexEnv(account = getAccount()) {
  return withoutTelegramCredentials({
    ...process.env,
    CODEX_HOME: account?.codeHome || CODEX_HOME,
    NO_COLOR: "1",
    TERM: "dumb"
  });
}

function trackAccountProcess(accountId, child) {
  const children = accountProcesses.get(accountId) || new Set();
  children.add(child);
  accountProcesses.set(accountId, children);
  child.once("close", () => {
    children.delete(child);
    if (!children.size) accountProcesses.delete(accountId);
  });
  return child;
}

async function stopAccountProcesses(accountId) {
  await Promise.all([...(accountProcesses.get(accountId) || [])].map(child => new Promise((resolve, reject) => {
    const onClose = () => { clearTimeout(killTimer); clearTimeout(deadline); resolve(); };
    child.once("close", onClose);
    if (!child.killed) child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    const deadline = setTimeout(() => {
      child.off("close", onClose);
      reject(new Error("Account processes did not stop. Refresh and try removal again."));
    }, 5000);
  })));
}

function runCodex(args, options = {}) {
  const account = options.account || getAccount();
  requireAccount(account.id);
  const timeoutMs = options.timeoutMs ?? 30000;
  return new Promise((resolve) => {
    const child = trackAccountProcess(account.id, spawn("codex", args, {
      cwd: workspaceCwd(),
      env: codexEnv(account),
      stdio: ["pipe", "pipe", "pipe"]
    }));
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, timedOut, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, signal, timedOut, stdout: redactString(stdout), stderr: redactString(stderr) });
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function unknownAuthStatus() {
  return {
    loggedIn: false,
    credentialPresent: false,
    authIssue: false,
    mode: "unknown",
    detail: "Not checked yet"
  };
}

function isAuthenticationError(error) {
  const text = typeof error === "string" ? error : error?.message || JSON.stringify(error || "");
  return /\b401\b|unauthori[sz]ed|not logged in|login required|authentication.{0,30}(?:failed|required|expired|invalid)|(?:access|refresh|id)?[_ -]?token.{0,30}(?:expired|invalid|revoked)/i.test(text);
}

function markAuthIssue(account, error) {
  const detail = redactString(typeof error === "string" ? error : error?.message || String(error));
  const previous = authStatusCacheByAccount.get(account.id)?.status;
  const status = {
    loggedIn: false,
    credentialPresent: previous?.credentialPresent !== false,
    authIssue: true,
    mode: "auth-error",
    detail: `Authentication failed: ${detail}`,
    code: previous?.code ?? null
  };
  authStatusCacheByAccount.set(account.id, { checkedAt: Date.now(), status });
  return status;
}

function markAuthValidated(account) {
  const previous = authStatusCacheByAccount.get(account.id)?.status;
  const status = {
    loggedIn: true,
    credentialPresent: true,
    authIssue: false,
    mode: account.provider,
    detail: account.provider === "claude" ? "Signed in to Claude Code"
      : previous?.authIssue ? "Logged in (live request verified)" : previous?.detail || "Logged in",
    code: 0
  };
  authStatusCacheByAccount.set(account.id, { checkedAt: Date.now(), status });
  return status;
}

async function getAuthStatus(accountOrId = store.selectedAccountId, force = false) {
  const account = typeof accountOrId === "object" ? accountOrId : requireAccount(accountOrId);
  if (deletingAccountIds.has(account.id) || !store.accounts.some(item => item.id === account.id)) return unknownAuthStatus();
  const cached = authStatusCacheByAccount.get(account.id);
  if (!force && cached && Date.now() - cached.checkedAt < 10000) {
    return cached.status;
  }
  if (authStatusRefreshByAccount.has(account.id)) {
    return authStatusRefreshByAccount.get(account.id);
  }
  const refresh = (async () => {
    const interpreted = account.provider === "claude"
      ? await probeClaudeAuth(account)
      : interpretCodexLoginStatus(await runCodex(["login", "status"], { account, timeoutMs: 20000 }));
    if (!interpreted) return authStatusCacheByAccount.get(account.id)?.status || unknownAuthStatus();
    if (deletingAccountIds.has(account.id) || !store.accounts.some(item => item.id === account.id)) return unknownAuthStatus();
    authStatusProbeAtByAccount.set(account.id, Date.now());
    const previous = authStatusCacheByAccount.get(account.id)?.status;
    let status = account.provider === "claude" ? interpreted : mergeAuthenticationProbe(previous, interpreted);
    if (account.provider === "claude") {
      if (interpreted.probeUnavailable) {
        status = { ...(previous || unknownAuthStatus()), probeUnavailable: true, detail: interpreted.detail };
      } else if (previous?.authIssue && interpreted.loggedIn) {
        status = { ...previous, credentialPresent: true, probeUnavailable: false };
      }
      if (!status.probeUnavailable && !status.loggedIn) {
        claudeQuota.set(account.id, { ...claudeQuota.get(account.id), live: false, detail: status.detail });
      }
    }
    const next = {
      checkedAt: Date.now(),
      status
    };
    authStatusCacheByAccount.set(account.id, next);
    return next.status;
  })().finally(() => {
    authStatusRefreshByAccount.delete(account.id);
  });
  authStatusRefreshByAccount.set(account.id, refresh);
  return refresh;
}

async function probeClaudeAuth(account) {
  try {
    const { status } = await claude.call("status", account.id);
    if (status === "ready") return { loggedIn: true, credentialPresent: true, authIssue: false, mode: "claude", detail: "Signed in to Claude Code", code: 0 };
    if (status === "signed-out") return { ...unknownAuthStatus(), mode: "none", detail: "Signed out of Claude Code", code: 1 };
    return { ...unknownAuthStatus(), mode: "auth-error", authIssue: true, detail: new ClaudeError(status).message };
  } catch (error) {
    if (error.code === "busy" || error.code === "interrupted") return null;
    return { ...unknownAuthStatus(), detail: error.message, probeUnavailable: true };
  }
}

function refreshAuthStatusesInBackground() {
  const staleAccounts = store.accounts.filter((account) => {
    // Claude checks its sign-in as part of the independent quota poll.
    if (account.provider === "claude") return false;
    const cached = authStatusCacheByAccount.get(account.id);
    return !cached || Date.now() - cached.checkedAt >= 10000;
  });
  if (!staleAccounts.length || authStatusBroadcastPromise) {
    return;
  }
  authStatusBroadcastPromise = Promise.all(staleAccounts.map((account) => getAuthStatus(account)))
    .then(() => broadcast("status", { ts: nowIso() }))
    .finally(() => {
      authStatusBroadcastPromise = null;
    });
}

class CodexAppServer {
  constructor(accountId) {
    this.accountId = accountId;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.threadStatuses = new Map();
    this.readyPromise = null;
    this.modelCatalog = null;
    this.modelCatalogAt = 0;
  }

  get running() {
    return Boolean(this.proc && !this.proc.killed);
  }

  async start() {
    const account = requireAccount(this.accountId);
    if (this.running) {
      return;
    }
    await ensureDirs();
    // Another caller may have started the process while directories were prepared.
    if (this.running) return;
    requireAccount(this.accountId);
    const proc = trackAccountProcess(account.id, spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: workspaceCwd(),
      env: codexEnv(account),
      stdio: ["pipe", "pipe", "pipe"]
    }));
    this.proc = proc;
    this.buffer = "";
    addActivity("codex", "info", "Started Codex app-server", {
      accountId: account.id,
      accountLabel: account.label,
      cwd: workspaceCwd(),
      codeHome: account.codeHome
    });

    proc.stdout.on("data", (chunk) => this.handleStdout(chunk.toString("utf8")));
    proc.stderr.on("data", (chunk) => {
      const text = redactString(chunk.toString("utf8").trim());
      if (text) {
        addActivity("codex", "warn", "Codex app-server stderr", { accountId: this.accountId, text });
        if (isAuthenticationError(text)) {
          markAuthIssue(account, text);
        }
      }
    });
    proc.on("error", (error) => {
      addActivity("codex", "error", "Failed to start Codex app-server", { accountId: this.accountId, error: error.message });
      if (this.proc === proc) {
        this.rejectAll(error);
        this.proc = null;
      }
    });
    proc.on("close", (code, signal) => {
      addActivity("codex", code === 0 ? "info" : "error", "Codex app-server exited", { accountId: this.accountId, code, signal });
      if (this.proc === proc) {
        this.rejectAll(new Error(`app-server exited with code ${code ?? "unknown"}`));
        this.proc = null;
        this.readyPromise = null;
        this.modelCatalog = null;
        this.threadStatuses.clear();
      }
    });

    this.readyPromise = this.initializeConnection();
    try {
      await this.readyPromise;
    } catch (error) {
      if (this.proc === proc) this.stop();
      throw error;
    }
  }

  stop() {
    this.modelCatalog = null;
    if (this.proc) {
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
    this.rejectAll(new Error("app-server stopped"));
    this.readyPromise = null;
  }

  async restart() {
    const previous = this.proc;
    this.stop();
    if (previous?.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => previous.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
    }
    await this.start();
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  handleStdout(text) {
    this.buffer += text;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        addActivity("codex", "warn", "Unparseable app-server line", { accountId: this.accountId, line, error: error.message });
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(JSON.stringify(redact(message.error)));
        if (isAuthenticationError(error)) {
          const account = store.accounts.find((item) => item.id === this.accountId);
          if (account) {
            markAuthIssue(account, error);
            recordAuthenticationFailure(account, "Authentication failed in Codex app-server");
            error.authFailureRecorded = true;
          }
        }
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.updateThreadStatus(message);
      updateDashboardState(this.accountId, message);
      const account = store.accounts.find((item) => item.id === this.accountId);
      const attribution = { accountId: this.accountId, accountLabel: account?.label || this.accountId };
      if (account && isAuthenticationError(message.params)) {
        markAuthIssue(account, JSON.stringify(redact(message.params)));
      }
      addActivity("codex", "info", message.method, { ...(message.params || {}), ...attribution });
      broadcast("codex", { ...redact(message), ...attribution });
    }
  }

  updateThreadStatus(message) {
    const params = message.params || {};
    if (message.method === "thread/status/changed" && params.threadId) {
      this.threadStatuses.set(params.threadId, params.status || { type: "unknown" });
    }
    if (/^turn\/(completed|failed|cancelled|aborted)/.test(message.method) && params.threadId) {
      this.threadStatuses.set(params.threadId, { type: "idle" });
    }
    if (/^turn\/started/.test(message.method) && params.threadId) {
      this.threadStatuses.set(params.threadId, { type: "active", activeFlags: ["turn"] });
    }
  }

  isThreadActive(threadId) {
    const status = this.threadStatuses.get(threadId);
    return status?.type === "active";
  }

  async send(method, params = {}, timeoutMs = 120000) {
    await this.start();
    if (this.readyPromise) {
      await this.readyPromise;
    }
    return this.rawRequest(method, params, timeoutMs);
  }

  async models() {
    if (!this.modelCatalog || Date.now() - this.modelCatalogAt > 300000) {
      this.modelCatalog = await readModelCatalog(this);
      this.modelCatalogAt = Date.now();
    }
    return this.modelCatalog;
  }

  async initializeConnection() {
    const result = await this.rawRequest("initialize", {
      clientInfo: {
        name: SERVICE_NAME,
        title: "WindowRelay",
        version: "0.1.0"
      }
    }, 30000);
    this.rawNotification("initialized", {});
    addActivity("codex", "info", "Codex app-server initialized", { result });
    return result;
  }

  rawNotification(method, params = {}) {
    this.rawWrite({ method, params });
  }

  rawRequest(method, params = {}, timeoutMs = 120000) {
    const id = this.nextId++;
    const payload = { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.rawWrite(payload);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  rawWrite(payload) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("app-server stdin is not writable");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}

function getAppServer(accountId = store.selectedAccountId, create = true) {
  if (!accountId) {
    return null;
  }
  if (create && requireAccount(accountId).provider === "claude") {
    const error = new Error("This operation is available for Codex accounts.");
    error.statusCode = 422;
    throw error;
  }
  if (!appServers.has(accountId) && create) {
    appServers.set(accountId, new CodexAppServer(accountId));
  }
  return appServers.get(accountId) || null;
}

function recordRateLimits(account, payload, merge = false) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const updatedAt = nowIso();
  account.dashboard ||= structuredClone(DEFAULT_DASHBOARD);
  const previousDashboard = account.dashboard;
  account.dashboard = merge
    ? recordRateLimitsNotification(account.dashboard, redact(payload), updatedAt)
    : recordRateLimitsRead(account.dashboard, redact(payload), updatedAt);
  const usage = appendUsageSample(account.usageHistory, account.dashboard, updatedAt);
  account.usageHistory = usage.history;
  account.usageObservedAt = normalizeUsageObservedAt(account.usageObservedAt);
  const observedKeys = observedUsageKeys(previousDashboard, account.dashboard, payload, merge);
  account.metrics ||= emptyMetrics(account.provider);
  recordQuotaObservations(account.metrics, account.dashboard, observedKeys);
  for (const key of observedKeys) {
    account.usageObservedAt[key] = updatedAt;
  }
  if (account.id === store.selectedAccountId) {
    store.dashboard = account.dashboard;
  }
  return { updatedAt, historyChanged: usage.changed, activityDetected: usage.activityDetected };
}

async function refreshAccountState(account, forceMetrics = false) {
  let canReadMetrics = false;
  let accountIdentity = null;
  const outcome = {
    accountId: account.id,
    accountLabel: account.label,
    authChecked: false,
    loggedIn: false,
    authIssue: false,
    rateLimits: "skipped",
    updatedAt: null,
    error: null
  };
  try {
    if (deletingAccountIds.has(account.id) || !store.accounts.some(item => item.id === account.id)) return outcome;
    const cachedAuth = authStatusCacheByAccount.get(account.id);
    const authProbeFresh = Date.now() - (authStatusProbeAtByAccount.get(account.id) || 0) < 10 * 60 * 1000;
    const auth = cachedAuth?.status.loggedIn && authProbeFresh
      ? cachedAuth.status
      : await getAuthStatus(account, true);
    if (deletingAccountIds.has(account.id) || !store.accounts.some(item => item.id === account.id)) return outcome;
    outcome.authChecked = !auth.probeUnavailable;
    outcome.loggedIn = auth.loggedIn;
    if (auth.probeUnavailable && !auth.loggedIn) {
      outcome.rateLimits = "failed";
      outcome.error = "Codex login status check was temporarily unavailable";
      return outcome;
    }
    if (!auth.loggedIn && !auth.credentialPresent) {
      recordAuthenticationFailure(account, "Codex account is not logged in");
      return outcome;
    }
    canReadMetrics = true;
    const result = await getAppServer(account.id).send("account/rateLimits/read", {
      supportsLunaReserve: true
    }, 30000);
    if (!result?.rateLimits) {
      throw new Error("Codex returned no rate-limit data");
    }
    accountIdentity = typeof result.accountId === "string" ? result.accountId : null;
    const previousDashboard = account.dashboard;
    const recorded = recordRateLimits(account, result);
    outcome.updatedAt = recorded.updatedAt;
    outcome.rateLimits = "updated";
    outcome.loggedIn = true;
    markAuthValidated(account);
    clearAuthenticationFailure(account);
    queueAccountQuotaAlerts(account, previousDashboard);
  } catch (error) {
    if (deletingAccountIds.has(account.id) || !store.accounts.some(item => item.id === account.id)) return outcome;
    outcome.rateLimits = "failed";
    outcome.error = redactString(error.message || String(error));
    if (isAuthenticationError(error)) {
      markAuthIssue(account, error);
      outcome.authIssue = true;
      if (!error.authFailureRecorded) {
        recordAuthenticationFailure(account, "Authentication failed during quota refresh");
      }
    }
  }
  if (canReadMetrics && store.accounts.includes(account) && !deletingAccountIds.has(account.id)) {
    outcome.metrics = (await refreshAccountMetrics(account, { force: forceMetrics, accountIdentity })).status;
    if (outcome.metrics === "superseded" && store.accounts.includes(account) && !deletingAccountIds.has(account.id)) {
      account.metrics.nextAt = null;
      outcome.metrics = (await refreshAccountMetrics(account, { force: true })).status;
    }
  }
  return outcome;
}

function claudeQuotaStatus(account) {
  const state = claudeQuota.get(account.id);
  const observedAt = account.dashboard.rateLimits?.updatedAt || null;
  const live = Boolean(state?.live && Date.now() - Date.parse(observedAt) <= 2 * CLAUDE_POLL_MS);
  return { live, observedAt, detail: live ? null : state?.detail || null };
}

function normalizedClaudeLimits(result) {
  if (!result?.rateLimits) throw new ClaudeError("quota-format");
  const { primary, secondary } = result.rateLimits;
  const now = Date.now() / 1000;
  function window(value, duration) {
    if (value === null) return null;
    if (value?.windowDurationMins !== duration || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100
      || !Number.isSafeInteger(value.resetsAt) || value.resetsAt <= now || value.resetsAt > now + (duration + 1) * 60) {
      throw new ClaudeError("quota-format");
    }
    return { usedPercent: value.usedPercent, resetsAt: value.resetsAt, windowDurationMins: duration };
  }
  const rateLimits = { primary: window(primary, 300), secondary: window(secondary, 10080) };
  if (!rateLimits.primary && !rateLimits.secondary) throw new ClaudeError("quota-format");
  return { rateLimits };
}

function refreshClaudeAccount(account, force = false) {
  if (claudeRefreshes.has(account.id)) return claudeRefreshes.get(account.id);
  const refresh = (async () => {
    const result = { accountId: account.id, accountLabel: account.label, rateLimits: "skipped", error: null };
    const state = claudeQuota.get(account.id);
    if (deletingAccountIds.has(account.id) || !claude.configured || claudeRuns.has(account.id)
      || state?.retryAt > Date.now() || (!force && state?.nextAt > Date.now())) return result;
    try {
      // A usage request validates the subscription again inside the worker.
      const cachedAuth = authStatusCacheByAccount.get(account.id)?.status;
      const auth = cachedAuth?.loggedIn && !cachedAuth.probeUnavailable ? cachedAuth : await getAuthStatus(account, force);
      result.loggedIn = auth.loggedIn;
      if (deletingAccountIds.has(account.id) || !store.accounts.includes(account)) return result;
      if (auth.probeUnavailable) throw new Error(auth.detail);
      if (!auth.loggedIn && !auth.credentialPresent) {
        claudeQuota.set(account.id, { live: false, nextAt: Date.now() + CLAUDE_POLL_MS, detail: auth.detail });
        if (account.enabled) recordAuthenticationFailure(account, auth.detail);
        return result;
      }
      const response = await claude.call("usage", account.id);
      const limits = normalizedClaudeLimits(response);
      if (deletingAccountIds.has(account.id) || !store.accounts.includes(account)) return result;
      const previousDashboard = account.dashboard;
      account.metrics ||= emptyMetrics("claude");
      if (typeof response.identity === "string" && /^[a-f0-9]{64}$/.test(response.identity)) {
        bindMetricsIdentity(account.metrics, `claude:${response.identity}`, response.identity);
      }
      account.metrics.status = "unsupported";
      account.metrics.extraUsage = normalizeExtraUsage(response.rateLimits?.extraUsage
        ? { ...response.rateLimits.extraUsage, updatedAt: nowIso() } : null);
      claudeQuota.set(account.id, { live: true, nextAt: Date.now() + CLAUDE_POLL_MS });
      const recorded = recordRateLimits(account, limits);
      result.rateLimits = "updated";
      result.updatedAt = recorded.updatedAt;
      markAuthValidated(account);
      clearAuthenticationFailure(account);
      queueAccountQuotaAlerts(account, previousDashboard);
      await saveStore();
    } catch (error) {
      if (deletingAccountIds.has(account.id) || !store.accounts.includes(account)) return result;
      if (error.code === "busy" || error.code === "interrupted") return result;
      claudeQuota.set(account.id, { live: false, nextAt: Date.now() + CLAUDE_POLL_MS, retryAt: error.retryAt, detail: error.message });
      result.rateLimits = "failed";
      result.error = error.message;
      if (["signed-out", "wrong-auth", "account-changed", "auth-expired"].includes(error.code)) {
        markAuthIssue(account, error);
        if (account.enabled) recordAuthenticationFailure(account, error.message);
      }
    }
    return result;
  })().finally(() => claudeRefreshes.delete(account.id));
  claudeRefreshes.set(account.id, refresh);
  return refresh;
}

async function refreshAllAccountStates(trigger = "manual") {
  if (!stateRefreshPromise) {
    stateRefreshPromise = Promise.all(store.accounts.filter((account) => account.provider === "codex")
      .map(account => refreshAccountState(account, trigger === "request"))).finally(() => {
      stateRefreshPromise = null;
    });
  }
  const [codex, claudeResults] = await Promise.all([
    stateRefreshPromise,
    trigger === "adaptive" ? [] : Promise.all(store.accounts.filter((account) => account.provider === "claude")
      .map((account) => refreshClaudeAccount(account, trigger === "request")))
  ]);
  lastStateRefreshFailed = codex.some((result) => result.rateLimits === "failed");
  const accounts = [...codex, ...claudeResults];
  const summary = {
    attempted: accounts.length,
    updated: accounts.filter((account) => account.rateLimits === "updated").length,
    skipped: accounts.filter((account) => account.rateLimits === "skipped").length,
    failed: accounts.filter((account) => account.rateLimits === "failed").length
  };
  if (summary.updated) await saveStore();
  addActivity("refresh", summary.failed ? "warn" : "info", "State refresh completed", { trigger, ...summary, accounts });
  broadcast("status", { ts: nowIso() });
  return { ts: nowIso(), ...summary, accounts };
}

function updateDashboardState(accountId, message) {
  const account = store.accounts.find((item) => item.id === accountId);
  if (!account) {
    return;
  }
  const params = message.params || {};
  account.dashboard ||= structuredClone(DEFAULT_DASHBOARD);

  if (message.method === "account/rateLimits/updated" && params.rateLimits) {
    const previousDashboard = account.dashboard;
    const recorded = recordRateLimits(account, params.rateLimits, true);
    queueAccountQuotaAlerts(account, previousDashboard);
    void saveStore();
    if (recorded.activityDetected) {
      scheduleNextStateRefresh(true);
    }
  }

  if (message.method === "item/completed" && params.item?.type === "userMessage") {
    const text = getFirstTextContent(params.item.content);
    account.dashboard.lastUserMessage = {
      ts: nowIso(),
      threadId: params.threadId || null,
      turnId: params.turnId || null,
      text
    };
    void saveStore();
  }

  if (message.method === "item/completed" && params.item?.type === "agentMessage") {
    account.dashboard.lastAgentMessage = {
      ts: nowIso(),
      threadId: params.threadId || null,
      turnId: params.turnId || null,
      text: params.item.text || ""
    };
    void saveStore();
  }

  if (message.method === "turn/completed") {
    account.dashboard.lastCompletedTurn = {
      ts: nowIso(),
      threadId: params.threadId || null,
      turnId: params.turn?.id || null,
      status: params.turn?.status || null,
      error: params.turn?.error || null,
      durationMs: params.turn?.durationMs || null
    };
    void saveStore();
  }
  syncScheduledRunFromTurn(accountId, message, true);
  if (account.id === store.selectedAccountId) {
    store.dashboard = account.dashboard;
  }
}

async function ensureThread(accountId = store.selectedAccountId, selectedModel = null) {
  const account = requireAccount(accountId);
  const appServer = getAppServer(account.id);
  const auth = await getAuthStatus(account, true);
  if (!auth.loggedIn) {
    throw new Error(`${account.label} is not logged in`);
  }

  const settings = effectiveSettings(account);
  const selection = selectedModel || chooseModel(await appServer.models(), settings.model);
  const common = {
    serviceName: SERVICE_NAME,
    model: selection.model,
    cwd: settings.workspaceDir || DEFAULT_WORKSPACE_DIR
  };

  if (account.threadState.threadId) {
    try {
      const result = await appServer.send("thread/resume", {
        threadId: account.threadState.threadId,
        ...common
      });
      const thread = result?.thread || {};
      account.threadState = {
        ...account.threadState,
        threadId: thread.id || account.threadState.threadId,
        sessionId: thread.sessionId || account.threadState.sessionId,
        name: thread.name || account.threadState.name,
        updatedAt: nowIso()
      };
      if (account.id === store.selectedAccountId) {
        store.threadState = account.threadState;
      }
      await saveStore();
      return account.threadState.threadId;
    } catch (error) {
      addActivity("codex", "error", "Failed to resume stored thread; creating a new one", {
        accountId: account.id,
        accountLabel: account.label,
        threadId: account.threadState.threadId,
        error: error.message
      });
      account.threadState.threadId = null;
      account.threadState.sessionId = null;
    }
  }

  const result = await appServer.send("thread/start", {
    ...common,
    approvalPolicy: normalizeApprovalPolicy(store.settings.approvalPolicy),
    sandbox: "workspace-write"
  });
  const thread = result?.thread || {};
  if (!thread.id) {
    throw new Error("Codex did not return a thread id");
  }
  account.threadState = {
    ...account.threadState,
    threadId: thread.id,
    sessionId: thread.sessionId || thread.id,
    name: thread.name || null,
    updatedAt: nowIso()
  };
  if (account.id === store.selectedAccountId) {
    store.threadState = account.threadState;
  }
  await saveStore();
  addActivity("codex", "info", "Created Codex thread", {
    accountId: account.id,
    accountLabel: account.label,
    threadId: thread.id,
    sessionId: thread.sessionId
  });
  return thread.id;
}

function renderPrompt(template, scheduledTime, reason) {
  const local = getLocalParts(new Date(), store.settings.timezone);
  return template
    .replaceAll("{{local_time}}", `${local.date} ${local.time} ${store.settings.timezone}`)
    .replaceAll("{{scheduled_time}}", scheduledTime || "")
    .replaceAll("{{reason}}", reason || "scheduled");
}

function buildSandboxPolicy(account) {
  const settings = effectiveSettings(account);
  const workspaceDir = settings.workspaceDir || DEFAULT_WORKSPACE_DIR;
  return {
    type: "workspaceWrite",
    writableRoots: [workspaceDir],
    networkAccess: Boolean(store.settings.networkAccess)
  };
}

function terminalTurnOutcome(message) {
  const method = String(message?.method || "");
  if (!/^turn\/(completed|failed|cancelled|aborted|interrupted)$/.test(method)) {
    return null;
  }
  const params = message.params || {};
  const turn = params.turn || {};
  const methodStatus = method.slice("turn/".length);
  let status = methodStatus;
  if (methodStatus === "completed") {
    status = turn.error || params.error ? "failed" : turn.status || "completed";
  }
  return {
    turnId: turn.id || params.turnId || null,
    status,
    error: turn.error || params.error ? redact(turn.error || params.error) : null,
    completedAt: message.ts || nowIso()
  };
}

function syncScheduledRunFromTurn(accountId, message, persist) {
  const outcome = terminalTurnOutcome(message);
  if (!accountId || !outcome?.turnId || !Array.isArray(store.scheduledRuns)) {
    return false;
  }
  const run = [...store.scheduledRuns].reverse().find(
    (item) => item.accountId === accountId && item.turnId === outcome.turnId
  );
  if (!run) {
    return false;
  }
  run.status = outcome.status;
  run.error = outcome.error;
  run.completedAt = outcome.completedAt;
  if (persist
    && run.reason === "scheduled"
    && outcome.status !== "completed"
    && !run.failureAlertQueued) {
    run.failureAlertQueued = queueOperationalFailureAlert(
      requireAccount(accountId),
      `Scheduled Codex turn ended as ${outcome.status}; check Activity for details`,
      "send-failure", { runId: run.id }
    );
  }
  if (persist) {
    addScheduledRun(run);
  }
  return true;
}

function reconcileScheduledRuns() {
  if (!Array.isArray(store.activityEvents)) {
    return;
  }
  for (const event of store.activityEvents) {
    syncScheduledRunFromTurn(event.payload?.accountId, {
      method: event.message,
      params: event.payload,
      ts: event.ts
    }, false);
  }
  for (const run of store.scheduledRuns) {
    if (run.provider === "claude" && ["starting", "started"].includes(run.status)) {
      run.status = "interrupted";
      run.error = new ClaudeError("interrupted").message;
      run.completedAt = nowIso();
    }
  }
}

function addScheduledRun(run) {
  const existingIndex = store.scheduledRuns.findIndex((item) => item.id === run.id);
  if (existingIndex >= 0) {
    store.scheduledRuns[existingIndex] = { ...run };
  } else {
    store.scheduledRuns.push({ ...run });
  }
  store.scheduledRuns = store.scheduledRuns.slice(-500);
  void saveStore();
  broadcast("run", run);
}

async function startTurn({ accountId = store.selectedAccountId, reason, scheduleKey = null, scheduledTime = null, prompt = null }) {
  const account = requireAccount(accountId);
  if (account.provider === "claude") return startClaudeTurn(account, { reason, scheduleKey, scheduledTime, prompt });
  const appServer = getAppServer(account.id);
  const run = {
    id: randomUUID(),
    ts: nowIso(),
    accountId: account.id,
    accountLabel: account.label,
    scheduleKey,
    scheduledTime,
    reason,
    status: "starting",
    threadId: account.threadState.threadId,
    turnId: null,
    error: null
  };
  addScheduledRun(run);

  try {
    const settings = effectiveSettings(account);
    const selection = chooseModel(await appServer.models(), settings.model);
    run.model = selection.model;
    const threadId = await ensureThread(account.id, selection);
    run.threadId = threadId;

    if (store.settings.skipIfActive && appServer.isThreadActive(threadId)) {
      run.status = "skipped_active_turn";
      addScheduledRun(run);
      addActivity("scheduler", "warn", "Skipped send because the Codex thread is active", {
        accountId: account.id,
        accountLabel: account.label,
        threadId,
        reason
      });
      return run;
    }

    const inputText = prompt || renderPrompt(settings.promptTemplate, scheduledTime, reason);
    const params = {
      threadId,
      model: selection.model,
      serviceTier: "default",
      input: [{ type: "text", text: inputText }],
      cwd: settings.workspaceDir || DEFAULT_WORKSPACE_DIR,
      sandboxPolicy: buildSandboxPolicy(account),
      approvalPolicy: normalizeApprovalPolicy(store.settings.approvalPolicy),
      summary: store.settings.summary || "concise"
    };
    if (store.settings.effort) {
      const supported = selection.supportedReasoningEfforts?.map((entry) => entry.reasoningEffort) || [];
      params.effort = !supported.length || supported.includes(store.settings.effort)
        ? store.settings.effort : selection.defaultReasoningEffort;
    }

    const result = await appServer.send("turn/start", params);
    const turn = result?.turn || {};
    run.turnId = turn.id || null;
    run.status = turn.status || "started";
    appServer.threadStatuses.set(threadId, { type: "active", activeFlags: ["turn"] });
    addScheduledRun(run);
    addActivity("scheduler", "info", "Started Codex turn", {
      accountId: account.id,
      accountLabel: account.label,
      runId: run.id,
      threadId,
      turnId: run.turnId,
      reason
    });
    return run;
  } catch (error) {
    run.status = "failed";
    run.error = error.message;
    addScheduledRun(run);
    addActivity("scheduler", "error", "Failed to start Codex turn", {
      accountId: account.id,
      accountLabel: account.label,
      runId: run.id,
      error: error.message
    });
    if (isAuthenticationError(error)) {
      markAuthIssue(account, error);
      if (reason === "scheduled" && !error.authFailureRecorded) {
        recordAuthenticationFailure(account, "Authentication failed during scheduled Codex send");
      }
    }
    if (reason === "scheduled" && !isAuthenticationError(error)) {
      queueOperationalFailureAlert(account, "Scheduled Codex send failed; check Activity for details", "send-failure", { runId: run.id });
    }
    return run;
  }
}

function startClaudeTurn(account, { reason, scheduleKey, scheduledTime, prompt }) {
  const resumed = CLAUDE_SESSION_ID.test(account.threadState.sessionId || "");
  const sessionId = resumed ? account.threadState.sessionId : randomUUID();
  const run = {
    id: randomUUID(), provider: "claude", ts: nowIso(), accountId: account.id, accountLabel: account.label,
    scheduleKey, scheduledTime, reason, status: "started", threadId: sessionId, turnId: randomUUID(), error: null
  };
  if (claudeRuns.has(account.id)) {
    run.status = "skipped_active_turn";
    run.turnId = null;
    addScheduledRun(run);
    return run;
  }
  const input = prompt || renderPrompt(effectiveSettings(account).promptTemplate, scheduledTime, reason);
  addScheduledRun(run);
  const task = finishClaudeTurn(account, run, input, sessionId, resumed).finally(() => {
    claudeRuns.delete(account.id);
    broadcast("status", { ts: nowIso() });
  });
  claudeRuns.set(account.id, task);
  return { ...run };
}

async function finishClaudeTurn(account, run, prompt, sessionId, resumed) {
  const startedAt = Date.now();
  const attribution = { accountId: account.id, accountLabel: account.label, threadId: sessionId, turnId: run.turnId, reason: run.reason };
  let reply;
  try {
    await saveStore();
    if (deletingAccountIds.has(account.id) || !store.accounts.includes(account)) throw new ClaudeError("interrupted");
    const response = await claude.call("run", account.id, { prompt, sessionId, resume: resumed });
    if (response.sessionId !== sessionId || typeof response.reply !== "string") throw new ClaudeError("failed");
    if (deletingAccountIds.has(account.id) || !store.accounts.includes(account)) throw new ClaudeError("interrupted");
    reply = redactString(response.reply).slice(0, 4000);
    Object.assign(account.threadState, { threadId: sessionId, sessionId, updatedAt: nowIso() });
    account.dashboard.lastUserMessage = { ...attribution, ts: run.ts, text: redactString(prompt).slice(0, 4000) };
    account.dashboard.lastAgentMessage = { ...attribution, ts: nowIso(), text: reply };
    markAuthValidated(account);
    clearAuthenticationFailure(account);
    run.status = "completed";
  } catch (error) {
    run.status = error.code === "interrupted" ? "interrupted" : error.code === "busy" ? "skipped_active_turn" : "failed";
    run.error = error instanceof ClaudeError ? error.message : new ClaudeError("failed").message;
    if (error.code === "session-missing") Object.assign(account.threadState, { sessionId: null, threadId: null });
    if (store.accounts.includes(account) && !deletingAccountIds.has(account.id)) {
      if (["signed-out", "auth-expired", "wrong-auth", "account-changed"].includes(error.code)) {
        markAuthIssue(account, error);
        claudeQuota.set(account.id, { ...claudeQuota.get(account.id), live: false, detail: error.message });
        if (run.reason === "scheduled") recordAuthenticationFailure(account, error.message);
      } else if (run.reason === "scheduled" && run.status === "failed") {
        queueOperationalFailureAlert(account, "Scheduled Claude send failed; check Activity for details", "send-failure", { runId: run.id });
      }
    }
  }
  if (!store.accounts.includes(account)) return;
  run.completedAt = nowIso();
  const turn = { id: run.turnId, status: run.status, error: run.error, durationMs: Date.now() - startedAt };
  if (run.status !== "skipped_active_turn") {
    account.dashboard.lastCompletedTurn = { ts: run.completedAt, threadId: sessionId, turnId: run.turnId, ...turn };
  }
  if (reply !== undefined) {
    addActivity("claude", "info", "item/completed", { ...attribution, item: { type: "agentMessage", text: reply } });
  }
  addActivity("claude", run.status === "failed" ? "error" : "info", "turn/completed", { ...attribution, turn });
  addScheduledRun(run);
}

function getLocalParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    time: `${value.hour}:${value.minute}`,
    second: value.second
  };
}

function nextRunSummary() {
  const timezone = store.settings.timezone;
  const now = getLocalParts(new Date(), timezone);
  const enabledAccounts = store.accounts.filter(accountScheduled);
  const timeSets = enabledAccounts.map((account) => effectiveSettings(account).scheduleTimes);
  const times = [...new Set(timeSets.length ? timeSets.flat() : store.settings.scheduleTimes)].sort();
  const todayNext = times.find((time) => time > now.time);
  return {
    timezone,
    localNow: `${now.date} ${now.time}:${now.second}`,
    nextLocal: todayNext ? `${now.date} ${todayNext}` : `tomorrow ${times[0] || "none"}`
  };
}

function accountScheduled(account) {
  return account.enabled && !deletingAccountIds.has(account.id) && (account.provider === "codex" || claude.configured);
}

async function schedulerTick() {
  if (!store.settings.schedulerEnabled) {
    return;
  }
  const local = getLocalParts(new Date(), store.settings.timezone);
  const key = `${local.date}T${local.time}`;
  for (const account of store.accounts.filter(accountScheduled)) {
    if (!effectiveSettings(account).scheduleTimes.includes(local.time)) {
      continue;
    }
    if (account.threadState.lastScheduleKey === key) {
      continue;
    }
    account.threadState.lastScheduleKey = key;
    account.threadState.updatedAt = nowIso();
    if (account.id === store.selectedAccountId) {
      store.threadState = account.threadState;
    }
    await saveStore();
    if (!store.accounts.includes(account) || !accountScheduled(account) || shuttingDown) continue;
    addActivity("scheduler", "info", "Schedule matched", {
      accountId: account.id,
      accountLabel: account.label,
      key,
      localTime: local.time
    });
    void startTurn({ accountId: account.id, reason: "scheduled", scheduleKey: key, scheduledTime: local.time });
  }
}

let schedulerTimer = null;
let stateRefreshTimer = null;
let stateRefreshNextAt = null;
let lastStateRefreshFailed = false;

function startScheduler() {
  if (schedulerTimer) {
    return;
  }
  schedulerTimer = setInterval(() => {
    void schedulerTick();
  }, 10_000);
  void schedulerTick();
}

function stateRefreshSchedule(nowMs = Date.now()) {
  const activityTimes = store.accounts
    .filter((account) => account.provider === "codex")
    .map((account) => latestUsageActivityAt(account.usageHistory))
    .filter(Boolean)
    .sort();
  const lastActivityAt = activityTimes.at(-1) || null;
  const adaptiveIntervalMs = adaptivePollingInterval(lastActivityAt, nowMs);
  const intervalMs = lastStateRefreshFailed ? Math.max(adaptiveIntervalMs, 2 * 60 * 1000) : adaptiveIntervalMs;
  return {
    lastActivityAt,
    intervalMs,
    nextAt: new Date(nowMs + intervalMs).toISOString()
  };
}

function scheduleNextStateRefresh(soonerOnly = false) {
  if (shuttingDown) {
    return;
  }
  const schedule = stateRefreshSchedule();
  const nextMs = Date.parse(schedule.nextAt);
  if (soonerOnly && stateRefreshTimer && Number.isFinite(Date.parse(stateRefreshNextAt || ""))
    && Date.parse(stateRefreshNextAt) <= nextMs) {
    return;
  }
  clearTimeout(stateRefreshTimer);
  stateRefreshNextAt = schedule.nextAt;
  stateRefreshTimer = setTimeout(async () => {
    stateRefreshTimer = null;
    stateRefreshNextAt = null;
    try {
      await refreshAllAccountStates("adaptive");
    } catch (error) {
      lastStateRefreshFailed = true;
      addActivity("refresh", "error", "Adaptive state refresh failed", { error: error.message });
    } finally {
      scheduleNextStateRefresh();
    }
  }, Math.max(1000, nextMs - Date.now()));
}

function startStateRefresh() {
  if (!telegramRetryTimer) {
    telegramRetryTimer = setInterval(() => {
      queueResetReminders();
      void flushTelegramOutbox();
    }, 60 * 1000);
    queueResetReminders();
    void flushTelegramOutbox();
  }
  if (claude.configured && !claudeRefreshTimer) {
    claudeRefreshTimer = setInterval(() => void refreshDueClaudeAccounts(), 30_000);
  }
  if (stateRefreshTimer) {
    return;
  }
  void refreshAllAccountStates("startup")
    .catch((error) => {
      lastStateRefreshFailed = true;
      addActivity("refresh", "error", "Startup state refresh failed", { error: error.message });
    })
    .finally(() => scheduleNextStateRefresh());
}

async function refreshDueClaudeAccounts() {
  const results = await Promise.all(store.accounts
    .filter((account) => account.provider === "claude")
    .map((account) => refreshClaudeAccount(account)));
  if (results.some(({ rateLimits }) => rateLimits !== "skipped")) broadcast("status", { ts: nowIso() });
}

function parseAdminEmails() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function getHeader(req, name) {
  return req.headers[name.toLowerCase()];
}

function isAuthorized(req) {
  const allowed = parseAdminEmails();
  if (allowed.length === 0) {
    return true;
  }
  const email = String(getHeader(req, "cf-access-authenticated-user-email") || getHeader(req, "x-authenticated-user-email") || "")
    .trim()
    .toLowerCase();
  return allowed.includes(email);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    // Drain a moderately oversized body so the client reads the 413 instead of a connection reset.
    if (bytes > 8_000_000) {
      throw httpError(413, "Request body too large");
    }
    if (bytes <= 1_000_000) {
      chunks.push(chunk);
    }
  }
  if (bytes > 1_000_000) {
    throw httpError(413, "Request body too large");
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "Request body must be a JSON object");
  }
  return body;
}

// Browsers attach these headers themselves, so another site cannot forge a same-origin request.
function isCrossSiteRequest(req) {
  const site = req.headers["sec-fetch-site"];
  if (site) return site !== "same-origin" && site !== "none";
  if (!req.headers.origin) return false;
  try {
    return new URL(req.headers.origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

function accountIdFromUrl(url) {
  return url.searchParams.get("accountId") || store.selectedAccountId;
}

function validateTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

async function patchSettings(body) {
  const next = patchTelegramSettings(store.settings, body);
  if (body.timezone !== undefined) {
    if (!validateTimezone(body.timezone)) {
      throw httpError(400, "Invalid timezone");
    }
    next.timezone = body.timezone;
  }
  if (body.scheduleTimes !== undefined) {
    if (!Array.isArray(body.scheduleTimes) || body.scheduleTimes.length === 0 || !body.scheduleTimes.every(validateTime)) {
      throw httpError(400, "scheduleTimes must be a non-empty HH:mm array");
    }
    next.scheduleTimes = [...new Set(body.scheduleTimes)].sort();
  }
  for (const key of [
    "schedulerEnabled",
    "networkAccess",
    "skipIfActive",
    "telegramAlertsEnabled",
    "telegramAlertQuotaResets",
    "telegramAlertReserve",
    "telegramAlertResetCredits",
    "telegramAlertFailures"
  ]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") {
        throw httpError(400, `${key} must be a boolean`);
      }
      next[key] = body[key];
    }
  }
  for (const key of ["promptTemplate", "model", "effort", "summary", "approvalPolicy", "workspaceDir"]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string") {
        throw httpError(400, `${key} must be a string`);
      }
      next[key] = body[key];
    }
  }
  next.approvalPolicy = normalizeApprovalPolicy(next.approvalPolicy);
  if (next.telegramAlertsEnabled && !telegramConfigured()) {
    throw httpError(400, "Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID before enabling Telegram alerts");
  }
  if (!next.promptTemplate.trim()) {
    throw httpError(400, "promptTemplate cannot be empty");
  }
  store.settings = next;
  await saveStore();
  addActivity("settings", "info", "Settings updated", { settings: store.settings });
  if (store.settings.telegramAlertsEnabled) {
    queueResetReminders();
    void flushTelegramOutbox();
  }
  return publicSettings();
}

function getLoginSession(accountId = store.selectedAccountId) {
  return loginSessions.get(accountId) || { status: "none", accountId };
}

function startDeviceLogin(accountId = store.selectedAccountId) {
  const account = requireAccount(accountId);
  const current = loginSessions.get(account.id);
  if (current?.status === "running") {
    return current;
  }
  const session = {
    id: randomUUID(),
    accountId: account.id,
    accountLabel: account.label,
    status: "running",
    startedAt: nowIso(),
    finishedAt: null,
    output: [],
    exitCode: null
  };
  loginSessions.set(account.id, session);
  addAuthEvent("Started Codex device login", { accountId: account.id, accountLabel: account.label, sessionId: session.id });

  const child = trackAccountProcess(account.id, spawn("codex", ["login", "--device-auth"], {
    cwd: workspaceCwd(),
    env: codexEnv(account),
    stdio: ["pipe", "pipe", "pipe"]
  }));

  const append = (stream, chunk) => {
    const text = redactString(chunk.toString("utf8"));
    if (!text.trim()) {
      return;
    }
    const entry = { ts: nowIso(), stream, text };
    session.output.push(entry);
    session.output = session.output.slice(-200);
    broadcast("login", { accountId: account.id, sessionId: session.id, ...entry });
    addActivity("auth", stream === "stderr" ? "warn" : "info", "Device login output", {
      accountId: account.id,
      accountLabel: account.label,
      stream,
      text
    });
  };

  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  child.on("error", (error) => {
    session.status = "failed";
    session.finishedAt = nowIso();
    session.output.push({ ts: nowIso(), stream: "error", text: error.message });
    addAuthEvent("Codex device login failed to start", { accountId: account.id, accountLabel: account.label, sessionId: session.id, error: error.message });
    broadcast("login", session);
  });
  child.on("close", async (code) => {
    if (deletingAccountIds.has(account.id) || !store.accounts.some(item => item.id === account.id)) return;
    session.status = code === 0 ? "completed" : "failed";
    session.exitCode = code;
    session.finishedAt = nowIso();
    addAuthEvent("Codex device login finished", { accountId: account.id, accountLabel: account.label, sessionId: session.id, code });
    if (code === 0) {
      markAuthValidated(account);
      clearAuthenticationFailure(account);
      try {
        await getAppServer(account.id).restart();
        account.metrics.nextAt = null;
        await refreshAccountState(account, true);
        await ensureThread(account.id);
      } catch (error) {
        addActivity("codex", "error", "Post-login app-server startup failed", {
          accountId: account.id,
          accountLabel: account.label,
          error: error.message
        });
      }
    } else {
      await getAuthStatus(account, true);
    }
    broadcast("login", session);
  });
  child.stdin.end();
  return session;
}

async function logoutCodex(accountId = store.selectedAccountId) {
  const account = requireAccount(accountId);
  getAppServer(account.id, false)?.stop();
  const result = await runCodex(["logout"], { account, timeoutMs: 30000 });
  if (result.code === 0) {
    const status = {
      loggedIn: false,
      credentialPresent: false,
      authIssue: false,
      mode: "none",
      detail: "Logged out",
      code: result.code
    };
    authStatusCacheByAccount.set(account.id, { checkedAt: Date.now(), status });
    clearAuthenticationFailure(account);
    loginSessions.delete(account.id);
    store.telegramAlertState.intentionalLogouts[account.id] = true;
    void saveStore();
  } else {
    await getAuthStatus(account, true);
  }
  addAuthEvent(result.code === 0 ? "Logged out Codex credentials" : "Codex logout failed", {
    accountId: account.id,
    accountLabel: account.label,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  });
  return result;
}

function claudeHttpError(error) {
  if (!(error instanceof ClaudeError)) return error;
  error.statusCode = error.code === "busy" ? 409
    : ["unavailable", "disabled"].includes(error.code) ? 503 : 422;
  return error;
}

async function logoutClaude(account) {
  if (claudeRuns.has(account.id)) throw claudeHttpError(new ClaudeError("busy"));
  await claude.call("logout", account.id).catch((error) => { throw claudeHttpError(error); });
  loginSessions.delete(account.id);
  const status = { ...unknownAuthStatus(), mode: "none", detail: "Signed out of Claude Code", code: 0 };
  authStatusCacheByAccount.set(account.id, { checkedAt: Date.now(), status });
  authStatusProbeAtByAccount.delete(account.id);
  claudeQuota.set(account.id, { live: false, detail: status.detail, nextAt: Date.now() + CLAUDE_POLL_MS });
  clearAuthenticationFailure(account);
  store.telegramAlertState.intentionalLogouts[account.id] = true;
  await saveStore();
  addAuthEvent("Signed out of Claude Code", { accountId: account.id, accountLabel: account.label });
  return { code: 0 };
}

async function claudeBrowserLogin(action, account, data = {}) {
  if (account.provider !== "claude") {
    const error = new Error("This sign-in flow is for Claude accounts.");
    error.statusCode = 422;
    throw error;
  }
  const session = await claude.call(action, account.id, data).catch((error) => { throw claudeHttpError(error); });
  const previous = loginSessions.get(account.id);
  // Keep only progress metadata here; never persist the URL, CLI output, or code.
  loginSessions.set(account.id, { id: session.id, accountId: account.id, status: session.status });
  if (session.id && (previous?.id !== session.id || previous.status !== session.status)) {
    addAuthEvent(`Claude browser sign-in ${session.status === "running" ? "started" : session.status}`, {
      accountId: account.id, accountLabel: account.label
    });
    if (session.status === "completed") {
      authStatusCacheByAccount.delete(account.id);
      authStatusProbeAtByAccount.delete(account.id);
      clearAuthenticationFailure(account);
      delete store.telegramAlertState.intentionalLogouts[account.id];
      void refreshClaudeAccount(account, true).then(() => broadcast("status", { accountId: account.id }));
    }
  }
  return session;
}

async function handleApi(req, res, url) {
  // Liveness carries no account data and must answer container probes that have no Access identity.
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, ts: nowIso() });
  }

  if (!isAuthorized(req)) {
    return sendError(res, 403, "Forbidden");
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && isCrossSiteRequest(req)) {
    return sendError(res, 403, "Forbidden");
  }

  if (url.pathname.startsWith("/api/auth/claude/")) {
    if (req.method === "GET" && url.pathname === "/api/auth/claude/current") {
      return sendJson(res, 200, await claudeBrowserLogin("login-current", requireAccount(accountIdFromUrl(url))));
    }
    const actions = { "/api/auth/claude/start": "login-start", "/api/auth/claude/code": "login-code", "/api/auth/claude/cancel": "login-cancel" };
    if (req.method !== "POST" || !Object.hasOwn(actions, url.pathname)) return sendError(res, 404, "Not found");
    // Browser sign-in mutations must be same-origin JSON requests, never cross-site form posts.
    let sameOrigin = true;
    try { if (req.headers.origin) sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { sameOrigin = false; }
    if (!sameOrigin || req.headers["sec-fetch-site"] === "cross-site"
      || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) return sendError(res, 403, "Forbidden");
    let body;
    try { body = await readJson(req); } catch { return sendError(res, 400, "Invalid sign-in request."); }
    const account = requireAccount(body.accountId || store.selectedAccountId);
    return sendJson(res, 200, await claudeBrowserLogin(actions[url.pathname], account, {
      sessionId: body.sessionId, code: body.code
    }));
  }

  if (req.method === "GET" && url.pathname === "/api/usage-metrics") {
    const provider = url.searchParams.get("provider") || "";
    const range = url.searchParams.get("range") || "30d";
    const accountId = url.searchParams.get("accountId") || "";
    if (provider && !["codex", "claude"].includes(provider)) return sendError(res, 400, "Unknown provider");
    if (!["today", "7d", "30d", "90d", "lifetime"].includes(range)) return sendError(res, 400, "Unknown metrics range");
    if (accountId) requireAccount(accountId);
    return sendJson(res, 200, buildUsageMetrics(store.accounts, {
      provider, accountId, range, claudeLive: account => claudeQuotaStatus(account).live
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/refresh") {
    const result = await refreshAllAccountStates("request");
    scheduleNextStateRefresh();
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/usage-history") {
    const account = requireAccount(url.searchParams.get("accountId"));
    const ranges = { "6h": 6 * 60 * 60 * 1000, "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000, "30d": 30 * 24 * 60 * 60 * 1000 };
    const range = Object.hasOwn(ranges, url.searchParams.get("range")) ? url.searchParams.get("range") : "24h";
    const cutoff = Date.now() - ranges[range];
    const history = normalizeUsageHistory(account.usageHistory);
    const firstInRange = history.findIndex((sample) => Date.parse(sample.ts) >= cutoff);
    const baseline = firstInRange > 0
      ? history[firstInRange - 1]
      : firstInRange === -1 ? history.at(-1) || null : null;
    const schedule = stateRefreshSchedule();
    const claudeState = claudeQuota.get(account.id);
    return sendJson(res, 200, {
      accountId: account.id,
      range,
      baseline,
      samples: firstInRange === -1 ? [] : history.slice(Math.max(0, firstInRange)),
      observedAt: account.usageObservedAt,
      polling: account.provider === "claude" ? {
        intervalMs: CLAUDE_POLL_MS,
        lastActivityAt: latestUsageActivityAt(history),
        nextAt: claudeState?.nextAt && new Date(Math.max(claudeState.nextAt, claudeState.retryAt || 0)).toISOString()
      } : {
        intervalMs: schedule.intervalMs,
        lastActivityAt: schedule.lastActivityAt,
        nextAt: stateRefreshNextAt || schedule.nextAt
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      connection: "keep-alive"
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: nowIso() })}\n\n`);
    sseClients.add(res);
    // Idle streams are cut by proxies; a comment line keeps the connection open.
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    refreshAuthStatusesInBackground();
    const claudeAvailable = await claude.available();
    const selected = requireAccount();
    const auth = authStatusCacheByAccount.get(selected.id)?.status || unknownAuthStatus();
    return sendJson(res, 200, {
      ts: nowIso(),
      claudeAvailable,
      selectedAccountId: selected.id,
      selectedAccount: publicAccount(selected),
      accounts: store.accounts.map(publicAccount),
      auth,
      appServer: publicAccount(selected).appServer,
      scheduler: {
        enabled: store.settings.schedulerEnabled,
        next: nextRunSummary()
      },
      thread: selected.threadState,
      latestRun: [...store.scheduledRuns].reverse().find((run) => run.accountId === selected.id) || null,
      dashboard: selected.dashboard || DEFAULT_DASHBOARD
    });
  }

  if (req.method === "GET" && url.pathname === "/api/accounts") {
    refreshAuthStatusesInBackground();
    return sendJson(res, 200, {
      selectedAccountId: store.selectedAccountId,
      accounts: store.accounts.map(publicAccount)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const body = await readJson(req);
    const provider = body.provider === undefined ? "codex" : body.provider;
    if (provider !== "codex" && provider !== "claude") return sendError(res, 400, "provider must be codex or claude");
    const account = createAccount(typeof body.label === "string" && body.label.trim() ? body.label.trim() : `Account ${store.accounts.length + 1}`, provider);
    if (provider === "codex" && typeof body.enabled === "boolean") account.enabled = body.enabled;
    if (provider === "claude") {
      await claude.call("prepare", account.id).catch((error) => { throw claudeHttpError(error); });
    }
    store.accounts.push(account);
    store.selectedAccountId = account.id;
    store.threadState = account.threadState;
    store.dashboard = account.dashboard;
    await ensureAccountDirs(account);
    await saveStore();
    addActivity("account", "info", "Account added", { accountId: account.id, accountLabel: account.label, provider });
    return sendJson(res, 200, { selectedAccountId: account.id, account: publicAccount(account), accounts: store.accounts.map(publicAccount) });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/accounts/")) {
    const accountId = decodeURIComponent(url.pathname.split("/").at(-1));
    const account = requireAccount(accountId);
    const body = await readJson(req);
    if (Object.hasOwn(body, "provider")) return sendError(res, 400, "An account's provider cannot be changed");
    if (body.settings !== undefined) {
      if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
        return sendError(res, 400, "settings must be an object");
      }
      for (const key of Object.keys(body.settings)) {
        if (!ACCOUNT_SETTING_KEYS.includes(key)) {
          return sendError(res, 400, `Unknown account setting: ${key}`);
        }
        if (account.provider === "claude" && (key === "model" || key === "workspaceDir")) {
          return sendError(res, 422, `settings.${key} is available for Codex accounts`);
        }
        const value = body.settings[key];
        if (key === "scheduleTimes") {
          if (value !== null && (!Array.isArray(value) || value.length === 0 || !value.every(validateTime))) {
            return sendError(res, 400, "settings.scheduleTimes must be a non-empty HH:mm array or null");
          }
        } else if (value !== null && typeof value !== "string") {
          return sendError(res, 400, `settings.${key} must be a string or null`);
        }
      }
    }
    if (account.provider === "claude" && body.enabled && !await claude.available()) {
      return sendError(res, 503, new ClaudeError(claude.configured ? "unavailable" : "disabled").message);
    }
    const nextBilling = body.billing !== undefined ? updateBilling(account.billing, body.billing) : account.billing;
    if (typeof body.label === "string" && body.label.trim()) {
      account.label = body.label.trim();
    }
    account.billing = nextBilling;
    if (body.enabled !== undefined) {
      account.enabled = Boolean(body.enabled);
    }
    if (body.settings !== undefined) {
      account.settings = applyAccountSettings(account.settings, body.settings);
    }
    if (body.selected === true) {
      store.selectedAccountId = account.id;
      store.threadState = account.threadState;
      store.dashboard = account.dashboard;
    }
    account.updatedAt = nowIso();
    await saveStore();
    addActivity("account", "info", "Account updated", { accountId: account.id, accountLabel: account.label, enabled: account.enabled, settings: account.settings });
    broadcast("metrics", { accountId: account.id });
    return sendJson(res, 200, { selectedAccountId: store.selectedAccountId, account: publicAccount(account), accounts: store.accounts.map(publicAccount) });
  }

  if (req.method === "POST" && url.pathname === "/api/accounts/select") {
    const body = await readJson(req);
    const account = requireAccount(body.accountId);
    store.selectedAccountId = account.id;
    store.threadState = account.threadState;
    store.dashboard = account.dashboard;
    await saveStore();
    addActivity("account", "info", "Account selected", { accountId: account.id, accountLabel: account.label });
    return sendJson(res, 200, { selectedAccountId: account.id, account: publicAccount(account), accounts: store.accounts.map(publicAccount) });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/accounts/")) {
    if (deletingAccountIds.size) return sendError(res, 409, "An account is already being removed. Wait for removal to finish.");
    const accountId = decodeURIComponent(url.pathname.split("/").at(-1));
    const account = requireAccount(accountId);
    if (store.accounts.length <= 1) {
      return sendError(res, 400, "Cannot delete the last remaining account");
    }
    deletingAccountIds.add(account.id);
    try {
      let removedCredentials;
      if (account.provider === "claude") {
        const removed = await claude.call("remove", account.id).catch((error) => { throw claudeHttpError(error); });
        if (removed.removed !== true) throw claudeHttpError(new ClaudeError("failed"));
        await claudeRuns.get(account.id);
        await claudeRefreshes.get(account.id);
        removedCredentials = true;
      } else {
        getAppServer(account.id, false)?.stop();
        await stopAccountProcesses(account.id);
      }
      await saveChain;
      if (account.provider === "codex") removedCredentials = await removeAccountHome(account.codeHome);
      appServers.delete(account.id);
      loginSessions.delete(account.id);
      authStatusCacheByAccount.delete(account.id);
      authStatusProbeAtByAccount.delete(account.id);
      claudeQuota.delete(account.id);
      delete store.telegramAlertState.authIssues[account.id];
      delete store.telegramAlertState.authFailureCounts[account.id];
      delete store.telegramAlertState.intentionalLogouts[account.id];
      delete store.telegramAlertState.resetReminders[account.id];
      delete store.telegramAlertState.quotaReminders[account.id];
      store.accounts = store.accounts.filter((item) => item.id !== account.id);
      if (store.selectedAccountId === account.id) {
        store.selectedAccountId = store.accounts[0].id;
      }
      const selected = getAccount();
      store.threadState = selected.threadState;
      store.dashboard = selected.dashboard;
      await saveStore();
      addActivity("account", "warn", "Account removed", {
        accountId: account.id,
        accountLabel: account.label,
        credentialsRemoved: removedCredentials
      });
      return sendJson(res, 200, { selectedAccountId: store.selectedAccountId, accounts: store.accounts.map(publicAccount) });
    } finally {
      deletingAccountIds.delete(account.id);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/activity") {
    const requested = Number.parseInt(url.searchParams.get("limit") || "", 10);
    const limit = requested > 0 ? Math.min(requested, 1000) : 200;
    return sendJson(res, 200, {
      events: store.activityEvents.slice(-limit),
      runs: store.scheduledRuns.slice(-100),
      authEvents: store.authEvents.slice(-50)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    return sendJson(res, 200, publicSettings());
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    const account = requireAccount(url.searchParams.get("accountId"));
    const data = await getAppServer(account.id).models();
    return sendJson(res, 200, { accountId: account.id, data, recommendedModel: chooseModel(data).model });
  }

  if (req.method === "PATCH" && url.pathname === "/api/settings") {
    const body = await readJson(req);
    const settings = await patchSettings(body);
    return sendJson(res, 200, settings);
  }

  if (req.method === "POST" && url.pathname === "/api/alerts/telegram/test") {
    await deliverTelegramMessage(`WindowRelay\nTelegram alerts are configured and reachable.\n${new Date().toLocaleString("en-GB", { timeZone: store.settings.timezone })}`);
    addActivity("telegram", "info", "Telegram test alert sent");
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/run-now") {
    const body = await readJson(req);
    const account = requireAccount(body.accountId || store.selectedAccountId);
    if (account.provider === "claude" && !claude.configured) return sendError(res, 503, new ClaudeError("disabled").message);
    const run = await startTurn({
      accountId: account.id,
      reason: "manual",
      prompt: typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : null
    });
    return sendJson(res, 200, run);
  }

  if (req.method === "POST" && url.pathname === "/api/scheduler/pause") {
    store.settings.schedulerEnabled = false;
    await saveStore();
    addActivity("scheduler", "info", "Scheduler paused");
    return sendJson(res, 200, { schedulerEnabled: false });
  }

  if (req.method === "POST" && url.pathname === "/api/scheduler/resume") {
    store.settings.schedulerEnabled = true;
    await saveStore();
    addActivity("scheduler", "info", "Scheduler resumed");
    return sendJson(res, 200, { schedulerEnabled: true });
  }

  if (req.method === "POST" && url.pathname === "/api/thread/goal") {
    const body = await readJson(req);
    if (typeof body.objective !== "string" || !body.objective.trim()) {
      return sendError(res, 400, "objective is required");
    }
    const accountId = body.accountId || store.selectedAccountId;
    const threadId = await ensureThread(accountId);
    const params = {
      threadId,
      objective: body.objective.trim(),
      status: "active"
    };
    if (Number.isInteger(body.tokenBudget) && body.tokenBudget > 0) {
      params.tokenBudget = body.tokenBudget;
    }
    const result = await getAppServer(accountId).send("thread/goal/set", params);
    addActivity("thread", "info", "Goal set", { accountId, threadId, objective: params.objective });
    return sendJson(res, 200, result);
  }

  if (req.method === "DELETE" && url.pathname === "/api/thread/goal") {
    const accountId = accountIdFromUrl(url);
    const threadId = await ensureThread(accountId);
    const result = await getAppServer(accountId).send("thread/goal/clear", { threadId });
    addActivity("thread", "info", "Goal cleared", { accountId, threadId });
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    return sendJson(res, 200, await getAuthStatus(accountIdFromUrl(url), true));
  }

  if (req.method === "POST" && url.pathname === "/api/auth/device/start") {
    const body = await readJson(req);
    const account = requireAccount(body.accountId || store.selectedAccountId);
    if (account.provider === "claude") return sendError(res, 422, "Sign in through Claude Code in the container.");
    return sendJson(res, 200, startDeviceLogin(account.id));
  }

  if (req.method === "GET" && url.pathname === "/api/auth/device/current") {
    return sendJson(res, 200, getLoginSession(accountIdFromUrl(url)));
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const body = await readJson(req);
    const account = requireAccount(body.accountId || store.selectedAccountId);
    const result = account.provider === "claude" ? await logoutClaude(account) : await logoutCodex(account.id);
    return sendJson(res, result.code === 0 ? 200 : 500, result);
  }

  return sendError(res, 404, "Not found");
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const STATIC_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  // Inline style attributes carry per-account chart colours; scripts stay same-origin only.
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};
const INDEX_PATH = path.join(PUBLIC_DIR, "index.html");

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
    return res.end();
  }
  const resolved = path.resolve(PUBLIC_DIR, `.${url.pathname}`);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return sendError(res, 403, "Forbidden");
  }
  let filePath = resolved === PUBLIC_DIR ? INDEX_PATH : resolved;
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    // Only extension-less paths are client-side routes; a missing asset is a real 404.
    if (path.extname(url.pathname)) {
      return sendError(res, 404, "Not found");
    }
    filePath = INDEX_PATH;
  }
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream",
    ...STATIC_HEADERS
  });
  if (req.method === "HEAD") {
    return res.end();
  }
  createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
}

async function requestHandler(req, res) {
  let url;
  try {
    // Only the path and query are used, so the client-supplied Host is not parsed.
    url = new URL(req.url || "/", "http://localhost");
  } catch {
    return sendError(res, 400, "Malformed request URL");
  }
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    addActivity("server", statusCode >= 500 ? "error" : "warn", "Request failed", { path: url.pathname, error: error.message });
    if (res.headersSent) {
      res.destroy();
    } else {
      sendError(res, statusCode, error.message);
    }
  }
}

async function bootstrap() {
  await loadStore();
  addActivity("server", "info", "Service starting", {
    dataDir: DATA_DIR,
    accountsDir: ACCOUNTS_DIR,
    workspaceDir: store.settings.workspaceDir
  });

  const server = createServer(requestHandler);
  server.listen(PORT, "0.0.0.0", () => {
    addActivity("server", "info", "Web server listening", { port: PORT });
    console.log(`WindowRelay listening on :${PORT}`);
  });

  startScheduler();

  await Promise.all(store.accounts.filter((account) => account.provider === "codex").map(async (account) => {
    const auth = await getAuthStatus(account, true);
    if (auth.probeUnavailable && !auth.loggedIn) {
      addActivity("auth", "warn", "Codex login status check was unavailable during startup", {
        accountId: account.id,
        accountLabel: account.label
      });
      return;
    }
    if (!auth.loggedIn) {
      if (account.enabled) {
        addActivity("auth", "warn", "Codex account is not logged in; scheduled sends will fail until device login completes", {
          accountId: account.id,
          accountLabel: account.label
        });
      }
      return;
    }
    try {
      await getAppServer(account.id).start();
      await ensureThread(account.id);
    } catch (error) {
      addActivity("codex", "error", "Initial app-server startup failed", {
        accountId: account.id,
        accountLabel: account.label,
        error: error.message
      });
    }
  }));
  startStateRefresh();

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    addActivity("server", "info", "Shutting down");
    for (const serverInstance of appServers.values()) {
      serverInstance.stop();
    }
    clearInterval(schedulerTimer);
    clearTimeout(stateRefreshTimer);
    clearInterval(telegramRetryTimer);
    clearInterval(claudeRefreshTimer);
    server.close();
    await telegramFlushPromise?.catch(() => {});
    await stateRefreshPromise?.catch(() => {});
    await saveStore();
    await saveChain;
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// A stray rejection in a background task must not take the scheduler and every account down with it.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection", reason);
});

bootstrap().catch((error) => {
  console.error("WindowRelay failed to start", error);
  process.exit(1);
});
