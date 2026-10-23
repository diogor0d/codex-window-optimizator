import test from "node:test";
import assert from "node:assert/strict";
import { activityTone, shouldShowEvent, summarizeEvent } from "../public/app.js";

const completed = (turn, severity = "info") => ({
  source: "codex", severity, message: "turn/completed", payload: { turn }
});

test("a completed notification with failed status or an error is never a success", () => {
  for (const event of [
    completed({ status: "failed", durationMs: 4800 }),
    completed({ status: "completed", error: { message: "At capacity" } }),
    completed({ status: "completed" }, "error")
  ]) {
    assert.equal(activityTone(event), "error");
    assert.equal(summarizeEvent(event).title, "Turn failed");
    assert.equal(shouldShowEvent(event), true);
  }
});

test("failed turns expose the actionable error without requiring raw JSON", () => {
  const summary = summarizeEvent(completed({
    id: "turn-1", status: "failed", durationMs: 4800,
    error: { message: "Selected model is at capacity. Please try a different model." }
  }));
  assert.match(summary.body, /4\.8 s/);
  assert.match(summary.body, /Selected model is at capacity/);
  assert.equal(summary.payload.turnId, "turn-1");
  assert.ok(!summary.tags.includes("ok"));
});

test("only confirmed successful completion is green; starts and cancellations differ", () => {
  assert.equal(activityTone(completed({ status: "completed" })), "success");
  assert.equal(summarizeEvent(completed({ status: "completed" })).body, "");
  assert.deepEqual(summarizeEvent(completed({ status: "completed" })).tags, []);
  assert.equal(activityTone(completed({ status: "interrupted" })), "warn");
  assert.equal(summarizeEvent(completed({ status: "interrupted" })).title, "Turn interrupted");
  assert.equal(activityTone(completed({})), "info");
  assert.equal(activityTone({ message: "turn/started" }), "active");
  assert.equal(activityTone({ message: "account/rateLimits/updated" }), "info");
  for (const message of ["turn/failed", "turn/cancelled", "turn/interrupted"]) {
    assert.notEqual(activityTone({ message }), "success");
    assert.notEqual(summarizeEvent({ message }).title, "Turn completed");
  }
});

test("routine refresh and polling are hidden by default but errors remain visible", () => {
  for (const event of [
    { source: "refresh", message: "State refresh completed", severity: "info" },
    { source: "server", message: "Web server listening", severity: "info" },
    { source: "codex", message: "account/rateLimits/updated", severity: "info" },
    { source: "codex", message: "thread/status/changed", payload: { status: { type: "idle" } } }
  ]) {
    assert.equal(shouldShowEvent(event, false), false);
    assert.equal(shouldShowEvent(event, true), true);
  }
  assert.equal(shouldShowEvent({ source: "refresh", message: "State refresh completed", severity: "warn" }), true);
  assert.equal(shouldShowEvent({ source: "codex", message: "thread/status/changed", payload: { status: { type: "systemError" } } }), true);
  assert.equal(shouldShowEvent({ source: "codex", message: "item/completed", payload: { item: { type: "agentMessage" } } }), true);
  assert.equal(shouldShowEvent({ source: "codex", message: "item/completed", payload: { item: { type: "commandExecution" } } }), false);
});
