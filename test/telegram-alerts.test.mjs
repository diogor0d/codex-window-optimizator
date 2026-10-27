import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQuotaAlertEvents,
  buildResetReminderEvents,
  buildQuotaResetReminderEvents,
  recordQuotaResetReminder,
  telegramEventStillRelevant,
  pruneResetReminderState,
  recordResetReminder,
  resetReminderHours,
  validateResetReminderHours,
  formatTelegramAlert,
  formatTelegramAlertMessages,
  withoutTelegramCredentials
} from "../src/telegram-alerts.mjs";

const settings = {
  timezone: "Europe/Lisbon",
  telegramQuotaWarningPercent: 80,
  telegramAlertQuotaResets: true,
  telegramAlertReserve: true,
  telegramAlertResetCredits: true,
  telegramResetExpiryHours: 24
};

test("removes Telegram secrets from child-process environments", () => {
  assert.deepEqual(withoutTelegramCredentials({
    PATH: "bin",
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_CHAT_ID: "secret-chat"
  }), { PATH: "bin" });
});

function dashboard({ used = 20, weekly = 30, reset = 2_000_000_000, ordinaryUsageAllowed = true, reserve = false } = {}) {
  const value = {
    ordinaryUsageAllowed,
    rateLimits: {
      primary: { usedPercent: used, windowDurationMins: 300, resetsAt: reset },
      secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: reset + 1000 }
    },
    rateLimitResetCredits: {
      availableCount: 1,
      expiresAt: [reset + 10_000],
      updatedAt: "2026-09-08T10:00:00.000Z"
    }
  };
  if (reserve) {
    value.rateLimitsByLimitId = {
      reserve: {
        limitName: "gpt-reserve",
        primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: reset + 20_000 }
      }
    };
  }
  return value;
}

test("reports every quota threshold crossed between polls", () => {
  const events = buildQuotaAlertEvents(dashboard({ used: 70 }), dashboard({ used: 100 }), settings);

  const quotaEvents = events.filter((event) => event.type === "quota-threshold");
  assert.equal(quotaEvents.length, 3);
  assert.deepEqual(quotaEvents.map((event) => event.text), [
    "5-hour quota reached 0% free (crossed 20% free)",
    "5-hour quota reached 0% free (crossed 5% free)",
    "5-hour quota reached 0% free (crossed 0% free)"
  ]);
});

test("alerts when a quota window resets", () => {
  const events = buildQuotaAlertEvents(
    dashboard({ used: 90, reset: 2_000_000_000 }),
    dashboard({ used: 5, reset: 2_000_018_000 }),
    settings
  );

  assert.ok(events.some((event) => event.type === "quota-reset"
    && /5-hour quota reset to 95% free/.test(event.text)));
});

test("does not treat projected reset-time adjustments as quota resets", () => {
  const previous = dashboard({ used: 69, weekly: 26, reset: 2_000_000_000 });
  const current = dashboard({ used: 70, weekly: 26, reset: 2_000_000_030 });
  previous.rateLimitsByLimitId = {
    reserve: {
      limitName: "gpt-reserve",
      primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 2_000_000_000 }
    }
  };
  current.rateLimitsByLimitId = {
    reserve: {
      limitName: "gpt-reserve",
      primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 2_000_000_300 }
    }
  };

  const events = buildQuotaAlertEvents(previous, current, settings);
  assert.equal(events.some((event) => event.type === "quota-reset"), false);
});

test("recognizes a reset when a sparse update already lowered usage", () => {
  const previous = dashboard({ used: 2, reset: 2_000_000_000 });
  const current = dashboard({ used: 2, reset: 2_000_018_000 });

  const events = buildQuotaAlertEvents(previous, current, settings);
  assert.ok(events.some((event) => event.type === "quota-reset"));
});

test("alerts on Luna Reserve activation and recovery", () => {
  const active = buildQuotaAlertEvents(
    dashboard({ ordinaryUsageAllowed: true, reserve: true }),
    dashboard({ ordinaryUsageAllowed: false, reserve: true }),
    settings,
    1_900_000_000_000
  );
  const recovered = buildQuotaAlertEvents(
    dashboard({ ordinaryUsageAllowed: false, reserve: true }),
    dashboard({ ordinaryUsageAllowed: true, reserve: true }),
    settings,
    1_900_000_000_000
  );

  assert.ok(active.some((event) => event.type === "reserve-active"));
  assert.ok(recovered.some((event) => event.type === "reserve-recovered"));
});

