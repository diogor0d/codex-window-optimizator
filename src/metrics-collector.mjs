import { createHash } from "node:crypto";
import { bindMetricsIdentity, METRICS_INTERVAL_MS, normalizeMetrics, normalizeTokenReport } from "./usage-metrics.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");

export function createMetricsCollector({ read, changed = async () => {}, now = Date.now, isCurrent = () => true, revision = () => null }) {
  const pending = new Map();
  return function refresh(account, { force = false, accountIdentity = null } = {}) {
    if (account.provider !== "codex") return Promise.resolve({ status: "unsupported" });
    if (pending.has(account.id)) return pending.get(account.id);
    const time = now();
    account.metrics = normalizeMetrics(account.metrics, account.provider, time);
    const metrics = account.metrics;
    const sourceRevision = revision(account);
    const current = () => isCurrent(account) && revision(account) === sourceRevision;
    const lastAttempt = Date.parse(metrics.attemptedAt) || 0;
    if (time < (Date.parse(metrics.nextAt) || 0) && (!force || time - lastAttempt < 60_000)) return Promise.resolve({ status: "skipped" });
    const task = (async () => {
      metrics.attemptedAt = new Date(time).toISOString();
      try {
        const identity = await read(account, "account/read", { refreshToken: false });
        if (!current()) return { status: "superseded" };
        if (identity?.account?.type !== "chatgpt") {
          if (identity?.account?.type) bindMetricsIdentity(metrics, `mode:${identity.account.type}`, null, time);
          metrics.status = identity?.account ? "unsupported" : "auth-required";
          metrics.nextAt = new Date(time + METRICS_INTERVAL_MS).toISOString();
          await changed(account);
          return { status: metrics.status };
        }
        const email = identity.account.email?.trim().toLowerCase();
        const emailFingerprint = email ? digest(email) : null;
        const sameIdentity = emailFingerprint && emailFingerprint === metrics.emailFingerprint;
        const binding = accountIdentity ? `id:${digest(accountIdentity)}` : sameIdentity ? metrics.identity
          : emailFingerprint ? `email:${emailFingerprint}` : null;
        // Only a backend account ID proves duplicate slots. An email may span workspaces.
        bindMetricsIdentity(metrics, binding || `unverified:${account.id}`,
          accountIdentity ? digest(accountIdentity) : sameIdentity ? metrics.dedupeKey : null, time);
        metrics.emailFingerprint = emailFingerprint;
        metrics.attemptedAt = new Date(time).toISOString();
        const response = await read(account, "account/usage/read", {});
        if (!current()) return { status: "superseded" };
        if (!response?.summary || typeof response.summary !== "object") throw new Error("Invalid account usage response");
        metrics.report = normalizeTokenReport(response, binding ? metrics.report || {} : {}, time);
        const any = Object.values(metrics.report.summary).some(value => value !== null)
          || metrics.report.dailyReported && metrics.report.dailyUsageBuckets.length > 0;
        metrics.status = any ? "available" : "partial";
        metrics.updatedAt = new Date(time).toISOString();
        metrics.failures = 0;
        metrics.nextAt = new Date(time + METRICS_INTERVAL_MS).toISOString();
      } catch (error) {
        if (!current()) return { status: "superseded" };
        const text = String(error.message || "");
        metrics.status = /method not found|unknown (?:variant|method)|unsupported method|-32601/i.test(text) ? "unsupported"
          : /\b401\b|not authenticated|not logged in|token.{0,20}expired/i.test(text) ? "auth-required" : "error";
        metrics.failures = Math.min(metrics.failures + 1, 10);
        metrics.nextAt = new Date(time + Math.min(3_600_000, METRICS_INTERVAL_MS * 2 ** (metrics.failures - 1))).toISOString();
      }
      await changed(account);
      return { status: metrics.status };
    })().finally(() => pending.delete(account.id));
    pending.set(account.id, task);
    return task;
  };
}
