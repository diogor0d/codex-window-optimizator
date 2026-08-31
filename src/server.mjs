import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

process.env.TZ ||= "Europe/Lisbon";

const DEFAULT_PROMPT = `Scheduled Codex window ping at {{local_time}}.

Continue the active goal in this thread. If no goal is set, summarize current state and ask me to set one. Prefer small, reversible progress. Do not start unrelated work. Stop and ask before destructive actions, credential handling, broad network access, or anything requiring approval.`;

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
    skipIfActive: true
  },
  selectedAccountId: "default",
  accounts: [],
  threadState: structuredClone(DEFAULT_THREAD_STATE),
  scheduledRuns: [],
  activityEvents: [],
  authEvents: [],
  dashboard: structuredClone(DEFAULT_DASHBOARD)
};

let store = structuredClone(DEFAULT_STORE);
let saveChain = Promise.resolve();
const sseClients = new Set();
const authStatusCacheByAccount = new Map();
const appServers = new Map();
const loginSessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultAccount() {
  return {
    id: "default",
    label: "Default account",
    enabled: true,
    codeHome: CODEX_HOME,
    settings: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    threadState: clone(DEFAULT_THREAD_STATE),
    dashboard: clone(DEFAULT_DASHBOARD)
  };
}

function createAccount(label = "New account") {
  const id = `acct_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return {
    id,
    label,
    enabled: true,
    codeHome: path.join(ACCOUNTS_DIR, id),
    settings: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    threadState: clone(DEFAULT_THREAD_STATE),
    dashboard: clone(DEFAULT_DASHBOARD)
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
  return { ...store.settings, ...(account?.settings || {}) };
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
    dashboard: mergeDefaults(account?.dashboard || {}, DEFAULT_DASHBOARD)
  };
  normalized.updatedAt ||= nowIso();
  normalized.createdAt ||= normalized.updatedAt;
  return normalized;
}

function getAccount(accountId = store.selectedAccountId) {
  const id = accountId || store.selectedAccountId || "default";
  return store.accounts.find((account) => account.id === id) || store.accounts[0];
}

function requireAccount(accountId) {
  const id = accountId ?? store.selectedAccountId;
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
    mode: "unknown",
    detail: "Not checked yet"
  };
  return {
    id: account.id,
    label: account.label,
    enabled: account.enabled,
    isSelected: account.id === store.selectedAccountId,
    auth,
    appServer: { running: getAppServer(account.id, false)?.running || false },
    settings: clone(account.settings || {}),
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
    await ensureAccountDirs(account);
  }
}

async function ensureAccountDirs(account) {
  await mkdir(account.codeHome, { recursive: true });
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
  await rm(resolved, { recursive: true, force: true });
  return true;
}

async function loadStore() {
  await ensureDirs();
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    store = mergeDefaults(JSON.parse(raw), DEFAULT_STORE);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Failed to read ${STORE_PATH}; starting with defaults`, error);
    }
    store = structuredClone(DEFAULT_STORE);
    await saveStore();
  }
  normalizeStore();
  await saveStore();
}

function normalizeStore() {
  store.settings.approvalPolicy = normalizeApprovalPolicy(store.settings.approvalPolicy);
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
}

function saveStore() {
  saveChain = saveChain.then(async () => {
    await ensureDirs();
    const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, STORE_PATH);
  });
  return saveChain;
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
  return {
    ...process.env,
    CODEX_HOME: account?.codeHome || CODEX_HOME,
    NO_COLOR: "1",
    TERM: "dumb"
  };
}