test("does not infer Luna Reserve activation when no allowance is reported", () => {
  const events = buildQuotaAlertEvents(
    dashboard({ ordinaryUsageAllowed: true }),
    dashboard({ ordinaryUsageAllowed: false }),
    settings
  );

  assert.equal(events.some((event) => event.type === "reserve-active"), false);
});

test("does not report exhausted Reserve as active or missing Reserve as standby", () => {
  const exhausted = dashboard({ ordinaryUsageAllowed: false, reserve: true });
  exhausted.rateLimitsByLimitId.reserve.primary.usedPercent = 100;
  const active = buildQuotaAlertEvents(
    dashboard({ ordinaryUsageAllowed: true, reserve: true }),
    exhausted,
    settings,
    1_900_000_000_000
  );
  const recoveredWithoutReserve = buildQuotaAlertEvents(
    dashboard({ ordinaryUsageAllowed: false, reserve: true }),
    dashboard({ ordinaryUsageAllowed: true }),
    settings,
    1_900_000_000_000
  );

  assert.equal(active.some((event) => event.type === "reserve-active"), false);
  assert.equal(recoveredWithoutReserve.some((event) => event.type === "reserve-recovered"), false);
});

test("reports recovery when a Reserve allowance rolls into a new window", () => {
  const previous = dashboard({ ordinaryUsageAllowed: false, reserve: true });
  previous.rateLimitsByLimitId.reserve.primary.resetsAt = 1_899_999_999;
  const current = dashboard({ ordinaryUsageAllowed: true, reserve: true });

  const events = buildQuotaAlertEvents(previous, current, settings, 1_900_000_000_000);
  assert.ok(events.some((event) => event.type === "reserve-recovered"));
});

test("disables all Luna Reserve alerts with the Reserve category", () => {
  const previous = dashboard();
  previous.rateLimitsByLimitId = {
    reserve: { limitName: "gpt-reserve", primary: { usedPercent: 70, windowDurationMins: 10080 } }
  };
  const current = dashboard({ ordinaryUsageAllowed: false });
  current.rateLimitsByLimitId = {
    reserve: { limitName: "gpt-reserve", primary: { usedPercent: 100, windowDurationMins: 10080 } }
  };

  const events = buildQuotaAlertEvents(previous, current, { ...settings, telegramAlertReserve: false });
  assert.equal(events.some((event) => /Luna Reserve|Ordinary usage/.test(event.text)), false);
});

test("alerts on reset inventory changes and groups duplicate expirations", () => {
  const previous = dashboard();
  previous.rateLimitResetCredits = {
    availableCount: 1,
    expiresAt: [2_000_000_000],
    updatedAt: "2026-09-08T10:00:00.000Z"
  };
  const current = dashboard();
  current.rateLimitResetCredits = {
    availableCount: 3,
    expiresAt: [2_000_000_000, 2_000_000_000, 2_000_100_000],
    updatedAt: "2026-09-08T10:05:00.000Z"
  };

  const events = buildQuotaAlertEvents(previous, current, settings, Date.parse(current.rateLimitResetCredits.updatedAt));

  assert.ok(events.some((event) => event.type === "reset-credit-count" && /1 to 3/.test(event.text)));
});

const reminderNow = Date.parse("2026-10-27T10:00:00Z");
const reminderExpiry = reminderNow / 1000 + 3 * 86400;
const reminderSettings = { timezone: "Europe/Lisbon", telegramAlertResetCredits: true };
function creditDashboard(expirations = [reminderExpiry], count = expirations.length) {
  return { rateLimitResetCredits: { availableCount: count, expiresAt: expirations } };
}

test("reminder settings default to two days and migrate the legacy warning", () => {
  assert.deepEqual(resetReminderHours({}), [48]);
  assert.deepEqual(resetReminderHours({ telegramResetExpiryHours: 24 }), [24]);
  assert.deepEqual(resetReminderHours({ telegramResetReminderHours: [2, 48] }), [48, 2]);
  assert.deepEqual(resetReminderHours({ telegramResetReminderHours: [] }), []);
  for (const invalid of [null, "48", [0], [721], [1.5], [48, 48], Array.from({ length: 11 }, (_, i) => i + 1)]) {
    assert.equal(validateResetReminderHours(invalid), false);
  }
});

