function windowByDuration(snapshot, duration) {
  return [snapshot?.primary, snapshot?.secondary]
    .find((window) => window?.windowDurationMins === duration) || null;
}

function reserveSnapshot(dashboard) {
  return Object.values(dashboard?.rateLimitsByLimitId || {})
    .find((snapshot) => snapshot?.limitName === "gpt-reserve") || null;
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
          text: `${entry.label} reached ${after.usedPercent}% used (${100 - after.usedPercent}% free; crossed ${threshold}%)`
        });
      }
    }
    if (settings.telegramAlertQuotaResets
      && Number.isSafeInteger(before.resetsAt)
      && Number.isSafeInteger(after.resetsAt)
      && before.resetsAt !== after.resetsAt) {
      events.push({
        type: "quota-reset",
        text: `${entry.label} reset to ${after.usedPercent}% used; next reset ${formatTimestamp(after.resetsAt, settings.timezone)}`
      });
    }
  }

  if (settings.telegramAlertReserve) {
    if (previous?.ordinaryUsageAllowed !== false && current?.ordinaryUsageAllowed === false) {
      events.push({ type: "reserve-active", text: "Ordinary usage is blocked; Luna Reserve fallback is active" });
    } else if (previous?.ordinaryUsageAllowed === false && current?.ordinaryUsageAllowed === true) {
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

    const horizonMs = Math.max(1, settings.telegramResetExpiryHours || 24) * 60 * 60 * 1000;
    const previousSummary = previous?.rateLimitResetCredits;
    const previousReadMs = Date.parse(previousSummary?.updatedAt || "");
    const currentReadMs = Date.parse(current?.rateLimitResetCredits?.updatedAt || "") || nowMs;
    const expirations = current?.rateLimitResetCredits?.expiresAt || [];
    const previousCounts = new Map();
    for (const expiresAt of previousSummary?.expiresAt || []) {
      if (Number.isSafeInteger(expiresAt)) {
        previousCounts.set(expiresAt, (previousCounts.get(expiresAt) || 0) + 1);
      }
    }
    const counts = new Map();
    for (const expiresAt of expirations) {
      if (Number.isSafeInteger(expiresAt)) {
        counts.set(expiresAt, (counts.get(expiresAt) || 0) + 1);
      }
    }
    for (const [expiresAt, count] of counts) {
      const expiryMs = expiresAt * 1000;
      const newlyObserved = previousSummary && count > (previousCounts.get(expiresAt) || 0);
      const crossedHorizon = Number.isFinite(previousReadMs) && expiryMs - previousReadMs > horizonMs;
      if (expiryMs > currentReadMs
        && expiryMs - currentReadMs <= horizonMs
        && (newlyObserved || crossedHorizon)) {
        const alertCount = newlyObserved ? count - (previousCounts.get(expiresAt) || 0) : count;
        events.push({
          type: "reset-credit-expiry",
          text: `${alertCount} usage reset${alertCount === 1 ? "" : "s"} expire${alertCount === 1 ? "s" : ""} ${formatTimestamp(expiresAt, settings.timezone)}`
        });
      }
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
