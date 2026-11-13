const DAY = 86_400_000;
const MINUTE = 60_000;
export const METRICS_INTERVAL_MS = 10 * MINUTE;
const SUMMARY_KEYS = ["lifetimeTokens", "peakDailyTokens", "longestRunningTurnSec", "currentStreakDays", "longestStreakDays"];
const WINDOWS = { fiveHourUsed: 300, weeklyUsed: 10080, reserveUsed: 10080 };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
const shiftDay = (date, days) => dayKey(Date.parse(date) + days * DAY);
export function validDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && dayKey(Date.parse(value)) === value;
}

export function normalizeTokenReport(raw, previous = {}, now = Date.now()) {
  const buckets = new Map();
  const cutoff = dayKey(now - 364 * DAY);
  for (const bucket of [...(Array.isArray(previous.dailyUsageBuckets) ? previous.dailyUsageBuckets : []),
    ...(Array.isArray(raw?.dailyUsageBuckets) ? raw.dailyUsageBuckets : [])]) {
    if (validDay(bucket?.startDate) && bucket.startDate >= cutoff && bucket.startDate <= dayKey(now)
      && count(bucket.tokens) !== null) buckets.set(bucket.startDate, { startDate: bucket.startDate, tokens: bucket.tokens });
  }
  return {
    summary: Object.fromEntries(SUMMARY_KEYS.map(key => [key, count(raw?.summary?.[key])])),
    dailyUsageBuckets: [...buckets.values()].sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(-365),
    dailyReported: typeof raw?.dailyReported === "boolean" ? raw.dailyReported : Array.isArray(raw?.dailyUsageBuckets)
  };
}

export function emptyMetrics(provider = "codex") {
  return { identity: null, emailFingerprint: null, dedupeKey: null, status: provider === "claude" ? "unsupported" : "unavailable",
    updatedAt: null, attemptedAt: null, failures: 0, nextAt: null, report: null, extraUsage: null, observations: [], archives: [] };
}

export function normalizeMetrics(value, provider = "codex", now = Date.now()) {
  const out = emptyMetrics(provider);
  if (!value || typeof value !== "object") return out;
  out.identity = typeof value.identity === "string" ? value.identity.slice(0, 200) : null;
  out.emailFingerprint = typeof value.emailFingerprint === "string" && /^[a-f0-9]{64}$/.test(value.emailFingerprint) ? value.emailFingerprint : null;
  out.dedupeKey = typeof value.dedupeKey === "string" ? value.dedupeKey.slice(0, 200) : null;
  out.status = ["available", "partial", "unsupported", "unavailable", "error", "auth-required"].includes(value.status) ? value.status : out.status;
  for (const key of ["updatedAt", "attemptedAt", "nextAt"]) out[key] = iso(value[key]);
  out.failures = Math.min(count(value.failures) || 0, 10);
  out.report = value.report ? normalizeTokenReport(value.report, {}, now) : null;
  out.extraUsage = normalizeExtraUsage(value.extraUsage);
  out.observations = normalizeObservations(value.observations, now);
  out.archives = (Array.isArray(value.archives) ? value.archives : []).slice(-5).map(archive => ({
    identity: typeof archive?.identity === "string" ? archive.identity.slice(0, 200) : null,
    endedAt: iso(archive?.endedAt), report: archive?.report ? normalizeTokenReport(archive.report, {}, now) : null,
    extraUsage: normalizeExtraUsage(archive?.extraUsage)
  }));
  return out;
}

export function bindMetricsIdentity(metrics, identity, dedupeKey = null, now = Date.now()) {
  if (!identity) return metrics;
  if (metrics.identity && metrics.identity !== identity) {
    const archives = [...metrics.archives, { identity: metrics.identity, endedAt: new Date(now).toISOString(),
      report: metrics.report, extraUsage: metrics.extraUsage }].slice(-5);
    Object.assign(metrics, emptyMetrics(), { archives });
  }
  metrics.identity = identity;
  metrics.dedupeKey = dedupeKey;
  return metrics;
}

