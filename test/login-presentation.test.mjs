import test from "node:test";
import assert from "node:assert/strict";
import { loginPresentation } from "../public/app.js";

const startedAt = "2026-10-23T10:00:00.000Z";
const deviceOutput = [
  { stream: "stdout", text: "Open https://auth.openai.com/codex/dev" },
  { stream: "stdout", text: "ice and enter code \u001b[1mTEST0-" },
  { stream: "stderr", text: "\u001b[0mCODE9\nThis code expires in 15 minutes.\n" }
];

test("extracts the allowlisted device URL and code across split ANSI output", () => {
  assert.deepEqual(loginPresentation({ status: "running", startedAt, output: deviceOutput }, Date.parse(startedAt)), {
    status: "running",
    code: "TEST0-CODE9",
    url: "https://auth.openai.com/codex/device"
  });
});

test("hides old device codes after completion or failure", () => {
  for (const status of ["completed", "failed"]) {
    const view = loginPresentation({ status, startedAt, output: deviceOutput }, Date.parse(startedAt));
    assert.equal(view.status, status);
    assert.equal(view.code, "");
  }
});

test("marks a running code expired at its 15-minute deadline", () => {
  const view = loginPresentation({ status: "running", startedAt, output: deviceOutput }, Date.parse(startedAt) + 15 * 60_000);
  assert.equal(view.status, "expired");
  assert.equal(view.code, "");
});

test("rejects spoofed hosts, non-HTTPS links, and lookalike paths", () => {
  for (const url of [
    "https://auth.openai.com.evil.example/codex/device",
    "http://auth.openai.com/codex/device",
    "https://evil.example/?next=https://auth.openai.com/codex/device",
    "https://auth.openai.com/codex/device.evil"
  ]) {
    assert.equal(loginPresentation({ status: "running", startedAt, output: [{ stream: "stdout", text: url }] }).url, "");
  }
});

test("returns no presentation for absent sessions or sessions without output", () => {
  assert.deepEqual(loginPresentation(null), { status: "none", code: "", url: "" });
  assert.deepEqual(loginPresentation({ status: "none", output: deviceOutput }), { status: "none", code: "", url: "" });
  assert.deepEqual(loginPresentation({ status: "running", startedAt, output: [] }), { status: "running", code: "", url: "" });
});
