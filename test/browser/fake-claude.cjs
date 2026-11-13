const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("2.1.303 (Claude Code)");
  process.exit(0);
}

const accountDir = process.env.HOME;
const identityPath = path.join(accountDir, "fixture-identity");
const log = (entry) => fs.appendFileSync(path.join(accountDir, "fixture-log"), `${JSON.stringify(entry)}\n`);
const signedIn = fs.existsSync(identityPath);
if (args[0] === "auth") {
  if (args[1] === "status") {
    if (fs.existsSync(path.join(accountDir, "fixture-auth-unavailable"))) process.exit(2);
    console.log(JSON.stringify(signedIn
      ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: fs.readFileSync(identityPath, "utf8") }
      : { loggedIn: false }));
    process.exit(signedIn ? 0 : 1);
  }
  if (args[1] === "logout") {
    fs.rmSync(identityPath, { force: true });
    process.exit(0);
  }
  if (args[1] === "login" && args.includes("--claudeai")) {
    const url = new URL("https://claude.com/cai/oauth/authorize");
    url.search = new URLSearchParams({ code: "true", client_id: "fixture-client", response_type: "code",
      redirect_uri: "https://platform.claude.com/oauth/code/callback", code_challenge: "c".repeat(43),
      code_challenge_method: "S256", state: "s".repeat(43) });
    // Mimic the CLI's split OSC hyperlink and include output that must stay private.
    process.stdout.write(`PRIVATE_LOGIN_DIAGNOSTIC\nIf the browser didn't open, visit: \x1b]8;;${url}\x07`);
    setTimeout(() => process.stdout.write(`${url}\x1b]8;;\x07\nPaste code here if prompted > `), 15);
    process.stdin.setEncoding("utf8");
    let code = "";
    process.stdin.on("data", (chunk) => {
      code += chunk;
      if (!code.endsWith("\n")) return;
      if (code.trim() !== `fixture-code#${"s".repeat(43)}`) process.exit(1);
      fs.writeFileSync(identityPath, "browser@example.invalid");
      process.stdout.write("SECRET_TOKEN_MUST_STAY_PRIVATE\nLogin successful\n");
      process.exit(0);
    });
    return;
  }
  process.exit(1);
}

const toolsIndex = args.indexOf("--tools");
if (toolsIndex < 0 || args[toolsIndex + 1] !== "" || !args.includes("--safe-mode")
  || !args.includes("--strict-mcp-config") || !args.includes("--no-chrome")
  || process.env.ANTHROPIC_API_KEY || process.env.TELEGRAM_BOT_TOKEN || process.env.CODEX_HOME) process.exit(2);

if (args.includes("--print")) {
  const resume = args.includes("--resume");
  const sessionId = args[args.indexOf(resume ? "--resume" : "--session-id") + 1];
  const sessionFile = path.join(accountDir, `fixture-session-${sessionId}`);
  if (resume !== fs.existsSync(sessionFile)) {
    console.error("No session found");
    process.exit(1);
  }
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { text += chunk; });
  process.stdin.on("end", () => {
    log({ action: "send", sessionId, resume, text });
    fs.writeFileSync(sessionFile, "");
    setTimeout(() => console.log(JSON.stringify({
      type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "Synthetic reply."
    })), 500);
  });
} else {
  if (!process.stdin.isTTY || process.stdout.columns !== 120 || process.stdout.rows !== 60) process.exit(2);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  const paint = (text) => process.stdout.write(`\x1b[2J\x1b[H${text.replaceAll("\n", "\r\n")}`);
  let setup = !fs.existsSync(path.join(accountDir, "fixture-setup"));
  const firstFrame = () => paint(setup ? "Welcome to Claude Code\nChoose the text style that looks best with your terminal\n❯ Dark mode" : "Claude Code v2.1.303\n\n❯");
  const delayFile = path.join(accountDir, "fixture-start-delay");
  if (fs.existsSync(delayFile)) setTimeout(firstFrame, Number(fs.readFileSync(delayFile, "utf8")));
  else firstFrame();
  let typed = "";
  process.stdin.on("data", (chunk) => {
    if (setup) {
      if (chunk !== "\r") process.exit(2);
      setup = false;
      fs.writeFileSync(path.join(accountDir, "fixture-setup"), "");
      paint("Claude Code v2.1.303\n\n❯");
      return;
    }
    typed += chunk;
    if (typed === "/usage") {
      paint("Claude Code v2.1.303\n\n❯ /usage\n\n  /usage    Show plan usage limits");
      return;
    }
    if (typed !== "/usage\r") {
      log({ action: "unexpected-input", typed });
      process.exit(2);
    }
    log({ action: "usage" });
    const { primary = 25, weekly = 42, state, extraUsage = "" } = JSON.parse(fs.readFileSync(path.join(accountDir, "fixture-quota"), "utf8"));
    if (state === "malformed") return paint("Usage\n\nUnexpected format");
    const now = Date.now();
    const time = (timestamp) => new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", hour: "numeric", minute: "2-digit", hour12: true
    }).format(timestamp).replace(/\s/g, "").toLowerCase();
    const date = (timestamp) => new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", month: "short", day: "numeric"
    }).format(timestamp);
    paint(`Usage\n\nCurrent session\n██████  ${primary}% used\nResets ${time(now + 2 * 3600000)} (UTC)\n\nCurrent week (all models)\n██████  ${weekly}% used\nResets ${date(now + 86400000)}, ${time(now + 86400000)} (UTC)\n\n${extraUsage ? `Usage credits\n${extraUsage}\n` : ""}${state === "cached" ? "Showing last-known usage from 5 min ago" : ""}`);
  });
}
