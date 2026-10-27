function windowByDuration(snapshot, duration) {
  return [snapshot?.primary, snapshot?.secondary]
    .find((window) => window?.windowDurationMins === duration) || null;
}

function reserveSnapshot(dashboard) {
  return Object.values(dashboard?.rateLimitsByLimitId || {})
    .filter((snapshot) => snapshot?.limitName === "gpt-reserve")
    .sort((a, b) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0))[0] || null;
}

function hasReserveAllowance(dashboard) {
  const window = windowByDuration(reserveSnapshot(dashboard), 10080);
  if (!Number.isFinite(Number(window?.usedPercent))) {
    return false;
  }
  return Number(window.usedPercent) < 100;
}

function hasCurrentReserveAllowance(dashboard, nowMs) {
  if (!hasReserveAllowance(dashboard)) {
    return false;
  }
  const window = windowByDuration(reserveSnapshot(dashboard), 10080);
  if (window.resetsAt == null) {
    return true;
  }
  const resetsAt = Number(window.resetsAt);
  return Number.isFinite(resetsAt) && resetsAt * 1000 > nowMs;
}

function alertWindows(dashboard) {
  return [
    { key: "5h", label: "5-hour quota", window: windowByDuration(dashboard?.rateLimits, 300) },
    { key: "weekly", label: "weekly quota", window: windowByDuration(dashboard?.rateLimits, 10080) },
    { key: "reserve", label: "Luna Reserve", window: windowByDuration(reserveSnapshot(dashboard), 10080) }
  ];
}

function formatTimestamp(seconds, timezone) {
  if (!Number.isSafeInteger(seconds)) {
    return "unknown";
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(seconds * 1000));
}

export function withoutTelegramCredentials(environment) {
  const sanitized = { ...environment };
  delete sanitized.TELEGRAM_BOT_TOKEN;
  delete sanitized.TELEGRAM_CHAT_ID;
  return sanitized;
}

export function validateResetReminderHours(value) {
  return Array.isArray(value) && value.length <= 10
    && value.every((hours) => Number.isInteger(hours) && hours >= 1 && hours <= 720)
    && new Set(value).size === value.length;
}

export function resetReminderHours(settings) {
  if (validateResetReminderHours(settings.telegramResetReminderHours)) {
    return [...settings.telegramResetReminderHours].sort((a, b) => b - a);
  }
  // Preserve the single expiry warning configured by older versions.
  if (validateResetReminderHours([settings.telegramResetExpiryHours])) {
    return [settings.telegramResetExpiryHours];
  }
  return [48];
}

export function resetCreditExpirations(dashboard, nowMs = Date.now()) {
  const summary = dashboard?.rateLimitResetCredits;
  const counts = new Map();
  if (!Number.isSafeInteger(summary?.availableCount) || summary.availableCount <= 0) return counts;
  for (const expiresAt of (Array.isArray(summary.expiresAt) ? summary.expiresAt : []).slice(0, summary.availableCount)) {
    if (Number.isSafeInteger(expiresAt) && expiresAt * 1000 > nowMs && expiresAt * 1000 <= 8.64e15) {
      counts.set(expiresAt, (counts.get(expiresAt) || 0) + 1);
    }
  }
  return counts;
}

export function buildResetReminderEvents(dashboard, settings, sent = {}, nowMs = Date.now()) {
  if (!settings.telegramAlertResetCredits) return [];
  const hours = resetReminderHours(settings);
  const events = [];
  for (const [expiresAt, count] of resetCreditExpirations(dashboard, nowMs)) {
    const dueHours = hours.filter((hoursBefore) => nowMs >= expiresAt * 1000 - hoursBefore * 3600_000);
    // On startup or after downtime, catch up once with the most urgent due reminder.
    const hoursBefore = dueHours.at(-1);
    if (hoursBefore === undefined) continue;
    const notifiedCount = sent[`${expiresAt}:${hoursBefore}`] || 0;
    if (notifiedCount >= count) continue;
    const reminderCount = count - notifiedCount;
    const leadTime = hoursBefore % 24 === 0
      ? `${hoursBefore / 24} day${hoursBefore === 24 ? "" : "s"}`
      : `${hoursBefore} hour${hoursBefore === 1 ? "" : "s"}`;
    events.push({
      type: "reset-credit-expiry",
      expiresAt,
      hoursBefore,
      count,
      dueHours,
      text: `${reminderCount} unused usage reset${reminderCount === 1 ? "" : "s"} expire${reminderCount === 1 ? "s" : ""} ${formatTimestamp(expiresAt, settings.timezone)} (${settings.timezone}). Use ${reminderCount === 1 ? "it" : "them"} before expiry. Reminder: ${leadTime} before expiry.`
    });
  }
  return events;
}

