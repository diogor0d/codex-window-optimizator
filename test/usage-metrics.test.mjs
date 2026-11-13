import test from "node:test";
import assert from "node:assert/strict";
import { bindMetricsIdentity, buildUsageMetrics, dayKey, emptyMetrics, monthlyOutlook, normalizeBilling, normalizeMetrics,
  normalizeTokenReport, quotaProjection, recordQuotaObservations, updateBilling } from "../src/usage-metrics.mjs";
import { createMetricsCollector } from "../src/metrics-collector.mjs";
import { PRICE_CATALOG, simulateCost } from "../public/cost-simulator.js";
import { parseClaudeExtraUsage } from "../src/claude-usage.mjs";

const now = Date.parse("2026-11-11T12:00:00Z");
const stamp = minutes => new Date(now + minutes * 60000).toISOString();
const bucket = (date, tokens) => ({ startDate: date, tokens });
const raw = { summary: { lifetimeTokens: 9000000, peakDailyTokens: 4000, currentStreakDays: 4 },
  dailyUsageBuckets: [bucket("2026-11-09", 100), bucket("2026-11-10", 200), bucket("2026-11-11", 50)] };
const account = (id = "one", provider = "codex") => ({ id, label: id, provider, metrics: emptyMetrics(provider), dashboard: {}, billing: [] });

test("provider buckets replace rather than accumulate, preserve unknowns, and retain 365 days", () => {
  const previous = normalizeTokenReport(raw, {}, now);
  const report = normalizeTokenReport({ summary: { lifetimeTokens: 9000010, secret: "omit" },
    dailyUsageBuckets: [bucket("2026-11-10", 180), bucket("2025-01-01", 999), bucket("2026-11-12", 99),
      bucket("2026-02-30", 88), bucket("2026-11-08", -1)] }, previous, now);
  assert.deepEqual(report.dailyUsageBuckets, [bucket("2026-11-09", 100), bucket("2026-11-10", 180), bucket("2026-11-11", 50)]);
  assert.equal(report.summary.peakDailyTokens, null);
  assert.equal(report.summary.lifetimeTokens, 9000010);
  assert.equal(JSON.stringify(report).includes("secret"), false);
  assert.deepEqual(normalizeTokenReport({ ...raw, dailyUsageBuckets: null }, previous, now).dailyUsageBuckets, previous.dailyUsageBuckets);
  assert.equal(normalizeMetrics({ report: { ...previous, dailyReported: false } }, "codex", now).report.dailyReported, false);
});

test("fleet totals exclude confirmed duplicates and never substitute runs or Claude zeros", () => {
  const first = account();
  first.scheduledRuns = [{ tokens: 999999999 }];
  Object.assign(first.metrics, { report: normalizeTokenReport(raw, {}, now), updatedAt: stamp(0), status: "available", dedupeKey: "same" });
  const duplicate = { ...first, id: "duplicate", metrics: { ...first.metrics, updatedAt: stamp(-1) } };
  const claude = account("claude", "claude");
  claude.metrics.report = first.metrics.report;
  const view = buildUsageMetrics([first, duplicate, claude], { range: "lifetime", now });
  assert.equal(view.totals.tokens, 9000000);
  assert.equal(view.totals.totalAccounts, 2);
  assert.equal(view.totals.reportedAccounts, 1);
  assert.equal(view.totals.complete, false);
  assert.equal(view.accounts[1].duplicateOf, "one");
  assert.equal(view.accounts[2].usage.tokens, null);
  assert.equal(view.accounts[2].summary.lifetimeTokens, null);
  assert.equal(view.accounts[2].outlook.status, "unsupported");
  assert.equal(buildUsageMetrics([first, claude], { provider: "claude", now }).totals.tokens, null);
  assert.equal(buildUsageMetrics([first], { range: "7d", now }).accounts[0].usage.complete, false);
});

test("identity changes archive the previous report and reset observations and spending", () => {
  const metrics = { ...emptyMetrics(), identity: "old", report: raw, extraUsage: { currency: "USD", spentMinor: 100 },
    observations: [{ ts: stamp(0), key: "weeklyUsed", used: 40, resetsAt: now / 1000 + 3600 }] };
  bindMetricsIdentity(metrics, "new", "new-key", now);
  assert.equal(metrics.report, null);
  assert.equal(metrics.extraUsage, null);
  assert.deepEqual(metrics.observations, []);
  const restored = normalizeMetrics(JSON.parse(JSON.stringify(metrics)), "codex", now);
  assert.equal(restored.archives[0].report.summary.lifetimeTokens, 9000000);
  assert.equal(restored.identity, "new");
});

