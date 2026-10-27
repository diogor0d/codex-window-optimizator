import test from "node:test";
import assert from "node:assert/strict";

import { accountResetCredits, accountWindow, effectiveWindow, reserveState, resetCreditExpiry, resetCreditPresentation, resetCreditItems, resetCreditCapacity, resetIsSoon, snapshotDashboard, usageFree, usageObservationAt } from "../public/app.js";

test("reset stacks preserve readable card width and cap the visible document count", () => {
  for (const edge of [24, 44]) {
    for (const width of [120, 160, 190, 284, 342, 600, 1600]) {
      const count = resetCreditCapacity(width, edge);
      assert.ok(count >= 1 && count <= 4);
      assert.ok(width - (count - 1) * edge >= Math.min(width, 160));
    }
  }
  assert.equal(resetCreditCapacity(190, 24), 2);
  assert.equal(resetCreditCapacity(284, 44), 3);
});

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

test("weekly exhaustion forces five-hour history remaining to zero", () => {
  assert.equal(usageFree({ fiveHourUsed: 25, weeklyUsed: 100 }, "fiveHourUsed"), 0);
  assert.equal(usageFree({ fiveHourUsed: 25, weeklyUsed: 99 }, "fiveHourUsed"), 75);
});

test("weekly observations extend the derived five-hour history line", () => {
  const observedAt = {
    fiveHourUsed: "2026-09-20T10:00:00.000Z",
    weeklyUsed: "2026-09-20T10:05:00.000Z"
  };
  assert.equal(usageObservationAt({ observedAt }, "fiveHourUsed"), observedAt.weeklyUsed);
  assert.equal(usageObservationAt({ observedAt }, "weeklyUsed"), observedAt.weeklyUsed);
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

test("uses the freshest Reserve snapshot when names are duplicated", () => {
  const win = accountWindow({
    dashboard: {
      rateLimits: {},
      rateLimitsByLimitId: {
        stale: {
          limitName: "gpt-reserve",
          updatedAt: "2026-09-08T10:00:00.000Z",
          primary: { usedPercent: 90, resetsAt: 2_100_000_000, windowDurationMins: 10080 }
        },
        current: {
          limitName: "gpt-reserve",
          updatedAt: "2026-09-08T10:05:00.000Z",
          primary: { usedPercent: 25, resetsAt: 2_200_000_000, windowDurationMins: 10080 }
        }
      }
    }
  });

  assert.equal(win.reserve.weekly.free, 75);
  assert.equal(win.reserve.weekly.resetsAt, 2_200_000_000);
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

test("marks resets soon only when strictly future and less than one hour away", () => {
  const now = 1_900_000_000_000;

  assert.equal(resetIsSoon(now + 1, now), true);
  assert.equal(resetIsSoon(now + 60 * 60 * 1000 - 1, now), true);
  assert.equal(resetIsSoon(now + 60 * 60 * 1000, now), false);
  assert.equal(resetIsSoon(now, now), false);
  assert.equal(resetIsSoon(now - 1, now), false);
  assert.equal(resetIsSoon(null, now), false);
});

test("reset-credit presentation marks only future expirations within two days", () => {
  const now = 1_900_000_000_000;
  const seconds = Math.floor(now / 1000);
  const base = { resetCreditsAvailable: 3, resetCreditDetailsComplete: true };

  assert.deepEqual(resetCreditPresentation({ ...base, resetCreditExpirations: [seconds + 2 * 24 * 60 * 60, null, seconds + 10 * 24 * 60 * 60] }, now), {
    count: 3,
    state: "expiring",
    expiringCount: 1,
    expiredCount: 0,
    nextExpiry: seconds + 2 * 24 * 60 * 60
  });
  assert.equal(resetCreditPresentation({ ...base, resetCreditExpirations: [seconds + 2 * 24 * 60 * 60 + 1] }, now).state, "available");
  assert.equal(resetCreditPresentation({ ...base, resetCreditExpirations: [null] }, now).state, "available");
});

test("reset-credit presentation reports expired credits without changing the authoritative count", () => {
  const now = 1_900_000_000_000;
  const seconds = Math.floor(now / 1000);
  const presentation = resetCreditPresentation({
    resetCreditsAvailable: 4,
    resetCreditExpirations: [seconds - 1, seconds, seconds + 10 * 24 * 60 * 60, null, seconds + 20 * 24 * 60 * 60],
    resetCreditDetailsComplete: true
  }, now);

  assert.equal(presentation.count, 4);
  assert.equal(presentation.state, "reported");
  assert.equal(presentation.expiringCount, 0);
  assert.equal(presentation.expiredCount, 2);
  assert.equal(presentation.nextExpiry, seconds + 10 * 24 * 60 * 60);
});

test("reset-credit presentation preserves known inventory when expiry details are missing", () => {
  const now = 1_900_000_000_000;

  assert.deepEqual(resetCreditPresentation({ resetCreditsAvailable: 2, resetCreditExpirations: [], resetCreditDetailsComplete: false }, now), {
    count: 2,
    state: "available",
    expiringCount: 0,
    expiredCount: 0,
    nextExpiry: null
  });
  assert.deepEqual(resetCreditPresentation({ resetCreditsAvailable: 0, resetCreditExpirations: [], resetCreditDetailsComplete: true }, now), {
    count: 0,
    state: "empty",
    expiringCount: 0,
    expiredCount: 0,
    nextExpiry: null
  });
  assert.equal(resetCreditPresentation({ resetCreditsAvailable: null, resetCreditExpirations: [] }, now).state, "unknown");
});


test("keeps each reported reset credit and its individual expiry state", () => {
  const now = 1_900_000_000_000;
  const seconds = now / 1000;
  const credits = { resetCreditsAvailable: 5,
    resetCreditExpirations: [seconds - 1, seconds + 2 * 86400, seconds + 2 * 86400 + 1, null, "unknown"] };
  assert.deepEqual(resetCreditItems(credits, now), [
    { index: 0, expiresAt: seconds - 1, state: "reported" },
    { index: 1, expiresAt: seconds + 2 * 86400, state: "expiring" },
    { index: 2, expiresAt: seconds + 2 * 86400 + 1, state: "available" },
    { index: 3, expiresAt: null, state: "available" },
    { index: 4, expiresAt: "unknown", state: "available" }
  ]);
  assert.equal(resetCreditItems(credits, now + 2 * 86400 * 1000)[1].state, "reported");
  assert.equal(resetCreditItems(credits, now + 2 * 86400 * 1000).length, 5);
});

test("individual credit cards follow the authoritative count without inventing missing dates", () => {
  const now = 1_900_000_000_000;
  assert.deepEqual(resetCreditItems({ resetCreditsAvailable: 2, resetCreditExpirations: [] }, now), [
    { index: 0, expiresAt: "unknown", state: "available" },
    { index: 1, expiresAt: "unknown", state: "available" }
  ]);
  assert.equal(resetCreditItems({ resetCreditsAvailable: 1, resetCreditExpirations: [null, null] }, now).length, 1);
  assert.deepEqual(resetCreditItems({ resetCreditsAvailable: 0 }, now), []);
  assert.deepEqual(resetCreditItems({ resetCreditsAvailable: null }, now), []);
});
