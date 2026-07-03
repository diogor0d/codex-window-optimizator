const $ = (selector) => document.querySelector(selector);

const state = {
  settings: null,
  activityIds: new Set()
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

function formatRun(run) {
  if (!run) {
    return "None";
  }
  const label = [run.status, run.scheduledTime || run.reason, run.turnId || ""].filter(Boolean).join(" | ");
  return `${label} (${new Date(run.ts).toLocaleString()})`;
}

function updateStatus(status) {
  $("#subtitle").textContent = status.scheduler.next.localNow;
  $("#authState").textContent = status.auth.detail || (status.auth.loggedIn ? "Logged in" : "Not logged in");
  $("#appServerState").textContent = status.appServer.running ? "Running" : "Stopped";
  $("#threadState").textContent = status.thread.threadId || "None";
  $("#localTime").textContent = status.scheduler.next.localNow;
  $("#nextRun").textContent = status.scheduler.enabled ? status.scheduler.next.nextLocal : "Paused";
  $("#lastRun").textContent = formatRun(status.latestRun);

  badge($("#serviceBadge"), status.auth.loggedIn ? "Ready" : "Needs login", status.auth.loggedIn ? "ok" : "warn");
  badge($("#loginBadge"), status.auth.loggedIn ? "Logged in" : "Logged out", status.auth.loggedIn ? "ok" : "bad");
  badge($("#schedulerBadge"), status.scheduler.enabled ? "Enabled" : "Paused", status.scheduler.enabled ? "ok" : "warn");

  $("#pauseBtn").disabled = !status.scheduler.enabled;
  $("#resumeBtn").disabled = status.scheduler.enabled;
}

async function refreshStatus() {
  const status = await api("/api/status");
  updateStatus(status);
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

function addActivity(event, prepend = true) {
  if (!event || state.activityIds.has(event.id)) {
    return;
  }
  state.activityIds.add(event.id);
  const list = $("#activityList");
  const item = document.createElement("li");
  item.className = `activity-item ${event.severity || "info"}`;
  const payload = stringifyPayload(event.payload);
  item.innerHTML = `
    <div class="activity-meta">
      <span>${escapeHtml(event.source || "service")} / ${escapeHtml(event.severity || "info")}</span>
      <time>${escapeHtml(new Date(event.ts).toLocaleString())}</time>
    </div>
    <div class="activity-message">${escapeHtml(event.message || "")}</div>
    ${payload ? `<pre class="activity-payload">${escapeHtml(payload)}</pre>` : ""}
  `;
  if (prepend) {
    list.prepend(item);
  } else {
    list.append(item);
  }
  while (list.children.length > 300) {
    list.lastElementChild.remove();
  }
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
  $("#activityList").innerHTML = "";
  state.activityIds.clear();
  for (const event of data.events || []) {
    addActivity(event, false);
  }
}

function connectEvents() {
  const events = new EventSource("/api/events");
  events.addEventListener("activity", (message) => {
    addActivity(JSON.parse(message.data), true);
  });
  events.addEventListener("login", async () => {
    renderLoginOutput(await api("/api/auth/device/current"));
    await refreshStatus();
  });
  events.addEventListener("run", async () => {
    await refreshStatus();
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

async function setGoal(event) {
  event.preventDefault();
  const body = {
    objective: $("#goalInput").value.trim()
  };
  const tokenBudget = Number.parseInt($("#tokenBudgetInput").value, 10);
  if (Number.isInteger(tokenBudget) && tokenBudget > 0) {
    body.tokenBudget = tokenBudget;
  }
  $("#goalMessage").textContent = "Saving...";
  try {
    await api("/api/thread/goal", { method: "POST", body: JSON.stringify(body) });
    $("#goalMessage").textContent = "Goal set.";
  } catch (error) {
    $("#goalMessage").textContent = error.message;
  }
}

async function clearGoal() {
  $("#goalMessage").textContent = "Clearing...";
  try {
    await api("/api/thread/goal", { method: "DELETE" });
    $("#goalMessage").textContent = "Goal cleared.";
  } catch (error) {
    $("#goalMessage").textContent = error.message;
  }
}

async function runNow(prompt = null) {
  const body = prompt ? { prompt } : {};
  return api("/api/run-now", { method: "POST", body: JSON.stringify(body) });
}

function bindActions() {
  $("#refreshBtn").addEventListener("click", async () => {
    await refreshStatus();
    await refreshSettings();
    await refreshActivity();
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
      renderLoginOutput(await api("/api/auth/device/start", { method: "POST", body: "{}" }));
    } catch (error) {
      $("#loginOutput").textContent = error.message;
    } finally {
      $("#deviceLoginBtn").disabled = false;
    }
  });
  $("#logoutBtn").addEventListener("click", async () => {
    $("#logoutBtn").disabled = true;
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      await refreshStatus();
    } finally {
      $("#logoutBtn").disabled = false;
    }
  });
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#goalForm").addEventListener("submit", setGoal);
  $("#clearGoalBtn").addEventListener("click", clearGoal);
  $("#clearActivityBtn").addEventListener("click", () => {
    $("#activityList").innerHTML = "";
    state.activityIds.clear();
  });
}

async function init() {
  bindActions();
  connectEvents();
  await refreshSettings();
  await refreshStatus();
  await refreshActivity();
  renderLoginOutput(await api("/api/auth/device/current"));
  setInterval(refreshStatus, 15000);
}

init().catch((error) => {
  document.body.innerHTML = `<main class="panel"><h1>Startup failed</h1><pre>${escapeHtml(error.stack || error.message)}</pre></main>`;
});