export function normalizeExtraUsage(value) {
  if (!value || typeof value !== "object") return null;
  const currency = typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency) ? value.currency : null;
  const spentMinor = count(value.spentMinor);
  const limitMinor = count(value.limitMinor);
  if (!currency || (spentMinor === null && limitMinor === null)) return null;
  return { currency, spentMinor, limitMinor, period: validDay(value.period) ? value.period.slice(0, 7) :
    typeof value.period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.period) ? value.period : null,
  updatedAt: iso(value.updatedAt) };
}

export function normalizeBilling(value) {
  return (Array.isArray(value) ? value : []).filter(entry => entry && validDay(entry.effectiveFrom)
    && count(entry.amountMinor) !== null && typeof entry.currency === "string" && /^[A-Z]{3}$/.test(entry.currency)
    && Number.isInteger(entry.billingDay) && entry.billingDay >= 1 && entry.billingDay <= 31)
    .map(({ effectiveFrom, amountMinor, currency, billingDay }) => ({ effectiveFrom, amountMinor, currency, billingDay }))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).slice(-120);
}

export function updateBilling(history, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || normalizeBilling([entry]).length !== 1) {
    const error = new Error("Billing needs a non-negative amount in minor units, an ISO currency, a valid effective date, and billing day 1–31.");
    error.statusCode = 400;
    throw error;
  }
  return normalizeBilling([...normalizeBilling(history).filter(item => item.effectiveFrom !== entry.effectiveFrom), entry]);
}

export function normalizeObservations(values, now = Date.now()) {
  return (Array.isArray(values) ? values : []).filter(item => iso(item?.ts) && Date.parse(item.ts) >= now - 2 * DAY
    && Date.parse(item.ts) <= now && Object.hasOwn(WINDOWS, item.key)
    && Number.isFinite(item.used) && item.used >= 0 && item.used <= 100
    && Number.isSafeInteger(item.resetsAt) && item.resetsAt > 0)
    .map(({ ts, key, used, resetsAt }) => ({ ts, key, used, resetsAt }))
    .sort((a, b) => a.ts.localeCompare(b.ts)).slice(-1800);
}

export function quotaWindows(dashboard = {}) {
  const limits = dashboard.rateLimits;
  const reserve = Object.values(dashboard.rateLimitsByLimitId || {}).filter(item => item?.limitName === "gpt-reserve")
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0];
  const find = (snapshot, duration) => [snapshot?.primary, snapshot?.secondary].find(win => win?.windowDurationMins === duration);
  return { fiveHourUsed: find(limits, 300), weeklyUsed: find(limits, 10080), reserveUsed: find(reserve, 10080) };
}

export function recordQuotaObservations(metrics, dashboard, observedKeys, now = Date.now()) {
  const samples = normalizeObservations(metrics.observations, now);
  for (const [key, window] of Object.entries(quotaWindows(dashboard))) {
    if (!observedKeys.includes(key) || !Number.isFinite(window?.usedPercent) || !Number.isSafeInteger(window?.resetsAt)) continue;
    const previous = samples.filter(sample => sample.key === key).at(-1);
    if (!previous || previous.used !== window.usedPercent || previous.resetsAt !== window.resetsAt
      || now - Date.parse(previous.ts) >= METRICS_INTERVAL_MS) {
      samples.push({ ts: new Date(now).toISOString(), key, used: window.usedPercent, resetsAt: window.resetsAt });
    }
  }
  metrics.observations = normalizeObservations(samples, now);
}

