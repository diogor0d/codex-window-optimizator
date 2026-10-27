export const TELEGRAM_EVENT_TYPES = [
  "quota-threshold", "quota-reset", "reserve-active", "reserve-recovered",
  "reset-credit-count", "auth-failure", "send-failure"
];

export const TELEGRAM_QUOTA_WINDOWS = ["5h", "weekly", "reserve"];

const clone = (value) => Array.isArray(value) ? value.map(clone)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]))
    : value;
const validIntegerArray = (value, min, max) => Array.isArray(value) && value.length <= 10
  && value.every((n) => Number.isInteger(n) && n >= min && n <= max)
  && new Set(value).size === value.length;
const validHourArray = (value) => validIntegerArray(value, 1, 720);
const sorted = (values) => [...values].sort((a, b) => a - b);
const sortedHours = (values) => [...values].sort((a, b) => b - a);

function fallbackRules(settings) {
  const rules = Object.fromEntries(TELEGRAM_EVENT_TYPES.map((type) => [type, [0]]));
  if (settings.telegramAlertQuotaResets === false) rules["quota-reset"] = [];
  if (settings.telegramAlertReserve === false) rules["reserve-active"] = rules["reserve-recovered"] = [];
  if (settings.telegramAlertResetCredits === false) rules["reset-credit-count"] = [];
  if (settings.telegramAlertFailures === false) rules["auth-failure"] = rules["send-failure"] = [];
  return rules;
}

export function normalizeTelegramSettings(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const result = clone(source);
  const defaultRules = fallbackRules(source);
  const rules = {};
  const savedRules = source.telegramAlertRules && typeof source.telegramAlertRules === "object" && !Array.isArray(source.telegramAlertRules)
    ? source.telegramAlertRules : {};
  for (const type of TELEGRAM_EVENT_TYPES) {
    const candidate = savedRules[type];
    rules[type] = validIntegerArray(candidate, 0, 10080) ? sorted(candidate) : defaultRules[type];
  }
  result.telegramAlertRules = rules;

  const legacyThreshold = Number.isInteger(source.telegramQuotaWarningPercent) && source.telegramQuotaWarningPercent >= 1 && source.telegramQuotaWarningPercent <= 100
    ? source.telegramQuotaWarningPercent : 80;
  const warningCandidate = source.telegramQuotaWarningPercents;
  result.telegramQuotaWarningPercents = validIntegerArray(warningCandidate, 1, 100)
    ? sorted(warningCandidate) : sorted([...new Set([legacyThreshold, 95, 100])]);

  const windows = source.telegramQuotaWindows;
  result.telegramQuotaWindows = Array.isArray(windows) && windows.length <= TELEGRAM_QUOTA_WINDOWS.length
    && windows.every((item) => TELEGRAM_QUOTA_WINDOWS.includes(item)) && new Set(windows).size === windows.length
    ? TELEGRAM_QUOTA_WINDOWS.filter((item) => windows.includes(item))
    : TELEGRAM_QUOTA_WINDOWS.filter((item) => item !== "reserve" || source.telegramAlertReserve !== false);

  const reminderDefaults = { "5h": [], weekly: [], reserve: [] };
  const savedReminders = source.telegramQuotaReminderHours && typeof source.telegramQuotaReminderHours === "object" && !Array.isArray(source.telegramQuotaReminderHours)
    ? source.telegramQuotaReminderHours : {};
  result.telegramQuotaReminderHours = Object.fromEntries(Object.keys(reminderDefaults).map((key) => [
    key, validHourArray(savedReminders[key]) ? sortedHours(savedReminders[key]) : reminderDefaults[key]
  ]));

  result.telegramAlertResetExpiry = typeof source.telegramAlertResetExpiry === "boolean"
    ? source.telegramAlertResetExpiry : source.telegramAlertResetCredits !== false;
  const oldHours = source.telegramResetExpiryHours;
  result.telegramResetReminderHours = validHourArray(source.telegramResetReminderHours)
    ? sortedHours(source.telegramResetReminderHours)
    : validHourArray([oldHours]) ? [oldHours] : [48];
  delete result.telegramResetExpiryHours;
  return result;
}

function bad(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}
function requireArray(value, label, min, max) {
  if (!validIntegerArray(value, min, max)) bad(`${label} must contain up to 10 distinct integers from ${min} to ${max}`);
  return label.toLowerCase().includes("hours") ? sortedHours(value) : sorted(value);
}
function requireBoolean(value, label) {
  if (typeof value !== "boolean") bad(`${label} must be a boolean`);
  return value;
}

