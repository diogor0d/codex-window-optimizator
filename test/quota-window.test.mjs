import test from "node:test";
import assert from "node:assert/strict";

import { accountResetCredits, accountWindow, effectiveWindow, reserveState, resetCreditExpiry, snapshotDashboard } from "../public/app.js";

const future = 2_000_000_000;

function windowFor(primaryUsed, secondaryUsed, rateLimitReachedType = null) {
  return accountWindow({
    dashboard: {
      rateLimits: {
        primary: { usedPercent: primaryUsed, resetsAt: future - 1000, windowDurationMins: 300 },
        secondary: { usedPercent: secondaryUsed, resetsAt: future, windowDurationMins: 10080 },
        rateLimitReachedType
      }
    }
  });
}

test("weekly exhaustion forces five-hour usable quota to zero", () => {
  const effective = effectiveWindow(windowFor(0, 100), 1_900_000_000_000);

  assert.equal(effective.used, 100);
  assert.equal(effective.free, 0);
  assert.equal(effective.windowDurationMins, 10080);
});

test("keeps partly consumed weekly quota separate from the five-hour window", () => {
  const effective = effectiveWindow(windowFor(0, 89), 1_900_000_000_000);

  assert.equal(effective.used, 0);
  assert.equal(effective.free, 100);
  assert.equal(effective.windowDurationMins, 300);
});

test("an explicit rate-limit state always reports no usable quota", () => {
  const effective = effectiveWindow(windowFor(0, 25, "rate_limit_reached"), 1_900_000_000_000);

  assert.equal(effective.used, 100);
  assert.equal(effective.free, 0);
});

test("authoritative ordinary usage state activates Reserve without replacing its quota", () => {
  const win = accountWindow({
    dashboard: {
      ordinaryUsageAllowed: false,
      rateLimits: {
        primary: { usedPercent: 25, resetsAt: future, windowDurationMins: 300 }
      },
      rateLimitsByLimitId: {
        base_model_inference: {
          limitName: "gpt-reserve",
          normalModelSlug: "gpt-5.6-luna",
          primary: { usedPercent: 40, windowDurationMins: 10080 }
        }
      }
    }
  });

  assert.equal(effectiveWindow(win).free, 0);
  assert.equal(win.reserve.weekly.free, 60);
  assert.equal(reserveState(win), "active");
});

test("finds the Reserve weekly allowance in either window", () => {
  const win = accountWindow({
    dashboard: {
      ordinaryUsageAllowed: true,
      rateLimits: {
        primary: { usedPercent: 10, resetsAt: future, windowDurationMins: 300 }
      },
      rateLimitsByLimitId: {
        inference: {
          limitName: "gpt-reserve",
          primary: { usedPercent: 30, windowDurationMins: 300 },
          secondary: { usedPercent: 80, windowDurationMins: 10080 }
        }
      }
    }
  });

  assert.equal(win.reserve.weekly.free, 20);
  assert.equal(reserveState(win), "standby");
});

test("does not infer Reserve activation when backend permission is unavailable", () => {
  const win = accountWindow({
    dashboard: {
      rateLimits: {
        primary: { usedPercent: 100, resetsAt: future, windowDurationMins: 300 }
      },
      rateLimitsByLimitId: {
        inference: {
          limitName: "gpt-reserve",
          primary: { usedPercent: 0, windowDurationMins: 10080 }
        }
      }
    }
  });

  assert.equal(reserveState(win), "available");
});

test("selects ordinary windows by duration when their order is reversed", () => {
  const win = accountWindow({
    dashboard: {
      rateLimits: {
        primary: { usedPercent: 70, resetsAt: future, windowDurationMins: 10080 },
        secondary: { usedPercent: 15, resetsAt: future, windowDurationMins: 300 }
      }
    }
  });

  assert.equal(win.primary.used, 15);
  assert.equal(win.secondary.used, 70);
  assert.equal(effectiveWindow(win).free, 85);
});

test("preserves Reserve and reset-credit state in privacy-reduced snapshots", () => {
  const dashboard = snapshotDashboard({
    ordinaryUsageAllowed: false,
    rateLimits: { primary: { usedPercent: 100, secret: "omit" }, credits: { balance: "omit" } },
    rateLimitsByLimitId: {
      inference: { limitName: "gpt-reserve", primary: { usedPercent: 20, windowDurationMins: 10080, secret: "omit" }, unknown: "omit" }
    },
    rateLimitResetCredits: {
      availableCount: 2,
      expiresAt: [2_000_000_000, null],
      detailsComplete: true,
      updatedAt: "2026-09-05T10:00:00.000Z",
      credits: [{ id: "sensitive-detail" }]
    }
  });

  assert.equal(dashboard.ordinaryUsageAllowed, false);
  assert.equal(dashboard.rateLimitsByLimitId.inference.limitName, "gpt-reserve");
  assert.equal(dashboard.rateLimits.credits, undefined);
  assert.equal(dashboard.rateLimits.primary.secret, undefined);
  assert.equal(dashboard.rateLimitsByLimitId.inference.unknown, undefined);
  assert.equal(dashboard.rateLimitsByLimitId.inference.primary.secret, undefined);
  assert.deepEqual(dashboard.rateLimitResetCredits, {
    availableCount: 2,
    expiresAt: [2_000_000_000, null],
    detailsComplete: true,
    updatedAt: "2026-09-05T10:00:00.000Z"
  });
});

