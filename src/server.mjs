import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const CODEX_HOME = process.env.CODEX_HOME || path.join(DATA_DIR, "codex-home");
const DEFAULT_WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const SERVICE_NAME = "codex-window-runner";

process.env.TZ ||= "Europe/Lisbon";

const DEFAULT_PROMPT = `Scheduled Codex window ping at {{local_time}}.

Continue the active goal in this thread. If no goal is set, summarize current state and ask me to set one. Prefer small, reversible progress. Do not start unrelated work. Stop and ask before destructive actions, credential handling, broad network access, or anything requiring approval.`;

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
    approvalPolicy: "unlessTrusted",
    networkAccess: false,
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    skipIfActive: true
  },
  threadState: {
    threadId: null,
    sessionId: null,
    name: null,
    lastScheduleKey: null,
    updatedAt: null
  },
  scheduledRuns: [],
  activityEvents: [],
  authEvents: []
};

let store = structuredClone(DEFAULT_STORE);
let saveChain = Promise.resolve();
const sseClients = new Set();

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function workspaceCwd() {
  const configured = store.settings.workspaceDir || DEFAULT_WORKSPACE_DIR;
  return existsSync(configured) ? configured : ROOT_DIR;
}

function codexEnv() {
  return {
    ...process.env,
    CODEX_HOME
  };
}

