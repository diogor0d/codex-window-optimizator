import test from "node:test";
import assert from "node:assert/strict";
import { schedulePromptPreview } from "../public/app.js";

const settings = {
  timezone: "Europe/Lisbon",
  scheduleTimes: ["21:03", "06:00", "16:02", "11:01"],
  promptTemplate: "Ping at {{local_time}}. Slot {{scheduled_time}}; {{reason}}."
};

test("previews the next local scheduled send without changing its saved template", () => {
  const before = structuredClone(settings);
  assert.equal(schedulePromptPreview(settings, new Date("2026-10-23T08:00:00Z")),
    "Ping at 2026-10-23 11:01 Europe/Lisbon. Slot 11:01; scheduled.");
  assert.deepEqual(settings, before);
});

test("advances the configured local calendar date after the last daily send", () => {
  assert.equal(schedulePromptPreview(settings, new Date("2026-12-31T23:45:00Z")),
    "Ping at 2027-01-01 06:00 Europe/Lisbon. Slot 06:00; scheduled.");
  const tokyo = { ...settings, timezone: "Asia/Tokyo", scheduleTimes: ["06:00"] };
  assert.equal(schedulePromptPreview(tokyo, new Date("2026-10-23T23:00:00Z")),
    "Ping at 2026-10-25 06:00 Asia/Tokyo. Slot 06:00; scheduled.");
});

test("preserves plain text, unknown fields, and repeated supported fields", () => {
  assert.equal(schedulePromptPreview({ ...settings, promptTemplate: "Custom message <b>text</b>" }), "Custom message <b>text</b>");
  assert.equal(schedulePromptPreview({ ...settings, promptTemplate: "{{reason}} {{custom}} {{reason}}" }), "scheduled {{custom}} scheduled");
});
