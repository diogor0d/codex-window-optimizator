import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTelegramSettings, patchTelegramSettings, TELEGRAM_EVENT_TYPES, TELEGRAM_QUOTA_WINDOWS } from "../src/telegram-policy.mjs";

test("exports policy enums and normalizes defaults and legacy threshold", () => {
  assert.deepEqual(TELEGRAM_EVENT_TYPES, ["quota-threshold", "quota-reset", "reserve-active", "reserve-recovered", "reset-credit-count", "auth-failure", "send-failure"]);
  assert.deepEqual(TELEGRAM_QUOTA_WINDOWS, ["5h", "weekly", "reserve"]);
  const result = normalizeTelegramSettings({ telegramQuotaWarningPercent: 70 });
  assert.deepEqual(result.telegramQuotaWarningPercents, [70, 95, 100]);
  assert.deepEqual(result.telegramQuotaWindows, TELEGRAM_QUOTA_WINDOWS);
  assert.deepEqual(result.telegramAlertRules["quota-threshold"], [0]);
  assert.deepEqual(result.telegramQuotaReminderHours, { "5h": [], weekly: [], reserve: [] });
  assert.equal(result.telegramAlertResetExpiry, true);
  assert.deepEqual(result.telegramResetReminderHours, [48]);
});

test("normalization honors old disable flags, migrates reset expiry, and repairs invalid saved fields", () => {
  const result = normalizeTelegramSettings({ telegramAlertQuotaResets: false, telegramAlertReserve: false,
    telegramAlertResetCredits: false, telegramAlertFailures: false, telegramResetExpiryHours: 24,
    telegramAlertRules: { "quota-threshold": [10, 10], "quota-reset": [5, 3], bogus: [1] },
    telegramQuotaWarningPercents: [0], telegramQuotaReminderHours: { "5h": [2, 2], strange: [3] } });
  assert.deepEqual(result.telegramAlertRules["quota-threshold"], [0]);
  assert.deepEqual(result.telegramAlertRules["quota-reset"], [3, 5]);
  assert.deepEqual(result.telegramAlertRules["reserve-active"], []);
  assert.deepEqual(result.telegramAlertRules["reset-credit-count"], []);
  assert.deepEqual(result.telegramAlertRules["auth-failure"], []);
  assert.deepEqual(result.telegramQuotaWindows, ["5h", "weekly"]);
  assert.deepEqual(result.telegramQuotaWarningPercents, [80, 95, 100]);
  assert.deepEqual(result.telegramQuotaReminderHours, { "5h": [], weekly: [], reserve: [] });
  assert.equal(result.telegramAlertResetExpiry, false);
  assert.deepEqual(result.telegramResetReminderHours, [24]);
  assert.equal(Object.hasOwn(result, "telegramResetExpiryHours"), false);
});

test("canonical PATCH partially updates object fields and preserves unspecified entries", () => {
  const current = normalizeTelegramSettings();
  const next = patchTelegramSettings(current, { telegramAlertRules: { "quota-threshold": [25, 50] },
    telegramQuotaReminderHours: { weekly: [24, 3] }, telegramQuotaWarningPercents: [] });
  assert.deepEqual(next.telegramAlertRules["quota-threshold"], [25, 50]);
  assert.deepEqual(next.telegramAlertRules["quota-reset"], [0]);
  assert.deepEqual(next.telegramQuotaReminderHours, { "5h": [], weekly: [24, 3], reserve: [] });
  assert.deepEqual(next.telegramQuotaWarningPercents, []);
  assert.deepEqual(current.telegramQuotaWarningPercents, [80, 95, 100]);
});

test("legacy PATCH fields map only when canonical fields are absent", () => {
  const next = patchTelegramSettings({}, { telegramAlertReserve: false, telegramAlertResetCredits: false,
    telegramAlertFailures: false, telegramQuotaWarningPercent: 70, telegramResetExpiryHours: 12,
    telegramAlertRules: { "quota-reset": [10], "reset-credit-count": [5] }, telegramAlertResetExpiry: true });
  assert.deepEqual(next.telegramAlertRules["quota-reset"], [10]);
  assert.deepEqual(next.telegramAlertRules["reset-credit-count"], [5]);
  assert.deepEqual(next.telegramAlertRules["reserve-active"], []);
  assert.deepEqual(next.telegramAlertRules["auth-failure"], []);
  assert.deepEqual(next.telegramQuotaWindows, ["5h", "weekly"]);
  assert.deepEqual(next.telegramQuotaWarningPercents, [70, 95, 100]);
  assert.deepEqual(next.telegramResetReminderHours, [12]);
  assert.equal(next.telegramAlertResetExpiry, true);
});