test("reports every known usage-reset expiration and missing detail", () => {
  const win = accountWindow({ dashboard: {
    rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } },
    rateLimitResetCredits: {
      availableCount: 3,
      expiresAt: [2_100_000_000, 2_000_000_000],
      detailsComplete: false
    }
  } });

  assert.deepEqual(win.resetCreditExpirations, [2_000_000_000, 2_100_000_000]);
  const label = resetCreditExpiry(win).label;
  assert.match(label, new RegExp(new Date(2_000_000_000 * 1000).getFullYear()));
  assert.match(label, new RegExp(new Date(2_100_000_000 * 1000).getFullYear()));
  assert.match(label, /1 expiration not reported/);
});

test("distinguishes non-expiring reset credits from missing details", () => {
  const base = { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } };
  const nonExpiring = accountWindow({ dashboard: {
    ...base,
    rateLimitResetCredits: { availableCount: 1, expiresAt: [null], detailsComplete: true }
  } });
  const unknown = accountWindow({ dashboard: {
    ...base,
    rateLimitResetCredits: { availableCount: 1, expiresAt: null, detailsComplete: false }
  } });

  assert.equal(resetCreditExpiry(nonExpiring).label, "No expiration");
  assert.equal(resetCreditExpiry(unknown).label, "Not reported");
});

test("reads reset-credit expiration independently of ordinary quota", () => {
  const resetCredits = accountResetCredits({ dashboard: {
    rateLimitResetCredits: {
      availableCount: 1,
      expiresAt: [2_000_000_000],
      detailsComplete: true,
      updatedAt: "2026-09-05T10:00:00.000Z"
    }
  } });

  assert.equal(resetCredits.resetCreditsAvailable, 1);
  assert.deepEqual(resetCredits.resetCreditExpirations, [2_000_000_000]);
  assert.equal(resetCreditExpiry(resetCredits).label, formatExpectedExpiry(2_000_000_000));
});

function formatExpectedExpiry(seconds) {
  return new Date(seconds * 1000).toLocaleString();
}

test("keeps all reset-credit rows including non-expiring credits", () => {
  const resetCredits = accountResetCredits({ dashboard: {
    rateLimitResetCredits: {
      availableCount: 3,
      expiresAt: [2_100_000_000, null, 2_000_000_000],
      detailsComplete: true
    }
  } });

  assert.deepEqual(resetCredits.resetCreditExpirations, [2_000_000_000, 2_100_000_000, null]);
  assert.match(resetCreditExpiry(resetCredits).label, /No expiration/);
});

test("distinguishes an omitted credit expiration from no expiration", () => {
  const dashboard = recordDashboardWithCredits([
    { expiresAt: null },
    {}
  ]);

  assert.deepEqual(dashboard.resetCreditExpirations, [null, "unknown"]);
  assert.match(resetCreditExpiry(dashboard).label, /No expiration/);
  assert.match(resetCreditExpiry(dashboard).label, /Expiration not reported/);
});

function recordDashboardWithCredits(credits) {
  return accountResetCredits({ dashboard: {
    rateLimitResetCredits: {
      availableCount: credits.length,
      expiresAt: credits.map((credit) => Object.hasOwn(credit, "expiresAt") ? credit.expiresAt : "unknown"),
      detailsComplete: true
    }
  } });
}

test("exposes the Luna Reserve weekly reset independently", () => {
  const win = accountWindow({ dashboard: {
    rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } },
    rateLimitsByLimitId: {
      inference: {
        limitName: "gpt-reserve",
        normalModelSlug: "gpt-5.6-luna",
        primary: { usedPercent: 2, resetsAt: 2_200_000_000, windowDurationMins: 10080 }
      }
    }
  } });

  assert.equal(win.reserve.weekly.resetsAt, 2_200_000_000);
  assert.equal(win.reserve.model, "gpt-5.6-luna");
});

test("does not coerce a nullable Luna Reserve reset to the Unix epoch", () => {
  const win = accountWindow({ dashboard: {
    rateLimitsByLimitId: {
      inference: {
        limitName: "gpt-reserve",
        primary: { usedPercent: 2, resetsAt: null, windowDurationMins: 10080 }
      }
    }
  } });

  assert.equal(win.reserve.weekly.resetsAt, null);
  assert.equal(reserveState(win), "available");
});

test("keeps Reserve visible without an ordinary quota snapshot", () => {
  const win = accountWindow({ dashboard: {
    rateLimitsByLimitId: {
      inference: {
        limitName: "gpt-reserve",
        updatedAt: "2026-09-08T10:00:00.000Z",
        primary: { usedPercent: 2, resetsAt: 2_200_000_000, windowDurationMins: 10080 }
      }
    }
  } });

  assert.equal(win.primary, null);
  assert.equal(win.reserve.weekly.free, 98);
  assert.equal(win.updatedAt, "2026-09-08T10:00:00.000Z");
});

test("does not mislabel missing or single weekly ordinary windows", () => {
  const shortOnly = accountWindow({ dashboard: { rateLimits: {
    primary: { usedPercent: 10, windowDurationMins: 300 }
  } } });
  const weeklyOnly = accountWindow({ dashboard: { rateLimits: {
    primary: { usedPercent: 20, windowDurationMins: 10080 }
  } } });

  assert.equal(shortOnly.secondary, null);
  assert.equal(weeklyOnly.primary, null);
  assert.equal(weeklyOnly.secondary.windowDurationMins, 10080);
  assert.equal(effectiveWindow(weeklyOnly).free, 80);
});

test("does not report expired Reserve data as available", () => {
  const win = accountWindow({ dashboard: {
    ordinaryUsageAllowed: false,
    rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 } },
    rateLimitsByLimitId: {
      inference: {
        limitName: "gpt-reserve",
        primary: { usedPercent: 20, resetsAt: 100, windowDurationMins: 10080 }
      }
    }
  } });

  assert.equal(reserveState(win, 200_000), "stale");
});
