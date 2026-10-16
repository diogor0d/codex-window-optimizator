import test from "node:test";
import assert from "node:assert/strict";

import { chooseModel, normalizeModels, readModelCatalog } from "../src/models.mjs";

const model = (id, overrides = {}) => ({
  id,
  model: id,
  displayName: id,
  supportedReasoningEfforts: ["low", "medium"],
  ...overrides
});

test("blank configuration prefers the cheapest supported model independent of catalog order", () => {
  const models = normalizeModels([
    model("gpt-6.1-sol"),
    model("gpt-5.6-luna"),
    model("gpt-6-luna"),
    model("gpt-5.6-terra")
  ]);

  assert.equal(chooseModel(models).model, "gpt-6-luna");
});

test("explicit configuration returns the matching model object", () => {
  const models = normalizeModels([model("gpt-6-luna"), model("gpt-6.1-sol")]);
  const selected = chooseModel(models, "gpt-6.1-sol");

  assert.equal(selected.model, "gpt-6.1-sol");
  assert.equal(selected.displayName, "gpt-6.1-sol");
});

test("unknown explicit configuration throws instead of silently falling back", () => {
  const models = normalizeModels([model("gpt-6-luna")]);
  assert.throws(() => chooseModel(models, "gpt-missing"), /configured|available|model/i);
});

test("normalization uses model or id and filters retired models", () => {
  const models = normalizeModels([
    model("old", { model: "gpt-5.5", displayName: "Retired" }),
    model("legacy-id", { model: "gpt-5.5-preview" }),
    model("hidden-model", { hidden: true }),
    { id: "gpt-6-luna", displayName: "Luna", supportedReasoningEfforts: ["low"] }
  ]);

  assert.equal(models.length, 1);
  assert.equal(models[0].model, "gpt-6-luna");
  assert.equal(models[0].displayName, "Luna");
  assert.deepEqual(models[0].supportedReasoningEfforts, ["low"]);
});

test("normalization removes duplicate models and keeps the latest catalog entry", () => {
  const models = normalizeModels([
    model("gpt-6-luna", { displayName: "Old label" }),
    model("gpt-6-luna", { displayName: "Current label" })
  ]);
  assert.equal(models.length, 1);
  assert.equal(models[0].displayName, "Current label");
});

test("choosing from an empty catalog throws", () => {
  assert.throws(() => chooseModel([]), /no selectable models/i);
});

test("catalog reader follows cursors and combines pages", async () => {
  const calls = [];
  const appServer = {
    async send(method, params) {
      calls.push({ method, params });
      if (calls.length === 1) {
        return { data: [model("gpt-6-luna")], nextCursor: "page-2" };
      }
      return { data: [model("gpt-6.1-sol")], nextCursor: null };
    }
  };

  const models = await readModelCatalog(appServer);
  assert.deepEqual(calls, [
    { method: "model/list", params: { limit: 100 } },
    { method: "model/list", params: { limit: 100, cursor: "page-2" } }
  ]);
  assert.deepEqual(models.map(({ model: name }) => name), ["gpt-6-luna", "gpt-6.1-sol"]);
});

test("catalog reader rejects a repeated cursor", async () => {
  let calls = 0;
  const appServer = {
    async send() {
      calls += 1;
      return { data: [], nextCursor: "same-page" };
    }
  };
  await assert.rejects(readModelCatalog(appServer), /repeated.*cursor/i);
  assert.equal(calls, 2);
});

test("catalog reader propagates app-server failures", async () => {
  const failure = new Error("app-server unavailable");
  const appServer = { async send() { throw failure; } };
  await assert.rejects(readModelCatalog(appServer), error => error === failure);
});
