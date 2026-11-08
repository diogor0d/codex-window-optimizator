import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeUsage, readClaudeUsage } from "../src/claude-usage.mjs";

const now = Date.parse("2026-12-31T22:40:00Z");
const screen = [
  "Current session",
  "██████  18% used",
  "Resets 12:15am (UTC)",
  "",
  "Current week (all models)",
  "██████  82% used",
  "Resets Jan 4, 1pm (UTC)",
  "",
  "Current week (Fable)",
  "██████  97% used",
  "Resets Jan 5, 3pm (UTC)"
].join("\n");

test("reads the shared windows across midnight and New Year, excluding model-specific rows", () => {
  assert.deepEqual(parseClaudeUsage(screen, now), {
    primary: { usedPercent: 18, resetsAt: Date.parse("2027-01-01T00:15:00Z") / 1000, windowDurationMins: 300 },
    secondary: { usedPercent: 82, resetsAt: Date.parse("2027-01-04T13:00:00Z") / 1000, windowDurationMins: 10080 }
  });
  assert.equal(parseClaudeUsage(screen.replace(/██████  18% used\nResets 12:15am \(UTC\)/, "No active session"), now).primary, null);
  assert.equal(parseClaudeUsage(screen.slice(screen.indexOf("Current week (all models)")), now).primary, null);
});

test("rejects cached, ambiguous, malformed, and non-UTC readings", () => {
  assert.throws(() => parseClaudeUsage(screen + "\nShowing last-known usage", now), { code: "quota-stale" });
  assert.equal(parseClaudeUsage(screen + "\nRefreshing…", now), null);
  assert.throws(() => parseClaudeUsage(screen + "\nUsage endpoint rate limited until 11:15pm", now),
    { code: "quota-limited", retryAt: Date.parse("2026-12-31T23:15:00Z") });
  for (const text of [
    screen.replace("82% used", "82% remaining"),
    screen.replace("18% used", "-18% used"),
    screen.replace("UTC", "Europe/Lisbon"),
    screen.replace("12:15am", "6:15am"),
    screen + "\nCurrent session"
  ]) assert.equal(parseClaudeUsage(text, now), null, text);
});

test("does not submit a slash command when the CLI has not offered it", async () => {
  const sent = [];
  let output;
  let onExit;
  const subscription = { dispose() {} };
  await assert.rejects(readClaudeUsage({
    timeoutMs: 700,
    spawnTerminal() {
      setImmediate(() => output("Claude Code v2.1.303\r\n❯"));
      return {
        onData(callback) { output = callback; return subscription; },
        onExit(callback) { onExit = callback; return subscription; },
        write(text) {
          sent.push(text);
          output("\x1b[2J\x1b[HClaude Code v2.1.303\r\n❯ /usage");
        },
        kill() { onExit(); }
      };
    }
  }), { code: "unavailable" });
  assert.deepEqual(sent, ["/usage"]);
});

test("waits for refreshed quota after a nonbreaking-space prompt and cursor redraws", async () => {
  const nowMs = Date.now();
  const date = (timestamp) => new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", month: "short", day: "numeric"
  }).format(timestamp);
  const time = (timestamp) => new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", hour: "numeric", minute: "2-digit", hour12: true
  }).format(timestamp).replace(/\s/g, "").toLowerCase();
  const frame = `Current session\r\n████  19% used\r\nResets ${time(nowMs + 3600000)} (UTC)\r\n\r\nCurrent week (all models)\r\n████  17% used\r\nResets ${date(nowMs + 86400000)}, ${time(nowMs + 86400000)} (UTC)`;
  const sent = [];
  let output;
  let exited;
  let freshTimer;
  const subscription = { dispose() {} };
  const result = await readClaudeUsage({
    timeoutMs: 3000,
    spawnTerminal() {
      setImmediate(() => output('Claude Code v2.1.303\r\n❯\u00a0Try "how does <filepath> work?"'));
      return {
        onData(callback) { output = callback; return subscription; },
        onExit(callback) { exited = callback; return subscription; },
        write(text) {
          sent.push(text);
          if (text === "/usage") output("\x1b[2J\x1b[HClaude Code\r\n❯ /usage\r\n❯ /usage     Show session cost, plan usage, and activity");
          if (text === "\r") {
            output(`\x1b[2J\x1b[H${frame}\r\nRefreshing…`);
            freshTimer = setTimeout(() => output(`\x1b[2J\x1b[H${frame}\r\nUsage credits are off`), 400);
          }
        },
        kill() { clearTimeout(freshTimer); exited(); }
      };
    }
  });
  assert.equal(result.primary.usedPercent, 19);
  assert.equal(result.secondary.usedPercent, 17);
  assert.deepEqual(sent, ["/usage", "\r"]);
});