function runCodex(args, options = {}) {
  const account = options.account || getAccount();
  const timeoutMs = options.timeoutMs ?? 30000;
  return new Promise((resolve) => {
    const child = spawn("codex", args, {
      cwd: workspaceCwd(),
      env: codexEnv(account),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
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
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, signal, stdout: redactString(stdout), stderr: redactString(stderr) });
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
    mode: "unknown",
    detail: "Not checked yet"
  };
}

async function getAuthStatus(accountOrId = store.selectedAccountId, force = false) {
  const account = typeof accountOrId === "object" ? accountOrId : requireAccount(accountOrId);
  const cached = authStatusCacheByAccount.get(account.id);
  if (!force && cached && Date.now() - cached.checkedAt < 10000) {
    return cached.status;
  }
  const result = await runCodex(["login", "status"], { account, timeoutMs: 20000 });
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const loggedIn = result.code === 0;
  const next = {
    checkedAt: Date.now(),
    status: {
      loggedIn,
      mode: loggedIn ? "codex" : "none",
      detail: combined || (loggedIn ? "Logged in" : "Not logged in"),
      code: result.code
    }
  };
  authStatusCacheByAccount.set(account.id, next);
  return next.status;
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
  }

  get running() {
    return Boolean(this.proc && !this.proc.killed);
  }

  async start() {
    if (this.running) {
      return;
    }
    const account = requireAccount(this.accountId);
    await ensureDirs();
    this.proc = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: workspaceCwd(),
      env: codexEnv(account),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.buffer = "";
    addActivity("codex", "info", "Started Codex app-server", {
      accountId: account.id,
      accountLabel: account.label,
      cwd: workspaceCwd(),
      codeHome: account.codeHome
    });

    this.proc.stdout.on("data", (chunk) => this.handleStdout(chunk.toString("utf8")));
    this.proc.stderr.on("data", (chunk) => {
      const text = redactString(chunk.toString("utf8").trim());
      if (text) {
        addActivity("codex", "warn", "Codex app-server stderr", { accountId: this.accountId, text });
      }
    });
    this.proc.on("error", (error) => {
      addActivity("codex", "error", "Failed to start Codex app-server", { accountId: this.accountId, error: error.message });
      this.rejectAll(error);
      this.proc = null;
    });
    this.proc.on("close", (code, signal) => {
      addActivity("codex", code === 0 ? "info" : "error", "Codex app-server exited", { accountId: this.accountId, code, signal });
      this.rejectAll(new Error(`app-server exited with code ${code ?? "unknown"}`));
      this.proc = null;
      this.readyPromise = null;
      this.threadStatuses.clear();
    });

    this.readyPromise = this.initializeConnection();
    await this.readyPromise;
  }

  stop() {
    if (this.proc) {
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
    this.rejectAll(new Error("app-server stopped"));
    this.readyPromise = null;
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
        pending.reject(new Error(JSON.stringify(redact(message.error))));
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

  async initializeConnection() {
    const result = await this.rawRequest("initialize", {
      clientInfo: {
        name: SERVICE_NAME,
        title: "Codex Window Runner",
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
  if (!appServers.has(accountId) && create) {
    appServers.set(accountId, new CodexAppServer(accountId));
  }
  return appServers.get(accountId) || null;
}

function recordRateLimits(account, rateLimits, merge = false) {
  if (!rateLimits || typeof rateLimits !== "object" || Array.isArray(rateLimits)) {
    return null;
  }
  const incoming = redact(rateLimits);
  const previous = account.dashboard?.rateLimits;
  let next = incoming;
  if (merge && previous) {
    next = { ...previous, ...incoming };
    for (const key of ["primary", "secondary"]) {
      if (incoming[key] === undefined) {
        next[key] = previous[key];
      } else if (incoming[key] && previous[key] && typeof incoming[key] === "object" && typeof previous[key] === "object") {
        next[key] = { ...previous[key], ...incoming[key] };
      }
    }
  }
  const updatedAt = nowIso();
  account.dashboard ||= structuredClone(DEFAULT_DASHBOARD);
  account.dashboard.rateLimits = { ...next, updatedAt };
  if (account.id === store.selectedAccountId) {
    store.dashboard = account.dashboard;
  }
  return updatedAt;
}

async function refreshAccountState(account) {
  const outcome = {
    accountId: account.id,
    accountLabel: account.label,
    authChecked: false,
    loggedIn: false,
    rateLimits: "skipped",
    updatedAt: null,
    error: null
  };
  try {
    const auth = await getAuthStatus(account, true);
    outcome.authChecked = true;
    outcome.loggedIn = auth.loggedIn;
    if (!auth.loggedIn) {
      return outcome;
    }
    const result = await getAppServer(account.id).send("account/rateLimits/read", null, 30000);
    if (!result?.rateLimits) {
      throw new Error("Codex returned no rate-limit data");
    }
    outcome.updatedAt = recordRateLimits(account, result.rateLimits);
    outcome.rateLimits = "updated";
  } catch (error) {
    outcome.rateLimits = "failed";
    outcome.error = redactString(error.message || String(error));
  }
  return outcome;
}

function updateDashboardState(accountId, message) {
  const account = store.accounts.find((item) => item.id === accountId);
  if (!account) {
    return;
  }
  const params = message.params || {};
  account.dashboard ||= structuredClone(DEFAULT_DASHBOARD);

  if (message.method === "account/rateLimits/updated" && params.rateLimits) {
    recordRateLimits(account, params.rateLimits, true);
    void saveStore();
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
  if (account.id === store.selectedAccountId) {
    store.dashboard = account.dashboard;
  }
}

async function ensureThread(accountId = store.selectedAccountId) {
  const account = requireAccount(accountId);
  const appServer = getAppServer(account.id);
  const auth = await getAuthStatus(account, true);
  if (!auth.loggedIn) {
    throw new Error(`${account.label} is not logged in`);
  }

  const settings = effectiveSettings(account);
  const common = {
    serviceName: SERVICE_NAME,
    cwd: settings.workspaceDir || DEFAULT_WORKSPACE_DIR
  };
  if (settings.model) {
    common.model = settings.model;
  }

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
    const threadId = await ensureThread(account.id);
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

    const settings = effectiveSettings(account);
    const inputText = prompt || renderPrompt(settings.promptTemplate, scheduledTime, reason);
    const params = {
      threadId,
      input: [{ type: "text", text: inputText }],
      cwd: settings.workspaceDir || DEFAULT_WORKSPACE_DIR,
      sandboxPolicy: buildSandboxPolicy(account),
      approvalPolicy: normalizeApprovalPolicy(store.settings.approvalPolicy),
      summary: store.settings.summary || "concise"
    };
    if (settings.model) {
      params.model = settings.model;
    }
    if (store.settings.effort) {
      params.effort = store.settings.effort;
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
    return run;
  }
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
  const enabledAccounts = store.accounts.filter((account) => account.enabled);
  const timeSets = enabledAccounts.map((account) => effectiveSettings(account).scheduleTimes);
  const times = [...new Set(timeSets.length ? timeSets.flat() : store.settings.scheduleTimes)].sort();
  const todayNext = times.find((time) => time > now.time);
  return {
    timezone,
    localNow: `${now.date} ${now.time}:${now.second}`,
    nextLocal: todayNext ? `${now.date} ${todayNext}` : `tomorrow ${times[0] || "none"}`
  };
}

async function schedulerTick() {
  if (!store.settings.schedulerEnabled) {
    return;
  }
  const local = getLocalParts(new Date(), store.settings.timezone);
  const key = `${local.date}T${local.time}`;
  for (const account of store.accounts.filter((item) => item.enabled)) {
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

function startScheduler() {
  if (schedulerTimer) {
    return;
  }
  schedulerTimer = setInterval(() => {
    void schedulerTick();
  }, 10_000);
  void schedulerTick();
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
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1_000_000) {
      throw new Error("Request body too large");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
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
  const next = { ...store.settings };
  if (body.timezone !== undefined) {
    if (!validateTimezone(body.timezone)) {
      throw new Error("Invalid timezone");
    }
    next.timezone = body.timezone;
  }
  if (body.scheduleTimes !== undefined) {
    if (!Array.isArray(body.scheduleTimes) || body.scheduleTimes.length === 0 || !body.scheduleTimes.every(validateTime)) {
      throw new Error("scheduleTimes must be a non-empty HH:mm array");
    }
    next.scheduleTimes = [...new Set(body.scheduleTimes)].sort();
  }
  for (const key of ["schedulerEnabled", "networkAccess", "skipIfActive"]) {
    if (body[key] !== undefined) {
      next[key] = Boolean(body[key]);
    }
  }
  for (const key of ["promptTemplate", "model", "effort", "summary", "approvalPolicy", "workspaceDir"]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string") {
        throw new Error(`${key} must be a string`);
      }
      next[key] = body[key];
    }
  }
  next.approvalPolicy = normalizeApprovalPolicy(next.approvalPolicy);
  if (!next.promptTemplate.trim()) {
    throw new Error("promptTemplate cannot be empty");
  }
  store.settings = next;
  await saveStore();
  addActivity("settings", "info", "Settings updated", { settings: store.settings });
  return store.settings;
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

  const child = spawn("codex", ["login", "--device-auth"], {
    cwd: workspaceCwd(),
    env: codexEnv(account),
    stdio: ["pipe", "pipe", "pipe"]
  });

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
    session.status = code === 0 ? "completed" : "failed";
    session.exitCode = code;
    session.finishedAt = nowIso();
    addAuthEvent("Codex device login finished", { accountId: account.id, accountLabel: account.label, sessionId: session.id, code });
    const auth = await getAuthStatus(account, true);
    if (auth.loggedIn) {
      try {
        await getAppServer(account.id).start();
        await ensureThread(account.id);
      } catch (error) {
        addActivity("codex", "error", "Post-login app-server startup failed", {
          accountId: account.id,
          accountLabel: account.label,
          error: error.message
        });
      }
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
  await getAuthStatus(account, true);
  addAuthEvent("Logged out Codex credentials", {
    accountId: account.id,
    accountLabel: account.label,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  });
  return result;
}

async function handleApi(req, res, url) {
  if (!isAuthorized(req)) {
    return sendError(res, 403, "Forbidden");
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, ts: nowIso() });
  }

  if (req.method === "POST" && url.pathname === "/api/refresh") {
    const accounts = await Promise.all(store.accounts.map((account) => refreshAccountState(account)));
    const summary = {
      attempted: accounts.length,
      updated: accounts.filter((account) => account.rateLimits === "updated").length,
      skipped: accounts.filter((account) => account.rateLimits === "skipped").length,
      failed: accounts.filter((account) => account.rateLimits === "failed").length
    };
    if (summary.updated) {
      await saveStore();
    }
    addActivity("refresh", summary.failed ? "warn" : "info", "Manual state refresh completed", {
      ...summary,
      accounts
    });
    return sendJson(res, 200, { ts: nowIso(), ...summary, accounts });
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive"
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: nowIso() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    await Promise.all(store.accounts.map((account) => getAuthStatus(account).catch(() => unknownAuthStatus())));
    const selected = requireAccount();
    const auth = authStatusCacheByAccount.get(selected.id)?.status || unknownAuthStatus();
    return sendJson(res, 200, {
      ts: nowIso(),
      selectedAccountId: selected.id,
      selectedAccount: publicAccount(selected),
      accounts: store.accounts.map(publicAccount),
      auth,
      appServer: { running: getAppServer(selected.id, false)?.running || false },
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
    await Promise.all(store.accounts.map((account) => getAuthStatus(account).catch(() => unknownAuthStatus())));
    return sendJson(res, 200, {
      selectedAccountId: store.selectedAccountId,
      accounts: store.accounts.map(publicAccount)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const body = await readJson(req);
    const account = createAccount(typeof body.label === "string" && body.label.trim() ? body.label.trim() : `Account ${store.accounts.length + 1}`);
    store.accounts.push(account);
    store.selectedAccountId = account.id;
    store.threadState = account.threadState;
    store.dashboard = account.dashboard;
    await ensureAccountDirs(account);
    await saveStore();
    addActivity("account", "info", "Account added", { accountId: account.id, accountLabel: account.label });
    return sendJson(res, 200, { selectedAccountId: account.id, account: publicAccount(account), accounts: store.accounts.map(publicAccount) });
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/accounts/")) {
    const accountId = decodeURIComponent(url.pathname.split("/").at(-1));
    const account = requireAccount(accountId);
    const body = await readJson(req);
    if (body.settings !== undefined) {
      if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
        return sendError(res, 400, "settings must be an object");
      }
      for (const key of Object.keys(body.settings)) {
        if (!ACCOUNT_SETTING_KEYS.includes(key)) {
          return sendError(res, 400, `Unknown account setting: ${key}`);
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
    if (typeof body.label === "string" && body.label.trim()) {
      account.label = body.label.trim();
    }
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
    const accountId = decodeURIComponent(url.pathname.split("/").at(-1));
    const account = requireAccount(accountId);
    if (store.accounts.length <= 1) {
      return sendError(res, 400, "Cannot delete the last remaining account");
    }
    getAppServer(account.id, false)?.stop();
    appServers.delete(account.id);
    loginSessions.delete(account.id);
    authStatusCacheByAccount.delete(account.id);
    const removedCredentials = await removeAccountHome(account.codeHome);
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
  }

  if (req.method === "GET" && url.pathname === "/api/activity") {
    const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "200", 10), 1000);
    return sendJson(res, 200, {
      events: store.activityEvents.slice(-limit),
      runs: store.scheduledRuns.slice(-100),
      authEvents: store.authEvents.slice(-50)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    return sendJson(res, 200, store.settings);
  }

  if (req.method === "PATCH" && url.pathname === "/api/settings") {
    const body = await readJson(req);
    const settings = await patchSettings(body);
    return sendJson(res, 200, settings);
  }

  if (req.method === "POST" && url.pathname === "/api/run-now") {
    const body = await readJson(req);
    const run = await startTurn({
      accountId: body.accountId || store.selectedAccountId,
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
    return sendJson(res, 200, startDeviceLogin(body.accountId || store.selectedAccountId));
  }

  if (req.method === "GET" && url.pathname === "/api/auth/device/current") {
    return sendJson(res, 200, getLoginSession(accountIdFromUrl(url)));
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const body = await readJson(req);
    const result = await logoutCodex(body.accountId || store.selectedAccountId);
    return sendJson(res, result.code === 0 ? 200 : 500, result);
  }

  return sendError(res, 404, "Not found");
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

async function serveStatic(req, res, url) {
  let filePath = url.pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, url.pathname);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return sendError(res, 403, "Forbidden");
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new Error("not file");
    }
    const ext = path.extname(resolved);
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    createReadStream(path.join(PUBLIC_DIR, "index.html")).pipe(res);
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    addActivity("server", "error", "Request failed", { path: url.pathname, error: error.message });
    sendError(res, error.statusCode || 500, error.message);
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
    console.log(`codex-window-runner listening on :${PORT}`);
  });

  startScheduler();

  await Promise.all(store.accounts.map(async (account) => {
    const auth = await getAuthStatus(account, true);
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

  const shutdown = async () => {
    addActivity("server", "info", "Shutting down");
    for (const serverInstance of appServers.values()) {
      serverInstance.stop();
    }
    clearInterval(schedulerTimer);
    server.close();
    await saveStore();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void bootstrap();