export function quotaProjection(observations, key, { now = Date.now(), blocked = false, live = true } = {}) {
  const all = normalizeObservations(observations, now).filter(item => item.key === key);
  const last = all.at(-1);
  const base = { key, status: "insufficient", used: last?.used ?? null, resetsAt: last?.resetsAt ?? null,
    ratePerHour: null, allowedRatePerHour: null, exhaustionAt: null, projectedAtReset: null,
    observedFrom: null, observedTo: last?.ts ?? null, points: 0 };
  if (blocked && key !== "reserveUsed") return { ...base, status: "blocked" };
  if (!last) return base;
  if (!live || now - Date.parse(last.ts) > 20 * MINUTE || last.resetsAt * 1000 <= now) return { ...base, status: "stale" };
  base.allowedRatePerHour = (100 - last.used) / ((last.resetsAt * 1000 - now) / 3_600_000);
  if (last.used >= 100) return { ...base, status: "exhausted", exhaustionAt: new Date(now).toISOString() };
  let segment = [];
  for (const item of all) {
    const prev = segment.at(-1);
    if (prev && (item.used < prev.used || Math.abs(item.resetsAt - prev.resetsAt) > 120
      || Date.parse(item.ts) - Date.parse(prev.ts) > 30 * MINUTE)) segment = [];
    segment.push(item);
  }
  const horizon = key === "fiveHourUsed" ? 3_600_000 : DAY;
  segment = segment.filter(item => Date.parse(item.ts) >= now - horizon);
  base.points = segment.length;
  base.observedFrom = segment[0]?.ts || null;
  if (segment.length < 3 || Date.parse(last.ts) - Date.parse(segment[0].ts) < 30 * MINUTE) return base;
  const xs = segment.map(item => (Date.parse(item.ts) - Date.parse(segment[0].ts)) / 3_600_000);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = segment.reduce((a, b) => a + b.used, 0) / segment.length;
  const rate = xs.reduce((sum, x, i) => sum + (x - mx) * (segment[i].used - my), 0)
    / xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  if (!Number.isFinite(rate)) return base;
  if (rate <= 0) return { ...base, status: "idle", ratePerHour: 0, projectedAtReset: last.used };
  const exhaustionMs = Date.parse(last.ts) + (100 - last.used) / rate * 3_600_000;
  return { ...base, status: exhaustionMs < last.resetsAt * 1000 ? "at-risk" : "reset-first", ratePerHour: rate,
    exhaustionAt: Number.isFinite(exhaustionMs) && exhaustionMs < 8.64e15 ? new Date(exhaustionMs).toISOString() : null,
    projectedAtReset: Math.min(100, last.used + rate * (last.resetsAt * 1000 - Date.parse(last.ts)) / 3_600_000) };
}

export function monthlyOutlook(buckets, now = Date.now()) {
  const today = dayKey(now);
  const map = new Map((buckets || []).map(bucket => [bucket.startDate, bucket.tokens]));
  const days = [];
  for (let n = 1; n <= 7 && map.has(shiftDay(today, -n)); n++) days.push(shiftDay(today, -n));
  if (days.length < 3) return { status: "insufficient", dailyMean: null, projectedTokens: null, baselineDays: days.length };
  const mean = days.reduce((sum, date) => sum + map.get(date), 0) / days.length;
  const first = today.slice(0, 7) + "-01";
  const nextMonth = new Date(Date.parse(first));
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const completedDays = Math.round((Date.parse(today) - Date.parse(first)) / DAY);
  const complete = Array.from({ length: completedDays }, (_, n) => shiftDay(first, n)).every(date => map.has(date));
  const completedTokens = Array.from({ length: completedDays }, (_, n) => map.get(shiftDay(first, n)) || 0).reduce((a, b) => a + b, 0);
  const remaining = Math.round((nextMonth.getTime() - Date.parse(today)) / DAY) - 1;
  return { status: complete ? "month-end" : "30-day-pace", dailyMean: mean,
    projectedTokens: Math.round(complete ? completedTokens + Math.max(map.get(today) || 0, mean) + mean * remaining : mean * 30),
    baselineDays: days.length, observedFrom: days.at(-1), observedTo: days[0], period: today.slice(0, 7) };
}

