import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUsageChartModel,
  nearestUsageTimestamp,
  nextUsageCursorIndex,
  usageChartTicks,
  usageChartValueAt,
  usageInsightStats
} from "../public/app.js";

const key = "fiveHourUsed";
const startMs = Date.parse("2026-10-01T00:00:00Z");
const ts = (minutes) => new Date(startMs + minutes * 60_000).toISOString();

function accountHistory(id, usedValues, observedAt = ts(120)) {
  return {
    account: { id, label: id.toUpperCase() },
    index: id.charCodeAt(0) - 97,
    data: {
      baseline: null,
      samples: usedValues.map(([minute, fiveHourUsed]) => ({ ts: ts(minute), fiveHourUsed })),
      observedAt: { fiveHourUsed: observedAt }
    }
  };
}

test("builds a shared timestamp cursor and returns each account's value at that time", () => {
  const model = buildUsageChartModel([
    accountHistory("a", [[10, 20], [30, 40]]),
    accountHistory("b", [[10, 60], [20, 70]])
  ], key, startMs, startMs + 120 * 60_000);

  assert.deepEqual(model.timestamps, [ts(10), ts(20), ts(30), ts(120)].map(Date.parse));
  const selected = model.timestamps[1];
  assert.equal(usageChartValueAt(model.series[0], key, selected).value, 80);
  assert.equal(usageChartValueAt(model.series[1], key, selected).value, 30);
});

test("retains each account when readings coincide at the shared timestamp", () => {
  const model = buildUsageChartModel([
    accountHistory("a", [[10, 20]]),
    accountHistory("b", [[10, 20]])
  ], key, startMs, startMs + 60 * 60_000);
  assert.equal(model.timestamps.length, 1);
  assert.equal(model.series.length, 2);
  assert.deepEqual(model.series.map((item) => usageChartValueAt(item, key, model.timestamps[0]).value), [80, 80]);
});

test("keeps missing metric observations as gaps and never carries values past observedAt", () => {
  const history = {
    account: { id: "a", label: "A" },
    index: 0,
    data: {
      samples: [
        { ts: ts(10), fiveHourUsed: 20 },
        { ts: ts(20), fiveHourUsed: null },
        { ts: ts(30), fiveHourUsed: 35 }
      ],
      observedAt: { fiveHourUsed: ts(30) }
    }
  };
  const model = buildUsageChartModel([history], key, startMs, startMs + 60 * 60_000);

  assert.equal(usageChartValueAt(model.series[0], key, Date.parse(ts(15))).value, 80);
  assert.equal(usageChartValueAt(model.series[0], key, Date.parse(ts(20))).status, "unavailable");
  assert.equal(usageChartValueAt(model.series[0], key, Date.parse(ts(25))).status, "unavailable");
  assert.deepEqual(usageChartValueAt(model.series[0], key, Date.parse(ts(31))), {
    value: null,
    status: "stale",
    sample: null
  });
});

test("keeps an untracked account in the cursor model as unavailable", () => {
  const model = buildUsageChartModel([
    accountHistory("a", [[10, 20]]),
    { account: { id: "b", label: "B" }, index: 1, data: { samples: [], observedAt: {} } }
  ], key, startMs, startMs + 60 * 60_000);

  assert.equal(model.series.length, 2);
  assert.equal(usageChartValueAt(model.series[1], key, model.timestamps[0]).status, "unavailable");
});

test("exposes in-range baseline and latest observation boundaries for a quiet history", () => {
  const history = {
    account: { id: "a", label: "A" },
    index: 0,
    data: {
      baseline: { ts: ts(-30), fiveHourUsed: 25 },
      samples: [],
      observedAt: { fiveHourUsed: ts(40) }
    }
  };
  const model = buildUsageChartModel([history], key, startMs, startMs + 60 * 60_000);
  assert.deepEqual(model.timestamps, [startMs, Date.parse(ts(40))]);
  assert.equal(usageChartValueAt(model.series[0], key, model.timestamps[0]).value, 75);
  assert.equal(usageChartValueAt(model.series[0], key, model.timestamps[1]).value, 75);
});

test("labels saved readings as cached while refusing values after their observation time", () => {
  const history = accountHistory("a", [[10, 20]], ts(10));
  history.data.savedSnapshot = true;
  const model = buildUsageChartModel([history], key, startMs, startMs + 60 * 60_000);
  assert.equal(usageChartValueAt(model.series[0], key, Date.parse(ts(10))).status, "cached");
  assert.equal(usageChartValueAt(model.series[0], key, Date.parse(ts(11))).value, null);
  assert.equal(usageChartValueAt(model.series[0], key, Date.parse(ts(11))).status, "stale");
});