test("default reminder fires at exactly two days before expiry and only once", () => {
  const value = creditDashboard();
  const dueAt = reminderExpiry * 1000 - 48 * 3600_000;
  assert.deepEqual(buildResetReminderEvents(value, reminderSettings, {}, dueAt - 1), []);
  const [event] = buildResetReminderEvents(value, reminderSettings, {}, dueAt);
  assert.match(event.text, /1 unused usage reset expires/);
  assert.match(event.text, /2 days before expiry/);
  assert.match(event.text, /Europe\/Lisbon/);
  const sent = {};
  recordResetReminder(sent, event);
  const restarted = JSON.parse(JSON.stringify(sent));
  assert.deepEqual(buildResetReminderEvents(value, reminderSettings, restarted, dueAt + 60_000), []);
});

test("multiple reminders each fire once using wall clock even with unchanged credit readings", () => {
  const value = creditDashboard([reminderExpiry, reminderExpiry]);
  const settings = { ...reminderSettings, telegramResetReminderHours: [48, 24, 2] };
  const sent = {};
  for (const hours of [48, 24, 2]) {
    const now = reminderExpiry * 1000 - hours * 3600_000;
    const [event] = buildResetReminderEvents(value, settings, sent, now);
    assert.equal(event.hoursBefore, hours);
    assert.match(event.text, /2 unused usage resets expire/);
    recordResetReminder(sent, event);
    assert.deepEqual(buildResetReminderEvents(value, settings, sent, now), []);
  }
});

test("late discovery and downtime catch up with one most urgent overdue reminder", () => {
  const settings = { ...reminderSettings, telegramResetReminderHours: [48, 24, 2] };
  const now = reminderExpiry * 1000 - 3600_000;
  const [event, extra] = buildResetReminderEvents(creditDashboard(), settings, {}, now);
  assert.equal(event.hoursBefore, 2);
  assert.equal(extra, undefined);
  const sent = {};
  recordResetReminder(sent, event);
  assert.deepEqual(Object.values(sent), [1, 1, 1]);
  assert.deepEqual(buildResetReminderEvents(creditDashboard(), settings, sent, now + 60_000), []);
});

test("ignores consumed, expired, unknown and disabled credit reminders", () => {
  const dueAt = reminderExpiry * 1000 - 1000;
  for (const value of [creditDashboard([], 0), creditDashboard([null, "unknown"]), creditDashboard([reminderExpiry - 100], 0), { rateLimitResetCredits: null }]) {
    assert.deepEqual(buildResetReminderEvents(value, reminderSettings, {}, dueAt), []);
  }
  assert.deepEqual(buildResetReminderEvents(creditDashboard(), reminderSettings, {}, reminderExpiry * 1000), []);
  assert.deepEqual(buildResetReminderEvents(creditDashboard(), { ...reminderSettings, telegramAlertResetCredits: false }, {}, dueAt), []);
  assert.deepEqual(buildResetReminderEvents(creditDashboard(), { ...reminderSettings, telegramResetReminderHours: [] }, {}, dueAt), []);
});

test("groups equal expirations and alerts only newly observed credits sharing an expiry", () => {
  const now = reminderExpiry * 1000 - 24 * 3600_000;
  const [initial] = buildResetReminderEvents(creditDashboard(), reminderSettings, {}, now);
  const sent = {};
  recordResetReminder(sent, initial);
  const [added] = buildResetReminderEvents(creditDashboard([reminderExpiry, reminderExpiry]), reminderSettings, sent, now);
  assert.match(added.text, /1 unused usage reset expires/);
  recordResetReminder(sent, added);
  assert.deepEqual(buildResetReminderEvents(creditDashboard(), reminderSettings, sent, now), []);
  assert.deepEqual(buildResetReminderEvents(creditDashboard([reminderExpiry, reminderExpiry]), reminderSettings, sent, now), []);
});

test("keeps account receipts independently and prunes expired or malformed receipt keys", () => {
  const first = {};
  const second = {};
  const now = reminderExpiry * 1000 - 3600_000;
  const [event] = buildResetReminderEvents(creditDashboard(), reminderSettings, first, now);
  recordResetReminder(first, event);
  assert.equal(buildResetReminderEvents(creditDashboard(), reminderSettings, second, now).length, 1);
  const key = `${reminderExpiry}:48`;
  assert.deepEqual(pruneResetReminderState({ ...first, bad: 1, [`${reminderExpiry}:0`]: 1, "1:48": 1 }, now), { [key]: 1 });
  assert.deepEqual(pruneResetReminderState(first, reminderExpiry * 1000), {});
});

