import test from "node:test";
import assert from "node:assert/strict";

import {
  adaptivePollingInterval,
  appendUsageSample,
  latestUsageActivityAt,
  normalizeUsageHistory,
  observedUsageKeys,
  usageSampleFromDashboard
} from "../src/usage-history.mjs";

function dashboard({ fiveHour = 20, weekly = 30, reserve = 10, ordinaryUsageAllowed = true } = {}) {
  return {
    ordinaryUsageAllowed,
    rateLimits: {
      primary: { usedPercent: fiveHour, windowDurationMins: 300 },
      secondary: { usedPercent: weekly, windowDurationMins: 10080 }
    },
    rateLimitsByLimitId: {
      reserve: {
        limitName: "gpt-reserve",
        primary: { usedPercent: reserve, windowDurationMins: 10080 },
        updatedAt: "2026-09-18T10:00:00.000Z"
      }
    }
  };
}

test("extracts duration-based usage values from a dashboard", () => {
  assert.deepEqual(usageSampleFromDashboard(dashboard(), "2026-09-18T10:00:00.000Z"), {
    ts: "2026-09-18T10:00:00.000Z",
    fiveHourUsed: 20,
    weeklyUsed: 30,
    reserveUsed: 10,
    ordinaryUsageAllowed: true
  });
});

test("records only changed usage snapshots and distinguishes consumption from resets", () => {
  const baseline = appendUsageSample([], dashboard(), "2026-09-18T10:00:00.000Z");
  assert.equal(baseline.changed, true);
  assert.equal(baseline.activityDetected, false);

  const unchanged = appendUsageSample(baseline.history, dashboard(), "2026-09-18T10:05:00.000Z");
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.history.length, 1);

  const consumed = appendUsageSample(unchanged.history, dashboard({ fiveHour: 25 }), "2026-09-18T10:06:00.000Z");
  assert.equal(consumed.activityDetected, true);

  const reset = appendUsageSample(consumed.history, dashboard({ fiveHour: 0 }), "2026-09-18T15:00:00.000Z");
  assert.equal(reset.changed, true);
  assert.equal(reset.activityDetected, false);
});

test("finds the latest consumption event", () => {
  let history = appendUsageSample([], dashboard(), "2026-09-18T10:00:00.000Z").history;
  history = appendUsageSample(history, dashboard({ fiveHour: 25 }), "2026-09-18T10:05:00.000Z").history;
  history = appendUsageSample(history, dashboard({ fiveHour: 0 }), "2026-09-18T15:00:00.000Z").history;
  assert.equal(latestUsageActivityAt(history), "2026-09-18T10:05:00.000Z");
});

test("records a missing metric so charts can show a gap", () => {
  const baseline = appendUsageSample([], dashboard(), "2026-09-18T10:00:00.000Z");
  const withoutReserve = dashboard();
  withoutReserve.rateLimitsByLimitId = {};
  const result = appendUsageSample(baseline.history, withoutReserve, "2026-09-18T10:05:00.000Z");
  assert.equal(result.changed, true);
  assert.equal(result.history.at(-1).reserveUsed, null);
});

test("classifies sparse observations using the merged window duration", () => {
  const previous = dashboard();
  const current = dashboard({ fiveHour: 25 });
  assert.deepEqual(observedUsageKeys(previous, current, {
    primary: { usedPercent: 25 }
  }, true), ["fiveHourUsed"]);

  assert.deepEqual(observedUsageKeys(previous, current, {
    limitId: "reserve",
    primary: { usedPercent: 15 }
  }, true), ["reserveUsed"]);

  previous.rateLimits.limitId = "ordinary";
  current.rateLimits.limitId = "ordinary";
  assert.deepEqual(observedUsageKeys(previous, current, {
    limitId: "other-model",
    primary: { usedPercent: 40, windowDurationMins: 300 }
  }, true), []);
});

test("uses bounded adaptive polling intervals", () => {
  const now = Date.parse("2026-09-18T12:00:00.000Z");
  assert.equal(adaptivePollingInterval("2026-09-18T11:55:00.000Z", now), 60_000);
  assert.equal(adaptivePollingInterval("2026-09-18T11:40:00.000Z", now), 120_000);
  assert.equal(adaptivePollingInterval("2026-09-18T11:00:00.000Z", now), 300_000);
  assert.equal(adaptivePollingInterval("2026-09-18T09:00:00.000Z", now), 600_000);
  assert.equal(adaptivePollingInterval(null, now), 600_000);
});

test("keeps one pre-range baseline beyond the 30-day history window", () => {
  const now = Date.parse("2026-09-18T12:00:00.000Z");
  const history = normalizeUsageHistory([
    { ts: "2026-08-01T12:00:00.000Z", fiveHourUsed: 10 },
    { ts: "2026-09-18T11:00:00.000Z", fiveHourUsed: 20 }
  ], now);
  assert.equal(history.length, 2);
  assert.equal(history[0].fiveHourUsed, 10);
  assert.equal(history[1].fiveHourUsed, 20);
});
