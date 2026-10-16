// Prefer the lowest published Standard credit rates among known Codex models.
// The account's app-server catalog remains the source of selectable models.
const LOW_COST_ORDER = [
  "gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-sol", "gpt-6-sol",
  "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"
];

export function isRetiredModel(model) {
  return /^gpt-5\.5(?:-|$)/.test(model || "");
}

export function normalizeModels(data) {
  const models = new Map();
  for (const entry of Array.isArray(data) ? data : []) {
    const model = entry?.model || entry?.id;
    if (typeof model !== "string" || !model || entry.hidden || isRetiredModel(model)) continue;
    models.set(model, { ...entry, model, displayName: entry.displayName || model });
  }
  return [...models.values()];
}

export function chooseModel(models, configured = "") {
  const available = normalizeModels(models);
  const requested = configured.trim();
  if (requested) {
    const selected = available.find((entry) => entry.model === requested);
    if (!selected) throw new Error(`Model "${requested}" is unavailable. Select an available model or Automatic in Schedule settings or account overrides.`);
    return selected;
  }
  const selected = LOW_COST_ORDER.map((model) => available.find((entry) => entry.model === model)).find(Boolean)
    || available.find((entry) => entry.isDefault) || available[0];
  if (!selected) throw new Error("Codex returned no selectable models for this account.");
  return selected;
}

export async function readModelCatalog(appServer) {
  const data = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await appServer.send("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    data.push(...(page?.data || []));
    cursor = page?.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Codex repeated a model catalog cursor.");
    seen.add(cursor);
  } while (cursor);
  return normalizeModels(data);
}