function rangeUsage(report, range, now) {
  const today = dayKey(now);
  const days = { today: 1, "7d": 7, "30d": 30, "90d": 90 }[range];
  const from = days ? shiftDay(today, 1 - days) : null;
  const buckets = (report?.dailyUsageBuckets || []).filter(bucket => !from || bucket.startDate >= from);
  const complete = Boolean(days && Array.from({ length: days }, (_, i) => shiftDay(from, i))
    .every(date => buckets.some(bucket => bucket.startDate === date)));
  const tokens = range === "lifetime" ? report?.summary?.lifetimeTokens ?? null
    : buckets.length ? buckets.reduce((sum, bucket) => sum + bucket.tokens, 0) : null;
  let changePercent = null;
  let comparison = null;
  if (days) {
    const completed = Array.from({ length: days }, (_, i) => shiftDay(today, i - days));
    const earlier = Array.from({ length: days }, (_, i) => shiftDay(today, i - 2 * days));
    const map = new Map((report?.dailyUsageBuckets || []).map(bucket => [bucket.startDate, bucket.tokens]));
    if ([...earlier, ...completed].every(date => map.has(date))) {
      const previous = earlier.reduce((sum, date) => sum + map.get(date), 0);
      const current = completed.reduce((sum, date) => sum + map.get(date), 0);
      if (previous > 0) changePercent = (current - previous) / previous * 100;
      comparison = { from: completed[0], to: completed.at(-1), days };
    }
  }
  return { tokens, buckets, from, to: today, complete: range === "lifetime" ? tokens !== null : complete,
    reportedDays: buckets.length, expectedDays: days || null, changePercent, comparison,
    dailyAverage: buckets.length ? buckets.reduce((sum, bucket) => sum + bucket.tokens, 0) / buckets.length : null,
    peakDay: buckets.length ? buckets.reduce((best, bucket) => bucket.tokens > best.tokens ? bucket : best) : null };
}

function costsForAccount(account, usage, now) {
  const today = dayKey(now);
  const billing = normalizeBilling(account.billing);
  const fee = billing.filter(entry => entry.effectiveFrom <= today).at(-1) || null;
  const extraUsage = normalizeExtraUsage(account.metrics?.extraUsage);
  // Align the denominator to the last completed subscription period, clamping day 31 in short months.
  const anniversary = (month, day) => {
    const date = new Date(Date.parse(month.slice(0, 7) + "-01"));
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    return dayKey(date.getTime());
  };
  let priorEnd = anniversary(today, fee?.billingDay || 1);
  if (priorEnd > today) priorEnd = anniversary(shiftDay(today.slice(0, 7) + "-01", -1), fee?.billingDay || 1);
  const priorStart = anniversary(shiftDay(priorEnd.slice(0, 7) + "-01", -1), fee?.billingDay || 1);
  const priorFee = billing.filter(entry => entry.effectiveFrom <= priorStart).at(-1);
  const changed = billing.some(entry => entry.effectiveFrom > priorStart && entry.effectiveFrom < priorEnd);
  const map = new Map((account.metrics?.report?.dailyUsageBuckets || []).map(bucket => [bucket.startDate, bucket.tokens]));
  const dates = Array.from({ length: Math.round((Date.parse(priorEnd) - Date.parse(priorStart)) / DAY) }, (_, n) => shiftDay(priorStart, n));
  const priorTokens = dates.every(date => map.has(date)) ? dates.reduce((sum, date) => sum + map.get(date), 0) : null;
  const efficiency = priorFee && priorFee.billingDay === fee?.billingDay && !changed && priorTokens > 0 ? { period: `${priorStart}–${priorEnd} (end exclusive)`, currency: priorFee.currency,
    perMillionMinor: priorFee.amountMinor / priorTokens * 1e6, tokens: priorTokens } : null;
  return { billing, monthlyFee: fee, extraUsage, efficiency };
}

