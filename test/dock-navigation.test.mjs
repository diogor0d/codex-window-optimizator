import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dashboardView } from "../public/app.js";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("each dock destination resolves to a declared dashboard view", () => {
  const destinations = [...html.matchAll(/href="(#[^"]+)" data-section="([^"]+)"/g)];
  const views = new Set([...html.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]));
  assert.equal(destinations.length, 6);
  for (const [, hash, section] of destinations) {
    assert.equal(dashboardView(hash), section);
    assert.ok(views.has(dashboardView(hash)), `${hash} needs a visible destination`);
  }
});

test("existing Send and Today's sends bookmarks open their owning views", () => {
  assert.equal(dashboardView("#send"), "account");
  assert.equal(dashboardView("#board"), "fleet");
  assert.match(html, /id="send"[^>]+data-view="account"/);
  assert.match(html, /id="board"[^>]+data-view="fleet"/);
});

test("empty or unknown bookmarks keep the overview reachable", () => {
  for (const hash of ["", "#", "#unknown", "#toString", "#__proto__"]) {
    assert.equal(dashboardView(hash), "fleet");
  }
});