test("hour reminders sort descending while event minutes and percentages remain ascending", () => {
  const normalized = normalizeTelegramSettings({ telegramResetReminderHours: [2, 48, 24],
    telegramQuotaReminderHours: { weekly: [2, 48, 24] },
    telegramAlertRules: { "quota-threshold": [60, 10], "quota-reset": [40, 5] },
    telegramQuotaWarningPercents: [95, 20] });
  assert.deepEqual(normalized.telegramResetReminderHours, [48, 24, 2]);
  assert.deepEqual(normalized.telegramQuotaReminderHours.weekly, [48, 24, 2]);
  assert.deepEqual(normalized.telegramAlertRules["quota-threshold"], [10, 60]);
  assert.deepEqual(normalized.telegramQuotaWarningPercents, [20, 95]);
  const patched = patchTelegramSettings({}, { telegramResetReminderHours: [2, 48, 24],
    telegramQuotaReminderHours: { weekly: [2, 48, 24] } });
  assert.deepEqual(patched.telegramResetReminderHours, [48, 24, 2]);
  assert.deepEqual(patched.telegramQuotaReminderHours.weekly, [48, 24, 2]);
});

test("legacy reserve alert PATCH toggles the watched reserve window unless canonical windows are supplied", () => {
  const withoutReserve = patchTelegramSettings({}, { telegramAlertReserve: false });
  assert.deepEqual(withoutReserve.telegramQuotaWindows, ["5h", "weekly"]);
  const restored = patchTelegramSettings(withoutReserve, { telegramAlertReserve: true });
  assert.deepEqual(restored.telegramQuotaWindows, TELEGRAM_QUOTA_WINDOWS);
  const explicit = patchTelegramSettings(withoutReserve, { telegramAlertReserve: true, telegramQuotaWindows: ["5h"] });
  assert.deepEqual(explicit.telegramQuotaWindows, ["5h"]);
});

test("PATCH rejects malformed, null, duplicate, out-of-range, oversized, and unknown values with 400", () => {
  const invalid = [
    { telegramAlertRules: null }, { telegramAlertRules: { unknown: [1] } },
    { telegramAlertRules: { "quota-reset": null } }, { telegramAlertRules: { "quota-reset": [1, 1] } },
    { telegramAlertRules: { "quota-reset": [-1] } }, { telegramAlertRules: { "quota-reset": Array(11).fill(1).map((_, i) => i) } },
    { telegramQuotaWarningPercents: null }, { telegramQuotaWarningPercents: [101] }, { telegramQuotaWarningPercents: [1, 1] },
    { telegramQuotaWindows: ["5h", "5h"] }, { telegramQuotaWindows: ["monthly"] }, { telegramQuotaWindows: null },
    { telegramQuotaReminderHours: { nope: [] } }, { telegramQuotaReminderHours: { weekly: null } },
    { telegramQuotaReminderHours: { reserve: [721] } }, { telegramAlertResetExpiry: null },
    { telegramResetReminderHours: null }, { telegramResetReminderHours: [24, 24] },
    { telegramAlertReserve: null }, { telegramQuotaWarningPercent: 0 }, { telegramResetExpiryHours: 721 }
  ];
  for (const body of invalid) assert.throws(() => patchTelegramSettings({}, body), (error) => error.statusCode === 400, JSON.stringify(body));
});

test("normalization and PATCH do not mutate their inputs", () => {
  const saved = { telegramAlertRules: { "quota-reset": [30, 10] }, telegramQuotaReminderHours: { weekly: [12, 4] } };
  const before = structuredClone(saved);
  normalizeTelegramSettings(saved);
  patchTelegramSettings(saved, { telegramAlertRules: { "quota-reset": [5] } });
  assert.deepEqual(saved, before);
});