function runCodex(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  return new Promise((resolve) => {
    const child = spawn("codex", args, {
      cwd: workspaceCwd(),
      env: codexEnv(),
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

let authStatusCache = {
  checkedAt: 0,
  status: {
    loggedIn: false,
    mode: "unknown",
    detail: "Not checked yet"
  }
};

async function getAuthStatus(force = false) {
  if (!force && Date.now() - authStatusCache.checkedAt < 10000) {
    return authStatusCache.status;
  }
  const result = await runCodex(["login", "status"], { timeoutMs: 20000 });
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const loggedIn = result.code === 0;
  authStatusCache = {
    checkedAt: Date.now(),
    status: {
      loggedIn,
      mode: loggedIn ? "codex" : "none",
      detail: combined || (loggedIn ? "Logged in" : "Not logged in"),
      code: result.code
    }
  };
  return authStatusCache.status;
}

class CodexAppServer {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.threadStatuses = new Map();
  }

  get running() {
    return Boolean(this.proc && !this.proc.killed);
  }

  async start() {
    if (this.running) {
      return;
    }
    await ensureDirs();
    this.proc = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: workspaceCwd(),
      env: codexEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.buffer = "";
    addActivity("codex", "info", "Started Codex app-server", { cwd: workspaceCwd(), codeHome: CODEX_HOME });

    this.proc.stdout.on("data", (chunk) => this.handleStdout(chunk.toString("utf8")));
    this.proc.stderr.on("data", (chunk) => {
      const text = redactString(chunk.toString("utf8").trim());
      if (text) {
        addActivity("codex", "warn", "Codex app-server stderr", { text });
      }
    });
    this.proc.on("error", (error) => {
      addActivity("codex", "error", "Failed to start Codex app-server", { error: error.message });
      this.rejectAll(error);
      this.proc = null;
    });
    this.proc.on("close", (code, signal) => {
      addActivity("codex", code === 0 ? "info" : "error", "Codex app-server exited", { code, signal });
      this.rejectAll(new Error(`app-server exited with code ${code ?? "unknown"}`));
      this.proc = null;
      this.threadStatuses.clear();
    });
  }

  stop() {
    if (this.proc) {
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
    this.rejectAll(new Error("app-server stopped"));
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
        addActivity("codex", "warn", "Unparseable app-server line", { line, error: error.message });
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
      addActivity("codex", "info", message.method, message.params || {});
      broadcast("codex", redact(message));
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
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }
}

const appServer = new CodexAppServer();

async function ensureThread() {
  const auth = await getAuthStatus();
  if (!auth.loggedIn) {
    throw new Error("Codex is not logged in");
  }

  const common = {
    serviceName: SERVICE_NAME,
    cwd: store.settings.workspaceDir || DEFAULT_WORKSPACE_DIR
  };
  if (store.settings.model) {
    common.model = store.settings.model;
  }

  if (store.threadState.threadId) {
    try {
      const result = await appServer.send("thread/resume", {
        threadId: store.threadState.threadId,
        ...common
      });
      const thread = result?.thread || {};
      store.threadState = {
        ...store.threadState,
        threadId: thread.id || store.threadState.threadId,
        sessionId: thread.sessionId || store.threadState.sessionId,
        name: thread.name || store.threadState.name,
        updatedAt: nowIso()
      };
      await saveStore();
      return store.threadState.threadId;
    } catch (error) {
      addActivity("codex", "error", "Failed to resume stored thread; creating a new one", {
        threadId: store.threadState.threadId,
        error: error.message
      });
      store.threadState.threadId = null;
      store.threadState.sessionId = null;
    }
  }

  const result = await appServer.send("thread/start", {
    ...common,
    approvalPolicy: store.settings.approvalPolicy || "unlessTrusted",
    sandbox: "workspaceWrite"
  });
  const thread = result?.thread || {};
  if (!thread.id) {
    throw new Error("Codex did not return a thread id");
  }
  store.threadState = {
    ...store.threadState,
    threadId: thread.id,
    sessionId: thread.sessionId || thread.id,
    name: thread.name || null,
    updatedAt: nowIso()
  };
  await saveStore();
  addActivity("codex", "info", "Created Codex thread", { threadId: thread.id, sessionId: thread.sessionId });
  return thread.id;
}

function renderPrompt(template, scheduledTime, reason) {
  const local = getLocalParts(new Date(), store.settings.timezone);
  return template
    .replaceAll("{{local_time}}", `${local.date} ${local.time} ${store.settings.timezone}`)
    .replaceAll("{{scheduled_time}}", scheduledTime || "")
    .replaceAll("{{reason}}", reason || "scheduled");
}

function buildSandboxPolicy() {
  const workspaceDir = store.settings.workspaceDir || DEFAULT_WORKSPACE_DIR;
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

async function startTurn({ reason, scheduleKey = null, scheduledTime = null, prompt = null }) {
  const run = {
    id: randomUUID(),
    ts: nowIso(),
    scheduleKey,
    scheduledTime,
    reason,
    status: "starting",
    threadId: store.threadState.threadId,
    turnId: null,
    error: null
  };
  addScheduledRun(run);

  try {
    const threadId = await ensureThread();
    run.threadId = threadId;

    if (store.settings.skipIfActive && appServer.isThreadActive(threadId)) {
      run.status = "skipped_active_turn";
      addScheduledRun(run);
      addActivity("scheduler", "warn", "Skipped send because the Codex thread is active", { threadId, reason });
      return run;
    }

    const inputText = prompt || renderPrompt(store.settings.promptTemplate, scheduledTime, reason);
    const params = {
      threadId,
      input: [{ type: "text", text: inputText }],
      cwd: store.settings.workspaceDir || DEFAULT_WORKSPACE_DIR,
      sandboxPolicy: buildSandboxPolicy(),
      approvalPolicy: store.settings.approvalPolicy || "unlessTrusted",
      summary: store.settings.summary || "concise"
    };
    if (store.settings.model) {
      params.model = store.settings.model;
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
    addActivity("scheduler", "info", "Started Codex turn", { runId: run.id, threadId, turnId: run.turnId, reason });
    return run;
  } catch (error) {
    run.status = "failed";
    run.error = error.message;
    addScheduledRun(run);
    addActivity("scheduler", "error", "Failed to start Codex turn", { runId: run.id, error: error.message });
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
  const times = [...store.settings.scheduleTimes].sort();
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
  if (!store.settings.scheduleTimes.includes(local.time)) {
    return;
  }
  const key = `${local.date}T${local.time}`;
  if (store.threadState.lastScheduleKey === key) {
    return;
  }
  store.threadState.lastScheduleKey = key;
  store.threadState.updatedAt = nowIso();
  await saveStore();
  addActivity("scheduler", "info", "Schedule matched", { key, localTime: local.time });
  void startTurn({ reason: "scheduled", scheduleKey: key, scheduledTime: local.time });
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
  if (!next.promptTemplate.trim()) {
    throw new Error("promptTemplate cannot be empty");
  }
  store.settings = next;
  await saveStore();
  addActivity("settings", "info", "Settings updated", { settings: store.settings });
  return store.settings;
}

let loginSession = null;

function startDeviceLogin() {
  if (loginSession?.status === "running") {
    return loginSession;
  }
  const session = {
    id: randomUUID(),
    status: "running",
    startedAt: nowIso(),
    finishedAt: null,
    output: [],
    exitCode: null
  };
  loginSession = session;
  addAuthEvent("Started Codex device login", { sessionId: session.id });

  const child = spawn("codex", ["login", "--device-auth"], {
    cwd: workspaceCwd(),
    env: codexEnv(),
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
    broadcast("login", { sessionId: session.id, ...entry });
    addActivity("auth", stream === "stderr" ? "warn" : "info", "Device login output", { stream, text });
  };

  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  child.on("error", (error) => {
    session.status = "failed";
    session.finishedAt = nowIso();
    session.output.push({ ts: nowIso(), stream: "error", text: error.message });
    addAuthEvent("Codex device login failed to start", { sessionId: session.id, error: error.message });
    broadcast("login", session);
  });
  child.on("close", async (code) => {
    session.status = code === 0 ? "completed" : "failed";
    session.exitCode = code;
    session.finishedAt = nowIso();
    addAuthEvent("Codex device login finished", { sessionId: session.id, code });
    await getAuthStatus(true);
    if (authStatusCache.status.loggedIn) {
      try {
        await appServer.start();
        await ensureThread();
      } catch (error) {
        addActivity("codex", "error", "Post-login app-server startup failed", { error: error.message });
      }
    }
    broadcast("login", session);
  });
  child.stdin.end();
  return session;
}

async function logoutCodex() {
  appServer.stop();
  const result = await runCodex(["logout"], { timeoutMs: 30000 });
  await getAuthStatus(true);
  addAuthEvent("Logged out Codex credentials", { code: result.code, stdout: result.stdout, stderr: result.stderr });
  return result;
}

async function handleApi(req, res, url) {
  if (!isAuthorized(req)) {
    return sendError(res, 403, "Forbidden");
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, ts: nowIso() });
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
    const auth = await getAuthStatus();
    return sendJson(res, 200, {
      ts: nowIso(),
      auth,
      appServer: { running: appServer.running },
      scheduler: {
        enabled: store.settings.schedulerEnabled,
        next: nextRunSummary()
      },
      thread: store.threadState,
      latestRun: store.scheduledRuns.at(-1) || null
    });
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
    const threadId = await ensureThread();
    const params = {
      threadId,
      objective: body.objective.trim(),
      status: "active"
    };
    if (Number.isInteger(body.tokenBudget) && body.tokenBudget > 0) {
      params.tokenBudget = body.tokenBudget;
    }
    const result = await appServer.send("thread/goal/set", params);
    addActivity("thread", "info", "Goal set", { threadId, objective: params.objective });
    return sendJson(res, 200, result);
  }

  if (req.method === "DELETE" && url.pathname === "/api/thread/goal") {
    const threadId = await ensureThread();
    const result = await appServer.send("thread/goal/clear", { threadId });
    addActivity("thread", "info", "Goal cleared", { threadId });
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    return sendJson(res, 200, await getAuthStatus(true));
  }

  if (req.method === "POST" && url.pathname === "/api/auth/device/start") {
    return sendJson(res, 200, startDeviceLogin());
  }

  if (req.method === "GET" && url.pathname === "/api/auth/device/current") {
    return sendJson(res, 200, loginSession || { status: "none" });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const result = await logoutCodex();
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
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600"
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
    sendError(res, 500, error.message);
  }
}

async function bootstrap() {
  await loadStore();
  addActivity("server", "info", "Service starting", {
    dataDir: DATA_DIR,
    codeHome: CODEX_HOME,
    workspaceDir: store.settings.workspaceDir
  });

  const server = createServer(requestHandler);
  server.listen(PORT, "0.0.0.0", () => {
    addActivity("server", "info", "Web server listening", { port: PORT });
    console.log(`codex-window-runner listening on :${PORT}`);
  });

  startScheduler();

  const auth = await getAuthStatus(true);
  if (auth.loggedIn) {
    try {
      await appServer.start();
      await ensureThread();
    } catch (error) {
      addActivity("codex", "error", "Initial app-server startup failed", { error: error.message });
    }
  } else {
    addActivity("auth", "warn", "Codex is not logged in; scheduled sends will fail until device login completes");
  }

  const shutdown = async () => {
    addActivity("server", "info", "Shutting down");
    appServer.stop();
    clearInterval(schedulerTimer);
    server.close();
    await saveStore();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void bootstrap();