export function patchTelegramSettings(current = {}, body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) bad("Settings patch must be an object");
  const next = normalizeTelegramSettings(current);
  const patch = body;
  const has = (key) => Object.hasOwn(patch, key);

  if (has("telegramAlertRules")) {
    const value = patch.telegramAlertRules;
    if (!value || typeof value !== "object" || Array.isArray(value)) bad("telegramAlertRules must be an object");
    for (const key of Object.keys(value)) if (!TELEGRAM_EVENT_TYPES.includes(key)) bad(`Unknown Telegram alert event: ${key}`);
    for (const [key, entries] of Object.entries(value)) next.telegramAlertRules[key] = requireArray(entries, `telegramAlertRules.${key}`, 0, 10080);
  }
  if (has("telegramQuotaWarningPercents")) next.telegramQuotaWarningPercents = requireArray(patch.telegramQuotaWarningPercents, "telegramQuotaWarningPercents", 1, 100);
  if (has("telegramQuotaWindows")) {
    const value = patch.telegramQuotaWindows;
    if (!Array.isArray(value) || value.length > TELEGRAM_QUOTA_WINDOWS.length || value.some((item) => !TELEGRAM_QUOTA_WINDOWS.includes(item)) || new Set(value).size !== value.length) bad("telegramQuotaWindows must contain distinct supported windows");
    next.telegramQuotaWindows = TELEGRAM_QUOTA_WINDOWS.filter((key) => value.includes(key));
  }
  if (has("telegramQuotaReminderHours")) {
    const value = patch.telegramQuotaReminderHours;
    if (!value || typeof value !== "object" || Array.isArray(value)) bad("telegramQuotaReminderHours must be an object");
    for (const key of Object.keys(value)) if (!TELEGRAM_QUOTA_WINDOWS.includes(key)) bad(`Unknown quota reminder window: ${key}`);
    for (const [key, hours] of Object.entries(value)) next.telegramQuotaReminderHours[key] = requireArray(hours, `telegramQuotaReminderHours.${key}`, 1, 720);
  }
  if (has("telegramAlertResetExpiry")) next.telegramAlertResetExpiry = requireBoolean(patch.telegramAlertResetExpiry, "telegramAlertResetExpiry");
  if (has("telegramResetReminderHours")) next.telegramResetReminderHours = requireArray(patch.telegramResetReminderHours, "telegramResetReminderHours", 1, 720);

  const legacyBoolFields = ["telegramAlertQuotaResets", "telegramAlertReserve", "telegramAlertResetCredits", "telegramAlertFailures"];
  for (const key of legacyBoolFields) if (has(key)) requireBoolean(patch[key], key);
  if (has("telegramQuotaWarningPercent") && (!Number.isInteger(patch.telegramQuotaWarningPercent) || patch.telegramQuotaWarningPercent < 1 || patch.telegramQuotaWarningPercent > 100)) bad("telegramQuotaWarningPercent must be an integer from 1 to 100");
  if (has("telegramResetExpiryHours") && !validHourArray([patch.telegramResetExpiryHours])) bad("telegramResetExpiryHours must be an integer from 1 to 720");

  // Legacy switches update only the corresponding canonical fields that were not explicitly patched.
  if (has("telegramAlertQuotaResets") && !Object.hasOwn(patch.telegramAlertRules || {}, "quota-reset")) next.telegramAlertRules["quota-reset"] = patch.telegramAlertQuotaResets ? [0] : [];
  if (has("telegramAlertReserve")) {
    for (const event of ["reserve-active", "reserve-recovered"]) if (!Object.hasOwn(patch.telegramAlertRules || {}, event)) next.telegramAlertRules[event] = patch.telegramAlertReserve ? [0] : [];
    if (!has("telegramQuotaWindows")) {
      next.telegramQuotaWindows = patch.telegramAlertReserve
        ? TELEGRAM_QUOTA_WINDOWS.filter((window) => [...next.telegramQuotaWindows, "reserve"].includes(window))
        : next.telegramQuotaWindows.filter((window) => window !== "reserve");
    }
  }
  if (has("telegramAlertResetCredits")) {
    if (!Object.hasOwn(patch.telegramAlertRules || {}, "reset-credit-count")) next.telegramAlertRules["reset-credit-count"] = patch.telegramAlertResetCredits ? [0] : [];
    if (!has("telegramAlertResetExpiry")) next.telegramAlertResetExpiry = patch.telegramAlertResetCredits;
  }
  if (has("telegramAlertFailures")) for (const event of ["auth-failure", "send-failure"]) if (!Object.hasOwn(patch.telegramAlertRules || {}, event)) next.telegramAlertRules[event] = patch.telegramAlertFailures ? [0] : [];
  if (has("telegramQuotaWarningPercent") && !has("telegramQuotaWarningPercents")) next.telegramQuotaWarningPercents = sorted([...new Set([patch.telegramQuotaWarningPercent, 95, 100])]);
  if (has("telegramResetExpiryHours") && !has("telegramResetReminderHours")) next.telegramResetReminderHours = [patch.telegramResetExpiryHours];

  for (const key of legacyBoolFields) if (has(key)) next[key] = patch[key];
  if (has("telegramQuotaWarningPercent")) next.telegramQuotaWarningPercent = patch.telegramQuotaWarningPercent;
  if (has("telegramResetExpiryHours")) delete next.telegramResetExpiryHours;
  return next;
}
