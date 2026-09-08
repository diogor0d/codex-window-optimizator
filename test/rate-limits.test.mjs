import test from "node:test";
import assert from "node:assert/strict";

import { recordRateLimitsNotification, recordRateLimitsRead } from "../src/rate-limits.mjs";

const firstUpdate = "2026-09-04T12:00:00.000Z";
const secondUpdate = "2026-09-04T12:05:00.000Z";

test("records ordinary and Reserve snapshots from a full read", () => {
  const dashboard = recordRateLimitsRead({}, {
    ordinaryUsageAllowed: false,
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { id: "private-a", expiresAt: 2_000_000_000 },
        { id: "private-b", expiresAt: null }
      ]
    },
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 100, windowDurationMins: 300 }
    },
    rateLimitsByLimitId: {
      base_model_inference: {
        limitId: "base_model_inference",
        limitName: "gpt-reserve",
        primary: { usedPercent: 48, windowDurationMins: 10080 }
      }
    }
  }, firstUpdate);

  assert.equal(dashboard.ordinaryUsageAllowed, false);
  assert.deepEqual(dashboard.rateLimitResetCredits, {
    availableCount: 2,
    expiresAt: [2_000_000_000, null],
    detailsComplete: true,
    updatedAt: firstUpdate
  });
  assert.equal(dashboard.rateLimits.primary.updatedAt, firstUpdate);
  assert.equal(dashboard.rateLimitsByLimitId.base_model_inference.limitName, "gpt-reserve");
});

test("distinguishes omitted reset-credit expiration from explicit null", () => {
  const dashboard = recordRateLimitsRead({}, {
    rateLimits: { primary: { usedPercent: 10 } },
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [{ id: "private-a", expiresAt: null }, { id: "private-b" }]
    }
  }, firstUpdate);

  assert.deepEqual(dashboard.rateLimitResetCredits.expiresAt, [null, "unknown"]);
});

test("merges a sparse Reserve notification without replacing ordinary quota", () => {
  const dashboard = recordRateLimitsRead({}, {
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 20, resetsAt: 100, windowDurationMins: 300 }
    },
    rateLimitsByLimitId: {
      base_model_inference: {
        limitId: "base_model_inference",
        limitName: "gpt-reserve",
        primary: { usedPercent: 10, resetsAt: 200, windowDurationMins: 10080 }
      }
    }
  }, firstUpdate);

  const updated = recordRateLimitsNotification(dashboard, {
    limitId: "base_model_inference",
    limitName: "gpt-reserve",
    primary: { usedPercent: 15, resetsAt: null }
  }, secondUpdate);

  assert.equal(updated.rateLimits.primary.usedPercent, 20);
  assert.equal(updated.rateLimitsByLimitId.base_model_inference.primary.usedPercent, 15);
  assert.equal(updated.rateLimitsByLimitId.base_model_inference.primary.resetsAt, null);
  assert.equal(updated.ordinaryUsageAllowed, true);
});

test("sparse notifications do not make a reset-credit count look newly read", () => {
  const dashboard = recordRateLimitsRead({}, {
    rateLimits: { limitId: "codex", primary: { usedPercent: 20 } },
    rateLimitResetCredits: { availableCount: 3 }
  }, firstUpdate);

  const updated = recordRateLimitsNotification(dashboard, {
    limitId: "codex",
    primary: { usedPercent: 25 }
  }, secondUpdate);

  assert.deepEqual(updated.rateLimitResetCredits, {
    availableCount: 3,
    expiresAt: null,
    detailsComplete: false,
    updatedAt: firstUpdate
  });
});

test("sparse notifications preserve known reset-credit expirations", () => {
  const dashboard = recordRateLimitsRead({}, {
    rateLimits: { limitId: "codex", primary: { usedPercent: 20 } },
    rateLimitResetCredits: {
      availableCount: 1,
      credits: [{ id: "private", expiresAt: 2_000_000_000 }]
    }
  }, firstUpdate);

  const updated = recordRateLimitsNotification(dashboard, {
    limitId: "codex",
    primary: { usedPercent: 25 }
  }, secondUpdate);

  assert.deepEqual(updated.rateLimitResetCredits, {
    availableCount: 1,
    expiresAt: [2_000_000_000],
    detailsComplete: true,
    updatedAt: firstUpdate
  });
});

test("preserves omitted ordinary windows in sparse notifications", () => {
  const dashboard = recordRateLimitsRead({}, {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 20, windowDurationMins: 300 },
      secondary: { usedPercent: 50, windowDurationMins: 10080 },
      rateLimitReachedType: "rate_limit_reached"
    }
  }, firstUpdate);

  const updated = recordRateLimitsNotification(dashboard, {
    limitId: "codex",
    primary: { usedPercent: 25 },
    secondary: null,
    rateLimitReachedType: null
  }, secondUpdate);

  assert.equal(updated.rateLimits.primary.usedPercent, 25);
  assert.equal(updated.rateLimits.primary.windowDurationMins, 300);
  assert.equal(updated.rateLimits.secondary.usedPercent, 50);
  assert.equal(updated.rateLimits.rateLimitReachedType, "rate_limit_reached");
});

test("matches sparse notifications by exact limit ID before duplicate names", () => {
  const dashboard = {
    rateLimits: { limitId: "codex", primary: { usedPercent: 5 } },
    rateLimitsByLimitId: {
      first: { limitId: "first", limitName: "gpt-reserve", primary: { usedPercent: 10 } },
      second: { limitId: "second", limitName: "gpt-reserve", primary: { usedPercent: 20 } }
    }
  };

  const updated = recordRateLimitsNotification(dashboard, {
    limitId: "second",
    limitName: "gpt-reserve",
    primary: { usedPercent: 25 }
  }, secondUpdate);

  assert.equal(updated.rateLimitsByLimitId.first.primary.usedPercent, 10);
  assert.equal(updated.rateLimitsByLimitId.second.primary.usedPercent, 25);
});
