import xterm from "@xterm/headless";
import { CLAUDE_USAGE_TIMEOUT_MS, ClaudeError } from "./claude-client.mjs";

const { Terminal } = xterm;
const COLS = 120;
const ROWS = 60;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SESSION = "Current session";
const WEEK = "Current week (all models)";

function utcReset(text, now, horizon, allowImplicitZone = false) {
  // Claude displays minute precision. Interpret only known English UTC formats.
  const match = /^(?:([A-Z]{3})\s+(\d{1,2})(?:,| at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s+(?:\((?:Etc\/)?UTC\)|UTC))?$/i.exec(text.trim());
  if (!match || (!allowImplicitZone && !/UTC\)?$/i.test(text.trim()))) return null;
  const [, month, day, hours, minutes = "0", period] = match;
  const hour = Number(hours);
  const minute = Number(minutes);
  if (minute > 59 || (period ? hour < 1 || hour > 12 : hour > 23)) return null;
  const h = period ? hour % 12 + (period.toLowerCase() === "pm" ? 12 : 0) : hour;
  const current = new Date(now);
  const year = current.getUTCFullYear();
  let candidates;
  if (month) {
    const monthIndex = MONTHS.indexOf(month.toLowerCase());
    if (monthIndex < 0 || Number(day) < 1 || Number(day) > 31) return null;
    candidates = [year, year + 1].map((y) => Date.UTC(y, monthIndex, Number(day), h, minute))
      .filter((timestamp) => new Date(timestamp).getUTCMonth() === monthIndex);
  } else {
    const today = Date.UTC(year, current.getUTCMonth(), current.getUTCDate(), h, minute);
    candidates = [today, today + DAY];
  }
  return candidates.find((timestamp) => timestamp > now && timestamp <= now + horizon) ?? null;
}

export function parseClaudeUsage(screen, now = Date.now()) {
  const cached = /showing last[- ]known usage/i.test(screen);
  const limited = /(?:usage endpoint.{0,30}rate.limit|rate limited until)/i.test(screen);
  const backoff = /rate limited until ([^\n]+)/i.exec(screen);
  const retryAt = backoff ? utcReset(backoff[1], now, DAY, true) : null;
  if (cached || limited) throw new ClaudeError(limited ? "quota-limited" : "quota-stale", retryAt);
  if (/loading (?:plan|usage)|refreshing(?:…|\.\.\.)|failed to load usage|could not (?:fetch|load) usage/i.test(screen)) return null;
  const lines = screen.split("\n").map((line) => line.trim()).filter(Boolean);
  const parseWindow = (label, duration) => {
    const index = lines.indexOf(label);
    if (index < 0) return null;
    if (lines.lastIndexOf(label) !== index) return undefined;
    const rows = lines.slice(index + 1, index + 5).filter((_, i, list) =>
      !list.slice(0, i + 1).some((row) => /^(?:Current session|Current week|Usage credits|Extra usage)/i.test(row)));
    if (rows.some((row) => /^(?:no active session|no active usage window|no limit)$/i.test(row))) return null;
    const percentages = rows.flatMap((row) => [...row.matchAll(/(?:^|\s)(\d{1,3}(?:\.\d+)?)% used\s*$/gi)]);
    const resets = rows.flatMap((row) => [...row.matchAll(/^Resets\s+(.+)$/gi)]);
    if (percentages.length !== 1 || resets.length !== 1) return undefined;
    const usedPercent = Number(percentages[0][1]);
    const resetMs = utcReset(resets[0][1], now, (duration + 1) * MINUTE);
    if (usedPercent > 100 || !resetMs) return undefined;
    return { usedPercent, resetsAt: resetMs / 1000, windowDurationMins: duration };
  };
  const primary = parseWindow(SESSION, 300);
  const secondary = parseWindow(WEEK, 10080);
  if (primary === undefined || secondary === undefined || (!primary && !secondary)) return null;
  return { primary, secondary };
}

export function readClaudeUsage({ spawnTerminal, signal, timeoutMs = CLAUDE_USAGE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ClaudeError("interrupted"));
    const screen = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true });
    let child;
    try {
      child = spawnTerminal(COLS, ROWS);
    } catch {
      screen.dispose();
      return reject(new ClaudeError("unavailable"));
    }
    let phase = "waiting";
    let settled = false;
    let outcome = null;
    let quiet;
    let killTimer;
    let killDeadline;
    let readBytes = 0;
    const timeout = setTimeout(() => stop(new ClaudeError(phase === "reading" ? "quota-format" : "unavailable")), timeoutMs);
    const input = screen.onData((data) => { if (!outcome) child.write(data); });
    const output = child.onData((data) => {
      if (outcome) return;
      readBytes += Buffer.byteLength(data);
      if (readBytes > 1024 * 1024) return stop(new ClaudeError("quota-format"));
      clearTimeout(quiet);
      screen.write(data, () => {
        if (outcome) return;
        clearTimeout(quiet);
        quiet = setTimeout(inspect, 180);
      });
    });
    const exit = child.onExit(() => finish(outcome || { error: new ClaudeError("unavailable") }));
    const abort = () => stop(new ClaudeError("interrupted"));
    signal?.addEventListener("abort", abort, { once: true });

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(quiet);
      clearTimeout(killTimer);
      clearTimeout(killDeadline);
      signal?.removeEventListener("abort", abort);
      output.dispose();
      input.dispose();
      exit.dispose();
      screen.dispose();
      if (result.error) reject(result.error);
      else resolve(result.value);
    }

    function stop(error, value) {
      if (outcome) return;
      outcome = { error, value };
      clearTimeout(timeout);
      clearTimeout(quiet);
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 500);
      killDeadline = setTimeout(() => finish({ error: new ClaudeError("unavailable") }), 2000);
      try { child.kill(); } catch {}
    }

    function inspect() {
      const buffer = screen.buffer.active;
      const frame = Array.from({ length: ROWS }, (_, i) =>
        buffer.getLine(buffer.baseY + i)?.translateToString(true) || "").join("\n");
      if (phase === "waiting" && /Claude Code/i.test(frame) && /^[^\S\r\n]*❯(?:[^\S\r\n]+Try ["“][^\n]+["”])?[^\S\r\n]*$/m.test(frame)
        && !/do you trust|select login|choose (?:a |the )?(?:text style|theme)|enter to confirm|press enter to continue/i.test(frame)) {
        phase = "confirming";
        child.write("/usage");
      } else if (phase === "confirming" && /^\s*❯\s*\/usage\s*$/m.test(frame)
        && /^\s*(?:❯\s*)?\/?usage\s+(?:·\s+)?[^\n]*(?:usage|cost|limit|stat)/im.test(frame)) {
        // Only submit after seeing the CLI offer the built-in command.
        phase = "reading";
        child.write("\r");
      } else if (phase === "reading") {
        try {
          const usage = parseClaudeUsage(frame);
          if (usage) stop(null, usage);
        } catch (error) {
          stop(error);
        }
      }
    }
  });
}
