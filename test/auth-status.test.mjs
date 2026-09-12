import test from "node:test";
import assert from "node:assert/strict";

import { advanceAuthenticationFailure, interpretCodexLoginStatus, mergeAuthenticationProbe } from "../src/auth-status.mjs";

test("recognizes successful Codex login status", () => {
  assert.deepEqual(interpretCodexLoginStatus({ code: 0, stdout: "Logged in using ChatGPT", stderr: "" }), {
    available: true,
    loggedIn: true,
    detail: "Logged in using ChatGPT",
    code: 0
  });
});

test("recognizes an explicit logged-out status", () => {
  const status = interpretCodexLoginStatus({ code: 1, stdout: "", stderr: "Not logged in" });
  assert.equal(status.available, true);
  assert.equal(status.loggedIn, false);
});

test("does not interpret a terminated status probe as logout", () => {
  const status = interpretCodexLoginStatus({
    code: -1,
    signal: "SIGTERM",
    timedOut: true,
    stdout: "",
    stderr: "timeout waiting for child process to exit"
  });
  assert.equal(status.available, false);
  assert.equal(status.loggedIn, null);
});

test("does not accept a zero exit code after a status probe timeout", () => {
  const status = interpretCodexLoginStatus({
    code: 0,
    signal: null,
    timedOut: true,
    stdout: "Logged in",
    stderr: ""
  });
  assert.equal(status.available, false);
  assert.equal(status.loggedIn, null);
});

test("preserves the last known state when a status probe is unavailable", () => {
  const previous = { loggedIn: true, credentialPresent: true, authIssue: false, detail: "Logged in" };
  const status = mergeAuthenticationProbe(previous, {
    available: false,
    loggedIn: null,
    detail: "Timed out",
    code: -1
  });
  assert.equal(status.loggedIn, true);
  assert.equal(status.probeUnavailable, true);
});

test("requires two logged-out probes before replacing the last known state", () => {
  const previous = { loggedIn: true, credentialPresent: true, authIssue: false, detail: "Logged in" };
  const probe = { available: true, loggedIn: false, detail: "Not logged in", code: 1 };
  const pending = mergeAuthenticationProbe(previous, probe);
  assert.equal(pending.loggedIn, true);
  assert.equal(pending.logoutConfirmationPending, true);

  const confirmed = mergeAuthenticationProbe(pending, probe);
  assert.equal(confirmed.loggedIn, false);
  assert.equal(confirmed.credentialPresent, false);
  assert.equal(confirmed.logoutConfirmationPending, false);

  const stable = mergeAuthenticationProbe(confirmed, probe);
  assert.equal(stable.loggedIn, false);
  assert.equal(stable.logoutConfirmationPending, false);
});

test("keeps an explicit logout definitive on later probes", () => {
  const previous = {
    loggedIn: false,
    credentialPresent: false,
    authIssue: false,
    mode: "none",
    detail: "Logged out"
  };
  const status = mergeAuthenticationProbe(previous, {
    available: true,
    loggedIn: false,
    detail: "Not logged in",
    code: 1
  });
  assert.equal(status.loggedIn, false);
  assert.equal(status.logoutConfirmationPending, undefined);
});

test("requires two confirmed authentication failures and alerts once", () => {
  assert.deepEqual(advanceAuthenticationFailure(0, false), { count: 1, shouldAlert: false });
  assert.deepEqual(advanceAuthenticationFailure(1, false), { count: 2, shouldAlert: true });
  assert.deepEqual(advanceAuthenticationFailure(2, true), { count: 2, shouldAlert: false });
});
