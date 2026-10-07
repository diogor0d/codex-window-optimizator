import test from "node:test";
import assert from "node:assert/strict";
import { visibleDockSection } from "../public/app.js";

test("keeps the selected destination when Schedule and Send share a row", () => {
  const row = [
    { id: "schedule", top: 16, bottom: 1200 },
    { id: "send", top: 16, bottom: 350 }
  ];
  assert.equal(visibleDockSection(row, "send", 700), "send");
  assert.equal(visibleDockSection(row, "schedule", 700), "schedule");
});

test("tracks the next row rather than an adjacent tall card during scrolling", () => {
  assert.equal(visibleDockSection([
    { id: "schedule", top: -600, bottom: 1200 },
    { id: "send", top: -600, bottom: -250 },
    { id: "activity", top: 12, bottom: 650 }
  ], "send", 700), "activity");
});

test("ignores sections hidden behind the dock or above the visible content", () => {
  const bounds = [
    { id: "fleet", top: -800, bottom: 0 },
    { id: "account", top: 30, bottom: 600 },
    { id: "schedule", top: 720, bottom: 1500 }
  ];
  assert.equal(visibleDockSection(bounds, "fleet", 700), "account");
  assert.equal(visibleDockSection([], "account", 700), "account");
});
