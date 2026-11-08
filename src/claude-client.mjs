import { request } from "node:http";

export const CLAUDE_POLL_MS = 10 * 60_000;
export const CLAUDE_RUN_TIMEOUT_MS = 120_000;
export const CLAUDE_ACCOUNT_ID = /^acct_[a-f0-9]{12}$/;
export const CLAUDE_SESSION_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export const CLAUDE_REPLY_LIMIT = 4000;

export const CLAUDE_ERRORS = {
  unavailable: "Claude worker is unavailable.",
  disabled: "Claude is disabled until the Docker quota pilot passes.",
  "signed-out": "Sign in to this Claude account in the container.",
  "wrong-auth": "This account needs a Claude subscription sign-in.",
  "auth-expired": "Claude sign-in expired. Sign in again in the container.",
  "account-changed": "A different Claude account signed in. Use a separate account slot.",
  busy: "A Claude operation is already running for this account.",
  timeout: "Claude timed out. No automatic retry was sent.",
  interrupted: "The Claude operation was interrupted.",
  "quota-stale": "Claude returned a cached quota reading.",
  "quota-limited": "Claude temporarily limited quota reads.",
  "quota-format": "Claude's quota screen could not be read.",
  "usage-limit": "Claude reported a usage or billing limit.",
  "session-missing": "The saved Claude session is unavailable. The next send will start a new conversation.",
  failed: "Claude could not complete the operation."
};

export class ClaudeError extends Error {
  constructor(code, retryAt = null) {
    super(Object.hasOwn(CLAUDE_ERRORS, code) ? CLAUDE_ERRORS[code] : CLAUDE_ERRORS.failed);
    this.code = code;
    this.retryAt = Number.isSafeInteger(retryAt) ? retryAt : null;
  }
}

export function claudeClient(socketPath, verifiedVersion) {
  const configured = Boolean(socketPath && verifiedVersion);
  function call(action, accountId = null, data = {}) {
    if (!configured) return Promise.reject(new ClaudeError("disabled"));
    if (accountId !== null && !CLAUDE_ACCOUNT_ID.test(accountId)) return Promise.reject(new ClaudeError("failed"));
    const body = JSON.stringify(data);
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath, path: accountId ? `/${action}/${accountId}` : "/health", method: "POST",
        headers: {
          "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
          "X-Claude-Verified-Version": verifiedVersion
        },
        agent: false
      }, (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 32_000) req.destroy();
        });
        res.on("error", () => reject(new ClaudeError("unavailable")));
        res.on("end", () => {
          try {
            const result = JSON.parse(raw);
            if (res.statusCode === 200) resolve(result);
            else reject(new ClaudeError(Object.hasOwn(CLAUDE_ERRORS, result.error) ? result.error : "unavailable", result.retryAt));
          } catch {
            reject(new ClaudeError("unavailable"));
          }
        });
      });
      const timeout = setTimeout(() => req.destroy(new ClaudeError("unavailable")),
        action === "run" ? CLAUDE_RUN_TIMEOUT_MS + 20_000 : action === "usage" ? 35_000 : action === "health" ? 2000 : 15_000);
      req.once("close", () => clearTimeout(timeout));
      req.on("error", () => reject(new ClaudeError("unavailable")));
      req.end(body);
    });
  }

  return {
    configured,
    call,
    async available() {
      if (!configured) return false;
      try {
        const result = await call("health");
        return result.enabled === true && result.version === verifiedVersion;
      } catch {
        return false;
      }
    }
  };
}