test("daily comparisons exclude partial today and require both completed periods", () => {
  const item = account();
  item.metrics.report = normalizeTokenReport({ summary: {}, dailyUsageBuckets: [
    bucket("2026-11-09", 100), bucket("2026-11-10", 200), bucket("2026-11-11", 5)
  ] }, {}, now);
  let usage = buildUsageMetrics([item], { range: "today", now }).accounts[0].usage;
  assert.equal(usage.tokens, 5);
  assert.equal(usage.changePercent, 100);
  assert.deepEqual(usage.comparison, { from: "2026-11-10", to: "2026-11-10", days: 1 });
  item.metrics.report.dailyUsageBuckets = [bucket("2026-11-11", 5)];
  usage = buildUsageMetrics([item], { range: "today", now }).accounts[0].usage;
  assert.equal(usage.changePercent, null);
});

test("collector coalesces account reads, sends no thread ID, sanitizes values and backs off independently", async () => {
  const calls = [];
  let fail = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  let clock = now;
  const item = account();
  const collect = createMetricsCollector({ now: () => clock, read: async (account, method, params) => {
    calls.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt", email: "synthetic@example.invalid" } };
    await gate;
    if (fail) throw new Error("temporarily unavailable");
    return { ...raw, access_token: "must-not-persist" };
  } });
  const first = collect(item, { accountIdentity: "synthetic-one" });
  const second = collect(item);
  assert.equal(first, second);
  release();
  await first;
  assert.deepEqual(calls.find(call => call.method === "account/usage/read").params, {});
  assert.equal(item.metrics.report.summary.lifetimeTokens, 9000000);
  assert.equal(JSON.stringify(item.metrics).includes("must-not-persist"), false);
  const restored = normalizeMetrics(JSON.parse(JSON.stringify(item.metrics)), "codex", clock);
  assert.equal(restored.report.summary.lifetimeTokens, 9000000);
  await collect(item);
  assert.equal(calls.length, 2);
  clock += 600000;
  fail = true;
  await collect(item, { accountIdentity: "synthetic-one" });
  assert.equal(item.metrics.status, "error");
  assert.equal(item.metrics.report.summary.lifetimeTokens, 9000000);
  const failedAt = calls.length;
  await collect(item, { force: true });
  assert.equal(calls.length, failedAt);
  assert.equal(item.metrics.failures, 1);
  clock += 600000;
  await collect(item);
  assert.equal(item.metrics.report.summary.lifetimeTokens, 9000000, "a failed quota read must not change an already bound identity");
  assert.equal(item.metrics.archives.length, 0);
});

test("a report from a superseded provider process cannot overwrite current account metrics", async () => {
  let revision = 1, release;
  const gate = new Promise(resolve => { release = resolve; });
  const item = account();
  const collect = createMetricsCollector({ now: () => now, revision: () => revision, read: async (account, method) => {
    if (method === "account/read") return { account: { type: "chatgpt", email: "synthetic@example.invalid" } };
    await gate;
    return raw;
  } });
  const pending = collect(item);
  await new Promise(resolve => setImmediate(resolve));
  revision++;
  release();
  assert.equal((await pending).status, "superseded");
  assert.equal(item.metrics.report, null);
});

test("unsupported collection does not create a model turn or overwrite another account", async () => {
  const calls = [];
  const collect = createMetricsCollector({ now: () => now, read: async (account, method) => {
    calls.push(method);
    if (method === "account/read") return { account: { type: "chatgpt", email: "synthetic@example.invalid" } };
    throw new Error("-32601 method not found");
  } });
  const item = account();
  await collect(item);
  assert.equal(item.metrics.status, "unsupported");
  assert.equal((await collect(account("claude", "claude"))).status, "unsupported");
  assert.deepEqual(calls, ["account/read", "account/usage/read"]);
});

const samples = (used = [20, 30, 40], reset = now / 1000 + 3600) => used.map((value, n) => ({
  ts: stamp(-40 + n * 20), key: "fiveHourUsed", used: value, resetsAt: reset
}));

test("quota regression reports exhaustion risk, pacing budget and reset-first forecasts", () => {
  const result = quotaProjection(samples([40, 60, 80]), "fiveHourUsed", { now });
  assert.equal(result.status, "at-risk");
  assert.equal(result.ratePerHour, 60);
  assert.equal(result.allowedRatePerHour, 20);
  assert.equal(result.projectedAtReset, 100);
  assert.equal(result.exhaustionAt, stamp(20));
  assert.equal(quotaProjection(samples(), "fiveHourUsed", { now }).status, "reset-first");
  assert.equal(quotaProjection(samples([40, 40, 40]), "fiveHourUsed", { now }).status, "idle");
  assert.equal(quotaProjection(samples([100, 100, 100]), "fiveHourUsed", { now }).status, "exhausted");
});

test("quota forecasts split on resets, refills, gaps and stale observations, tolerating minute jitter", () => {
  const reset = samples();
  reset[2].resetsAt += 60;
  assert.equal(quotaProjection(reset, "fiveHourUsed", { now }).status, "reset-first");
  reset[2].resetsAt += 600;
  assert.equal(quotaProjection(reset, "fiveHourUsed", { now }).status, "insufficient");
  assert.equal(quotaProjection(samples([80, 90, 5]), "fiveHourUsed", { now }).status, "insufficient");
  const gap = samples();
  gap[1].ts = stamp(-31);
  assert.equal(quotaProjection(gap, "fiveHourUsed", { now }).status, "insufficient");
  assert.equal(quotaProjection(samples(), "fiveHourUsed", { now: now + 21 * 60000 }).status, "stale");
  assert.equal(quotaProjection(samples(), "fiveHourUsed", { now, blocked: true }).status, "blocked");
});