export function recordResetReminder(sent, event) {
  for (const hoursBefore of event.dueHours) {
    const key = `${event.expiresAt}:${hoursBefore}`;
    sent[key] = Math.max(sent[key] || 0, event.count);
  }
}

export function pruneResetReminderState(sent, nowMs = Date.now()) {
  return Object.fromEntries(Object.entries(sent && typeof sent === "object" ? sent : {})
    .filter(([key, count]) => {
      const [expiresAt, hoursBefore, extra] = key.split(":");
      return extra === undefined && Number.isSafeInteger(Number(expiresAt))
        && Number(expiresAt) * 1000 > nowMs && validateResetReminderHours([Number(hoursBefore)])
        && Number.isSafeInteger(count) && count > 0;
    }));
}

export function buildQuotaAlertEvents(previous, current, settings, nowMs = Date.now()) {
  const events = [];
  const warning = Number.isInteger(settings.telegramQuotaWarningPercent)
    ? settings.telegramQuotaWarningPercent
    : 80;
  const thresholds = [...new Set([warning, 95, 100])].filter((value) => value > 0 && value <= 100).sort((a, b) => a - b);
  const previousWindows = Object.fromEntries(alertWindows(previous).map((entry) => [entry.key, entry]));

  for (const entry of alertWindows(current)) {
    if (entry.key === "reserve" && !settings.telegramAlertReserve) {
      continue;
    }
    const before = previousWindows[entry.key]?.window;
    const after = entry.window;
    if (!after || !before) {
      continue;
    }
    for (const threshold of thresholds) {
      if (before.usedPercent < threshold && after.usedPercent >= threshold) {
        events.push({
          type: "quota-threshold",
          text: `${entry.label} reached ${100 - after.usedPercent}% free (crossed ${100 - threshold}% free)`
        });
      }
    }
    const resetAdvanceSeconds = after.resetsAt - before.resetsAt;
    const minimumCycleAdvanceSeconds = after.windowDurationMins * 60 * 0.8;
    if (settings.telegramAlertQuotaResets
      && Number.isSafeInteger(before.resetsAt)
      && Number.isSafeInteger(after.resetsAt)
      && Number.isFinite(minimumCycleAdvanceSeconds)
      && resetAdvanceSeconds >= minimumCycleAdvanceSeconds) {
      events.push({
        type: "quota-reset",
        text: `${entry.label} reset to ${100 - after.usedPercent}% free; next reset ${formatTimestamp(after.resetsAt, settings.timezone)}`
      });
    }
  }

  if (settings.telegramAlertReserve) {
    if (previous?.ordinaryUsageAllowed !== false
      && current?.ordinaryUsageAllowed === false
      && hasCurrentReserveAllowance(current, nowMs)) {
      events.push({ type: "reserve-active", text: "Ordinary usage is blocked; Luna Reserve fallback is active" });
    } else if (previous?.ordinaryUsageAllowed === false
      && current?.ordinaryUsageAllowed === true
      && hasReserveAllowance(previous)
      && hasCurrentReserveAllowance(current, nowMs)) {
      events.push({ type: "reserve-recovered", text: "Ordinary usage recovered; Luna Reserve returned to standby" });
    }
  }

  if (settings.telegramAlertResetCredits) {
    const beforeCount = previous?.rateLimitResetCredits?.availableCount;
    const afterCount = current?.rateLimitResetCredits?.availableCount;
    if (Number.isSafeInteger(beforeCount) && Number.isSafeInteger(afterCount) && beforeCount !== afterCount) {
      events.push({
        type: "reset-credit-count",
        text: `Usage resets changed from ${beforeCount} to ${afterCount}`
      });
    }
  }
  return events;
}

export function formatTelegramAlert(accountLabel, events) {
  return [
    `Codex Window Runner: ${accountLabel}`,
    ...events.map((event) => `- ${event.text}`)
  ].join("\n");
}

export function formatTelegramAlertMessages(accountLabel, events, maxLength = 4000) {
  const header = `Codex Window Runner: ${String(accountLabel).slice(0, 200)}`;
  const messages = [];
  let current = header;
  for (const event of events) {
    const line = `- ${String(event.text).slice(0, maxLength - header.length - 4)}`;
    if (`${current}\n${line}`.length > maxLength) {
      messages.push(current);
      current = `${header}\n${line}`;
    } else {
      current = `${current}\n${line}`;
    }
  }
  if (current !== header || !messages.length) {
    messages.push(current);
  }
  return messages;
}