export function buildUsageMetrics(accounts, { range = "30d", accountId = "", provider = "", now = Date.now(), claudeLive = () => true } = {}) {
  if (!["today", "7d", "30d", "90d", "lifetime"].includes(range)) range = "30d";
  const candidates = accounts.filter(account => (!accountId || account.id === accountId) && (!provider || account.provider === provider));
  const seen = new Map();
  // Prefer the freshest slot when the same provider account was added twice.
  for (const account of [...candidates].sort((a, b) => (Date.parse(b.metrics?.updatedAt) || 0) - (Date.parse(a.metrics?.updatedAt) || 0))) {
    if (account.metrics?.dedupeKey) {
      const key = `${account.provider}:${account.metrics.dedupeKey}`;
      if (!seen.has(key)) seen.set(key, account.id);
    }
  }
  const rows = candidates.map(account => {
    const metrics = normalizeMetrics(account.metrics, account.provider, now);
    const isClaude = account.provider === "claude";
    const report = isClaude ? null : metrics.report;
    const usage = rangeUsage(report, range, now);
    const duplicateOf = metrics.dedupeKey ? seen.get(`${account.provider}:${metrics.dedupeKey}`) : null;
    const stale = Boolean(metrics.updatedAt && now - Date.parse(metrics.updatedAt) > 2 * METRICS_INTERVAL_MS);
    const windows = quotaWindows(account.dashboard);
    const forecasts = Object.keys(WINDOWS).filter(key => windows[key] || metrics.observations.some(item => item.key === key))
      .map(key => quotaProjection(metrics.observations, key, {
      now, blocked: account.dashboard?.ordinaryUsageAllowed === false,
      live: !isClaude || claudeLive(account)
    }));
    const limiting = forecasts.filter(item => item.status === "at-risk").sort((a, b) => Date.parse(a.exhaustionAt) - Date.parse(b.exhaustionAt))[0]?.key || null;
    return { id: account.id, label: account.label, provider: account.provider,
      status: isClaude ? "unsupported" : stale ? "stale" : metrics.status,
      source: isClaude ? null : "account/usage/read", scope: "account", updatedAt: metrics.updatedAt,
      attemptedAt: metrics.attemptedAt, nextAt: metrics.nextAt, duplicateOf: duplicateOf !== account.id ? duplicateOf : null,
      identityVerified: Boolean(metrics.identity && !metrics.identity.startsWith("unverified:")),
      capabilities: { tokens: !isClaude && metrics.status !== "unsupported", daily: !isClaude && Boolean(report?.dailyReported), modelBreakdown: false, reportedSpend: Boolean(metrics.extraUsage) },
      summary: report?.summary || Object.fromEntries(SUMMARY_KEYS.map(key => [key, null])), usage,
      outlook: isClaude || stale || !report?.dailyReported ? { status: isClaude ? "unsupported" : stale ? "stale" : "insufficient", projectedTokens: null } : monthlyOutlook(report?.dailyUsageBuckets, now),
      forecasts, limitingWindow: limiting, costs: costsForAccount({ ...account, metrics }, usage, now) };
  });
  const unique = rows.filter(row => !row.duplicateOf);
  const reported = unique.filter(row => row.usage.tokens !== null);
  const daily = new Map();
  for (const row of unique) for (const bucket of row.usage.buckets) {
    const point = daily.get(bucket.startDate) || { date: bucket.startDate, accounts: {}, tokens: 0 };
    point.accounts[row.id] = bucket.tokens;
    point.tokens += bucket.tokens;
    daily.set(bucket.startDate, point);
  }
  const money = {};
  const reportedSpend = new Map();
  for (const row of unique) {
    const fee = row.costs.monthlyFee;
    if (fee) money[fee.currency] = (money[fee.currency] || 0) + fee.amountMinor;
    const extra = row.costs.extraUsage;
    if (extra?.spentMinor !== null && extra?.spentMinor !== undefined && extra.period) {
      const key = `${extra.currency}:${extra.period}`;
      const group = reportedSpend.get(key) || { currency: extra.currency, period: extra.period, spentMinor: 0, reportedAccounts: 0, stale: false };
      group.spentMinor += extra.spentMinor;
      group.reportedAccounts++;
      group.stale ||= !extra.updatedAt || now - Date.parse(extra.updatedAt) > 2 * METRICS_INTERVAL_MS;
      reportedSpend.set(key, group);
    }
  }
  return { range, generatedAt: new Date(now).toISOString(), dateBasis: "Provider daily date labels; UTC calendar used for range selection",
    accounts: rows, totals: { tokens: reported.length ? reported.reduce((sum, row) => sum + row.usage.tokens, 0) : null,
      reportedAccounts: reported.length, totalAccounts: unique.length, duplicateAccounts: rows.length - unique.length,
      complete: reported.length === unique.length && unique.length > 0 && reported.every(row => row.identityVerified && row.usage.complete && row.status !== "stale" && ["available", "partial"].includes(row.status)),
      configuredMonthlyFees: money, configuredFeeAccounts: unique.filter(row => row.costs.monthlyFee).length,
      reportedExtraUsage: [...reportedSpend.values()] },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}
