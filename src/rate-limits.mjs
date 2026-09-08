function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeRateLimitSnapshot(previous, incoming, updatedAt, sparse = false) {
  if (!isObject(incoming)) {
    return null;
  }
  const prior = isObject(previous) ? previous : {};
  const next = sparse ? { ...prior } : {};

  for (const [key, value] of Object.entries(incoming)) {
    if (sparse && value == null) {
      continue;
    }
    if (["primary", "secondary"].includes(key) && isObject(value)) {
      next[key] = { ...(sparse && isObject(prior[key]) ? prior[key] : {}), ...value, updatedAt };
    } else {
      next[key] = value;
    }
  }

  if (sparse) {
    for (const key of ["primary", "secondary"]) {
      if (!isObject(incoming[key]) && isObject(prior[key])) {
        next[key] = prior[key];
      }
    }
  }
  return { ...next, updatedAt };
}

export function recordRateLimitsRead(dashboard, result, updatedAt) {
  const next = { ...dashboard };
  next.rateLimits = mergeRateLimitSnapshot(null, result.rateLimits, updatedAt);
  next.rateLimitsByLimitId = {};
  if (isObject(result.rateLimitsByLimitId)) {
    for (const [limitId, snapshot] of Object.entries(result.rateLimitsByLimitId)) {
      const normalized = mergeRateLimitSnapshot(null, snapshot, updatedAt);
      if (normalized) {
        next.rateLimitsByLimitId[limitId] = normalized;
      }
    }
  }
  next.ordinaryUsageAllowed = typeof result.ordinaryUsageAllowed === "boolean"
    ? result.ordinaryUsageAllowed
    : null;
  const availableCount = result.rateLimitResetCredits?.availableCount;
  const credits = result.rateLimitResetCredits?.credits;
  const expiresAt = Array.isArray(credits)
    ? credits.map((credit) => {
        if (!Object.hasOwn(credit || {}, "expiresAt")) {
          return "unknown";
        }
        return Number.isSafeInteger(credit.expiresAt) ? credit.expiresAt : credit.expiresAt === null ? null : "unknown";
      })
    : null;
  next.rateLimitResetCredits = Number.isSafeInteger(availableCount) && availableCount >= 0
    ? {
        availableCount,
        expiresAt,
        detailsComplete: Array.isArray(credits) ? credits.length >= availableCount : false,
        updatedAt
      }
    : null;
  return next;
}

export function recordRateLimitsNotification(dashboard, incoming, updatedAt) {
  if (!isObject(incoming)) {
    return dashboard;
  }
  const next = { ...dashboard };
  const byId = { ...(isObject(dashboard.rateLimitsByLimitId) ? dashboard.rateLimitsByLimitId : {}) };
  const entries = Object.entries(byId);
  const matchingEntry = entries.find(([, snapshot]) =>
    incoming.limitId && snapshot?.limitId === incoming.limitId)
    || entries.find(([, snapshot]) => incoming.limitName && snapshot?.limitName === incoming.limitName);
  const mapKey = matchingEntry?.[0] || incoming.limitId || incoming.limitName;
  if (mapKey) {
    byId[mapKey] = mergeRateLimitSnapshot(matchingEntry?.[1], incoming, updatedAt, true);
    next.rateLimitsByLimitId = byId;
  }

  const isReserve = incoming.limitName === "gpt-reserve"
    || matchingEntry?.[1]?.limitName === "gpt-reserve";
  const isOrdinary = !isReserve && (!dashboard.rateLimits?.limitId
    || !incoming.limitId
    || dashboard.rateLimits.limitId === incoming.limitId);
  if (isOrdinary) {
    next.rateLimits = mergeRateLimitSnapshot(dashboard.rateLimits, incoming, updatedAt, true);
  }
  return next;
}
