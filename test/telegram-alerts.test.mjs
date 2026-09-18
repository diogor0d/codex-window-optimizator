import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQuotaAlertEvents,
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

function dashboard({ used = 20, weekly = 30, reset = 2_000_000_000, ordinaryUsageAllowed = true } = {}) {
  return {
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
    dashboard({ ordinaryUsageAllowed: true }),
    dashboard({ ordinaryUsageAllowed: false }),
    settings
  );
  const recovered = buildQuotaAlertEvents(
    dashboard({ ordinaryUsageAllowed: false }),
    dashboard({ ordinaryUsageAllowed: true }),
    settings
  );

  assert.ok(active.some((event) => event.type === "reserve-active"));
  assert.ok(recovered.some((event) => event.type === "reserve-recovered"));
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

test("alerts when duplicate reset expirations enter the warning horizon", () => {
  const expiry = Math.floor(Date.parse("2026-09-09T09:30:00.000Z") / 1000);
  const previous = dashboard();
  previous.rateLimitResetCredits = {
    availableCount: 2,
    expiresAt: [expiry, expiry],
    updatedAt: "2026-09-08T09:00:00.000Z"
  };
  const current = dashboard();
  current.rateLimitResetCredits = {
    availableCount: 2,
    expiresAt: [expiry, expiry],
    updatedAt: "2026-09-08T10:00:00.000Z"
  };

  const events = buildQuotaAlertEvents(previous, current, settings, Date.parse(current.rateLimitResetCredits.updatedAt));
  const expiryEvent = events.find((event) => event.type === "reset-credit-expiry");
  assert.match(expiryEvent.text, /2 usage resets expire/);
});

test("alerts for a newly observed expiration already inside the horizon", () => {
  const expiry = Math.floor(Date.parse("2026-09-08T20:00:00.000Z") / 1000);
  const previous = dashboard();
  previous.rateLimitResetCredits = {
    availableCount: 1,
    expiresAt: [2_000_000_000],
    updatedAt: "2026-09-08T10:00:00.000Z"
  };
  const current = dashboard();
  current.rateLimitResetCredits = {
    availableCount: 1,
    expiresAt: [expiry],
    updatedAt: "2026-09-08T10:05:00.000Z"
  };

  const events = buildQuotaAlertEvents(previous, current, settings);
  assert.ok(events.some((event) => event.type === "reset-credit-expiry"));
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