test("unchanged quota observations create ten-minute heartbeats using raw window percentages", () => {
  const metrics = emptyMetrics();
  const dashboard = { rateLimits: { primary: { usedPercent: 20, resetsAt: now / 1000 + 3600, windowDurationMins: 300 },
    secondary: { usedPercent: 100, resetsAt: now / 1000 + 86400, windowDurationMins: 10080 } } };
  for (const offset of [-40, -39, -20, 0]) recordQuotaObservations(metrics, dashboard, ["fiveHourUsed"], now + offset * 60000);
  assert.equal(metrics.observations.length, 3);
  assert.equal(metrics.observations[0].used, 20);
});

test("monthly outlook excludes partial today, respects gaps and handles month boundaries", () => {
  const buckets = Array.from({ length: 10 }, (_, n) => bucket(`2026-11-${String(n + 1).padStart(2, "0")}`, 100));
  const result = monthlyOutlook([...buckets, bucket("2026-11-11", 500)], now);
  assert.equal(result.status, "month-end");
  assert.equal(result.dailyMean, 100);
  assert.equal(result.projectedTokens, 3400);
  assert.equal(monthlyOutlook(buckets.slice(5), now).status, "30-day-pace");
  assert.equal(monthlyOutlook(buckets.slice(-2), now).status, "insufficient");
  const december = Date.parse("2026-12-01T12:00:00Z");
  const november = Array.from({ length: 7 }, (_, n) => bucket(dayKey(december - (n + 1) * 86400000), 100));
  assert.equal(monthlyOutlook(november, december).projectedTokens, 3100);
});

test("billing retains dated revisions, groups currencies and requires full matching cost periods", () => {
  const first = account();
  first.billing = updateBilling([], { amountMinor: 2000, currency: "EUR", billingDay: 1, effectiveFrom: "2026-10-01" });
  const second = account("usd");
  second.billing = updateBilling([], { amountMinor: 3000, currency: "USD", billingDay: 1, effectiveFrom: "2026-10-01" });
  const view = buildUsageMetrics([first, second], { now });
  assert.deepEqual(view.totals.configuredMonthlyFees, { EUR: 2000, USD: 3000 });
  assert.equal(view.accounts[0].costs.efficiency, null);
  first.metrics.report = normalizeTokenReport({ summary: {}, dailyUsageBuckets: Array.from({ length: 31 }, (_, n) =>
    bucket(`2026-10-${String(n + 1).padStart(2, "0")}`, 1000)) }, {}, now);
  assert.equal(buildUsageMetrics([first], { now }).accounts[0].costs.efficiency.tokens, 31000);
  first.billing = updateBilling(first.billing, { amountMinor: 2500, currency: "EUR", billingDay: 1, effectiveFrom: "2026-10-15" });
  assert.equal(buildUsageMetrics([first], { now }).accounts[0].costs.efficiency, null);
  assert.equal(normalizeBilling(first.billing).length, 2);
  assert.throws(() => updateBilling([], { amountMinor: -1 }), /Billing/);
});

test("Claude extra usage parser accepts only explicitly stated spend, not balances or unlimited", () => {
  assert.deepEqual(parseClaudeExtraUsage("Usage credits\n$12.34 / $50.00 spent this month", now),
    { currency: "USD", spentMinor: 1234, limitMinor: 5000, period: "2026-11" });
  assert.equal(parseClaudeExtraUsage("Extra usage\nUnlimited", now), null);
  assert.equal(parseClaudeExtraUsage("Extra usage\n$50.00 credit balance", now), null);
  assert.equal(parseClaudeExtraUsage("Usage credits\n$12 / €50 spent", now), null);
  assert.equal(parseClaudeExtraUsage("Extra usage\n€3.50 spent this month\nUnlimited", now).limitMinor, null);
});

test("cost scenarios price disjoint input categories and output without adding reasoning twice", () => {
  const result = simulateCost({ tokens: 1000000, outputPercent: 20, cacheReadPercent: 50, cacheWritePercent: 25,
    rates: { input: 2, output: 10, read: 0.2, write: 2.5 } });
  assert.equal(result.input, 800000);
  assert.equal(result.uncached, 200000);
  assert.equal(result.costUSD, 2.98);
  assert.ok(Math.abs(result.cacheDifferenceUSD - 0.62) < 1e-10);
  assert.throws(() => simulateCost({ tokens: 10, outputPercent: 10, cacheReadPercent: 90, cacheWritePercent: 20, rates: {} }));
  assert.throws(() => simulateCost({ tokens: NaN }));
  assert.ok(PRICE_CATALOG.every(row => row.source.startsWith("https://") && row.date === "2026-11-11"));
});