test("formats one compact Telegram message per account", () => {
  const text = formatTelegramAlert("CHATGPT1", [
    { type: "quota-threshold", text: "5-hour quota reached 80%" },
    { type: "reserve-active", text: "Luna Reserve fallback is active" }
  ]);

  assert.equal(text, "Codex Window Runner: CHATGPT1\n- 5-hour quota reached 80%\n- Luna Reserve fallback is active");
});

test("splits Telegram alerts below the message size limit", () => {
  const messages = formatTelegramAlertMessages("account", [
    { type: "one", text: "A".repeat(40) },
    { type: "two", text: "B".repeat(40) }
  ], 60);

  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.length <= 60));
});

test("custom quota thresholds replace the built-in 95/100 levels and watched windows are independent", () => {
  const events = buildQuotaAlertEvents(dashboard({ used: 10, weekly: 10 }), dashboard({ used: 100, weekly: 100 }), {
    ...settings, telegramQuotaWarningPercents: [40, 70], telegramQuotaWindows: ["weekly"]
  });
  const warnings = events.filter((event) => event.type === "quota-threshold");
  assert.deepEqual(warnings.map((event) => [event.windowKey, event.threshold]), [["weekly", 40], ["weekly", 70]]);
});

test("individual event rules can disable Reserve activation without disabling recovery or expiry", () => {
  const options = { ...settings, telegramAlertRules: { "reserve-active": [] } };
  assert.ok(!buildQuotaAlertEvents(dashboard({ reserve: true }), dashboard({ reserve: true, ordinaryUsageAllowed: false }), options, 1_900_000_000_000)
    .some((event) => event.type === "reserve-active"));
  assert.ok(buildQuotaAlertEvents(dashboard({ reserve: true, ordinaryUsageAllowed: false }), dashboard({ reserve: true }), options, 1_900_000_000_000)
    .some((event) => event.type === "reserve-recovered"));
});

test("quota pre-reset reminders support each window and ignore small projected-time changes", () => {
  const expiry = 2_000_000_000;
  const value = dashboard({ reset: expiry, reserve: true });
  value.rateLimits.secondary.resetsAt = expiry;
  value.rateLimitsByLimitId.reserve.primary.resetsAt = expiry;
  const options = { ...settings, telegramQuotaReminderHours: { "5h": [2, 1], weekly: [48, 24], reserve: [48] } };
  const sent = {};
  let events = buildQuotaResetReminderEvents(value, options, sent, (expiry - 3600) * 1000);
  assert.deepEqual(events.map((event) => [event.windowKey, event.hoursBefore]), [["5h", 1], ["weekly", 24], ["reserve", 48]]);
  for (const event of events) recordQuotaResetReminder(sent, event);
  value.rateLimits.primary.resetsAt += 30;
  assert.deepEqual(buildQuotaResetReminderEvents(value, options, JSON.parse(JSON.stringify(sent)), (expiry - 3500) * 1000), []);
  value.rateLimits.primary.resetsAt += 18_000;
  events = buildQuotaResetReminderEvents(value, options, sent, (expiry + 18_000 - 1800) * 1000);
  assert.equal(events[0].windowKey, "5h");
});

test("delayed event eligibility stops warnings after recovery, reset, or disabling a threshold", () => {
  const value = dashboard({ used: 90 });
  const event = { type: "quota-threshold", windowKey: "5h", threshold: 80, resetsAt: 2_000_000_000 };
  const now = 1_900_000_000_000;
  assert.equal(telegramEventStillRelevant(value, event, settings, {}, now), true);
  assert.equal(telegramEventStillRelevant(dashboard({ used: 10 }), event, settings, {}, now), false);
  assert.equal(telegramEventStillRelevant(dashboard({ used: 90, reset: 2_000_018_000 }), event, settings, {}, now), false);
  assert.equal(telegramEventStillRelevant(value, event, { ...settings, telegramQuotaWarningPercents: [90] }, {}, now), false);
  assert.equal(telegramEventStillRelevant(value, { type: "auth-failure" }, settings, { authIssue: false }, now), false);
  assert.equal(telegramEventStillRelevant(value, { type: "auth-failure" }, settings, { authIssue: true, intentionalLogout: true }, now), false);
  assert.equal(telegramEventStillRelevant(value, { type: "send-failure", observedAtMs: now }, settings, { latestSuccessfulRunAtMs: now + 1 }, now), false);
});
