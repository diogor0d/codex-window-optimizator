const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_MAX_SAMPLES = 5000;

function windowByDuration(snapshot, duration) {
  return [snapshot?.primary, snapshot?.secondary]
    .find((window) => window?.windowDurationMins === duration) || null;
}

function reserveSnapshot(dashboard) {
  return Object.values(dashboard?.rateLimitsByLimitId || {})
    .filter((snapshot) => snapshot?.limitName === "gpt-reserve")
    .sort((a, b) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0))[0] || null;
}

function percent(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

export function usageSampleFromDashboard(dashboard, ts = new Date().toISOString()) {
  const fiveHour = windowByDuration(dashboard?.rateLimits, 300);
  const weekly = windowByDuration(dashboard?.rateLimits, 10080);
  const reserve = windowByDuration(reserveSnapshot(dashboard), 10080);
  const sample = {
    ts,
    fiveHourUsed: percent(fiveHour?.usedPercent),
    weeklyUsed: percent(weekly?.usedPercent),
    reserveUsed: percent(reserve?.usedPercent),
    ordinaryUsageAllowed: typeof dashboard?.ordinaryUsageAllowed === "boolean"
      ? dashboard.ordinaryUsageAllowed
      : null
  };
  return [sample.fiveHourUsed, sample.weeklyUsed, sample.reserveUsed].some(Number.isFinite)
    ? sample
    : null;
}

export function observedUsageKeys(previousDashboard, currentDashboard, payload, sparse = false) {
  if (!sparse) {
    return ["fiveHourUsed", "weeklyUsed", "reserveUsed"];
  }
  const priorSnapshots = Object.entries(previousDashboard?.rateLimitsByLimitId || {});
  const reserve = payload?.limitName === "gpt-reserve"
    || priorSnapshots.some(([key, snapshot]) => snapshot?.limitName === "gpt-reserve"
      && (payload?.limitId ? snapshot.limitId === payload.limitId || key === payload.limitId : snapshot.limitName === payload?.limitName));
  const ordinaryLimitId = previousDashboard?.rateLimits?.limitId || currentDashboard?.rateLimits?.limitId;
  const ordinary = !reserve && (!ordinaryLimitId || !payload?.limitId || ordinaryLimitId === payload.limitId);
  if (!reserve && !ordinary) {
    return [];
  }
  const mergedTarget = reserve
    ? Object.entries(currentDashboard?.rateLimitsByLimitId || {}).find(([key, snapshot]) =>
      snapshot?.limitName === "gpt-reserve"
      && (payload?.limitId ? snapshot.limitId === payload.limitId || key === payload.limitId : true))?.[1]
    : currentDashboard?.rateLimits;
  return ["primary", "secondary"].flatMap((windowKey) => {
    if (!payload?.[windowKey] || typeof payload[windowKey] !== "object") {
      return [];
    }
    const duration = payload[windowKey].windowDurationMins ?? mergedTarget?.[windowKey]?.windowDurationMins;
    if (duration === 300 && !reserve) {
      return ["fiveHourUsed"];
    }
    if (duration === 10080) {
      return [reserve ? "reserveUsed" : "weeklyUsed"];
    }
    return [];
  });
}

export function normalizeUsageHistory(history, nowMs = Date.now()) {
  if (!Array.isArray(history)) {
    return [];
  }
  const cutoff = nowMs - HISTORY_RETENTION_MS;
  const valid = history.filter((sample) => {
    const timestamp = Date.parse(sample?.ts || "");
    return Number.isFinite(timestamp)
      && [sample.fiveHourUsed, sample.weeklyUsed, sample.reserveUsed].some(Number.isFinite);
  }).map((sample) => ({
    ts: new Date(sample.ts).toISOString(),
    fiveHourUsed: percent(sample.fiveHourUsed),
    weeklyUsed: percent(sample.weeklyUsed),
    reserveUsed: percent(sample.reserveUsed),
    ordinaryUsageAllowed: typeof sample.ordinaryUsageAllowed === "boolean" ? sample.ordinaryUsageAllowed : null
  })).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const firstRetained = valid.findIndex((sample) => Date.parse(sample.ts) >= cutoff);
  const start = firstRetained > 0 ? firstRetained - 1 : firstRetained === -1 ? Math.max(0, valid.length - 1) : 0;
  return valid.slice(start).slice(-HISTORY_MAX_SAMPLES);
}

function sameUsage(left, right) {
  return left?.fiveHourUsed === right?.fiveHourUsed
    && left?.weeklyUsed === right?.weeklyUsed
    && left?.reserveUsed === right?.reserveUsed
    && left?.ordinaryUsageAllowed === right?.ordinaryUsageAllowed;
}

function consumptionDetected(previous, current) {
  return ["fiveHourUsed", "weeklyUsed", "reserveUsed"]
    .some((key) => Number.isFinite(previous?.[key])
      && Number.isFinite(current?.[key])
      && current[key] > previous[key]);
}

export function appendUsageSample(history, dashboard, ts = new Date().toISOString(), nowMs = Date.parse(ts)) {
  const normalized = normalizeUsageHistory(history, nowMs);
  const sample = usageSampleFromDashboard(dashboard, ts);
  const previous = normalized.at(-1);
  if (!sample || sameUsage(previous, sample)) {
    return { history: normalized, changed: false, activityDetected: false };
  }
  return {
    history: [...normalized, sample].slice(-HISTORY_MAX_SAMPLES),
    changed: true,
    activityDetected: consumptionDetected(previous, sample)
  };
}

export function latestUsageActivityAt(history) {
  const normalized = normalizeUsageHistory(history);
  for (let index = normalized.length - 1; index > 0; index -= 1) {
    if (consumptionDetected(normalized[index - 1], normalized[index])) {
      return normalized[index].ts;
    }
  }
  return null;
}

export function adaptivePollingInterval(lastActivityAt, nowMs = Date.now()) {
  const elapsed = nowMs - Date.parse(lastActivityAt || "");
  if (Number.isFinite(elapsed) && elapsed >= 0) {
    if (elapsed <= 10 * 60 * 1000) {
      return 60 * 1000;
    }
    if (elapsed <= 30 * 60 * 1000) {
      return 2 * 60 * 1000;
    }
    if (elapsed <= 2 * 60 * 60 * 1000) {
      return 5 * 60 * 1000;
    }
  }
  return 10 * 60 * 1000;
}

export const usageHistoryLimits = {
  retentionMs: HISTORY_RETENTION_MS,
  maxSamples: HISTORY_MAX_SAMPLES
};
