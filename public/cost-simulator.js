export const PRICING_DATE = "2026-11-11";
export const PRICE_CATALOG = [
  { model: "gpt-6-luna", provider: "codex", input: 0.1, output: 0.5, read: 0.01, writeShort: 0.125, writeLong: 0.25 },
  { model: "gpt-6.1-terra", provider: "codex", input: 1, output: 5, read: 0.05, writeShort: 1.25, writeLong: 2.5 },
  { model: "gpt-6.1-sol", provider: "codex", input: 2, output: 10, read: 0.1, writeShort: 2.5, writeLong: 5 },
  { model: "gpt-6-astra", provider: "codex", input: 10, output: 50, read: 1, writeShort: 12.5, writeLong: 25 },
  { model: "claude-haiku-5-5", provider: "claude", input: 0.1, output: 0.5, read: 0.01, writeShort: 0.125, writeLong: 0.2 },
  { model: "claude-sonnet-5-5", provider: "claude", input: 2, output: 10, read: 0.1, writeShort: 2.5, writeLong: 4 },
  { model: "claude-opus-5-5", provider: "claude", input: 4, output: 20, read: 0.2, writeShort: 5, writeLong: 8 },
  { model: "claude-sonnet-4-6", provider: "claude", input: 3, output: 15, read: 0.3, writeShort: 3.75, writeLong: 6 },
  { model: "claude-opus-4-6", provider: "claude", input: 5, output: 25, read: 0.5, writeShort: 6.25, writeLong: 10 }
].map(row => ({ ...row, date: PRICING_DATE, source: row.provider === "codex"
  ? "https://developers.openai.com/api/docs/pricing" : "https://platform.claude.com/docs/en/about-claude/pricing" }));

export function simulateCost({ tokens, outputPercent, cacheReadPercent, cacheWritePercent, rates }) {
  const values = [tokens, outputPercent, cacheReadPercent, cacheWritePercent, rates?.input, rates?.output, rates?.read, rates?.write];
  if (values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)
    || tokens > Number.MAX_SAFE_INTEGER || [outputPercent, cacheReadPercent, cacheWritePercent].some(value => value > 100)
    || cacheReadPercent + cacheWritePercent > 100) throw new Error("Enter a token volume, token mix, and non-negative rates. Cache read + write must be at most 100% of input.");
  const output = tokens * outputPercent / 100;
  const input = tokens - output;
  const read = input * cacheReadPercent / 100;
  const write = input * cacheWritePercent / 100;
  const uncached = input - read - write;
  const costUSD = (uncached * rates.input + output * rates.output + read * rates.read + write * rates.write) / 1e6;
  const uncachedUSD = (input * rates.input + output * rates.output) / 1e6;
  if (![costUSD, uncachedUSD].every(Number.isFinite)) throw new Error("Scenario is too large to calculate.");
  // Output already includes reasoning; cached input is a subset of total input.
  return { costUSD, uncachedUSD, cacheDifferenceUSD: uncachedUSD - costUSD, input, output, read, write, uncached };
}