test("chooses the nearest shared cursor timestamp and supports keyboard edge navigation", () => {
  const timeline = [10, 20, 30].map((minute) => startMs + minute * 60_000);
  assert.equal(nearestUsageTimestamp(timeline, startMs + 19 * 60_000), 1);
  assert.equal(nextUsageCursorIndex(1, "ArrowLeft", timeline.length), 0);
  assert.equal(nextUsageCursorIndex(1, "ArrowRight", timeline.length), 2);
  assert.equal(nextUsageCursorIndex(1, "Home", timeline.length), 0);
  assert.equal(nextUsageCursorIndex(1, "End", timeline.length), 2);
  assert.equal(nextUsageCursorIndex(1, "Tab", timeline.length), null);
});

test("uses responsive tick counts and date plus time labels for ranges over one day", () => {
  const endMs = startMs + 30 * 24 * 60 * 60_000;
  const narrow = usageChartTicks(startMs, endMs, 300, endMs - startMs);
  const wide = usageChartTicks(startMs, endMs, 900, endMs - startMs);
  assert.ok(narrow.length < wide.length);
  assert.notEqual(narrow[0].dateLabel, undefined);
  assert.notEqual(narrow[0].clockLabel, undefined);
  assert.equal(narrow[0].time, startMs);
  const exactDay = usageChartTicks(startMs, startMs + 24 * 60 * 60_000, 600, 24 * 60 * 60_000);
  assert.equal(exactDay[0].includeDate, true);
  assert.equal(narrow[0].includeDate, true);
});

test("supports cursor lookup across 5000 recorded observations", () => {
  const samples = Array.from({ length: 5000 }, (_, minute) => [minute, minute % 100]);
  const model = buildUsageChartModel([accountHistory("a", samples, ts(4999))], key, startMs, startMs + 6000 * 60_000);
  assert.equal(model.timestamps.length, 5000);
  assert.equal(model.series[0].samples.length, 5000);
  assert.equal(usageChartValueAt(model.series[0], key, model.timestamps.at(-1)).value, 1);
});

test("summarizes consumption and replenishment without inventing exact reset timing", () => {
  const model = buildUsageChartModel([
    accountHistory("a", [[10, 20], [20, 40], [30, 0], [40, 10]])
  ], key, startMs, startMs + 60 * 60_000);
  const insight = usageInsightStats(model.series, key, startMs, startMs + 60 * 60_000)[0];
  assert.match(insight.summary, /90% latest · low 60% · \+10 pts net/);
  assert.equal(insight.consumptionPoints, 30);
  assert.equal(insight.fullReplenishments, 1);
  assert.equal(insight.partialReplenishments, 0);
  assert.doesNotMatch(insight.summary, /reset at|reset time/);
});

test("does not count consumption across an unavailable gap", () => {
  const history = {
    account: { id: "a", label: "A" },
    index: 0,
    data: {
      samples: [
        { ts: ts(10), fiveHourUsed: 20 },
        { ts: ts(20), fiveHourUsed: null },
        { ts: ts(30), fiveHourUsed: 50 }
      ],
      observedAt: { fiveHourUsed: ts(30) }
    }
  };
  const model = buildUsageChartModel([history], key, startMs, startMs + 60 * 60_000);
  assert.equal(usageInsightStats(model.series, key, startMs, startMs + 60 * 60_000)[0].consumptionPoints, 0);
});


test("includes the range-start baseline in consumption and quiet-range insights", () => {
  const history = accountHistory("a", [[-10, 20], [10, 40]], ts(50));
  const model = buildUsageChartModel([history], key, startMs, Date.parse(ts(60)));
  const insight = usageInsightStats(model.series, key, startMs, Date.parse(ts(60)))[0];
  assert.equal(insight.consumptionPoints, 20);
  assert.match(insight.summary, /low 60%/);

  history.data.samples.pop();
  const quiet = buildUsageChartModel([history], key, startMs, Date.parse(ts(60)));
  const quietInsight = usageInsightStats(quiet.series, key, startMs, Date.parse(ts(60)))[0];
  assert.equal(quietInsight.consumptionPoints, 0);
  assert.match(quietInsight.summary, /80% latest/);
});
