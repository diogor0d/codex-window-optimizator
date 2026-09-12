export function interpretCodexLoginStatus(result) {
  const detail = `${result?.stdout || ""}\n${result?.stderr || ""}`.trim();
  if (result?.timedOut || result?.signal || result?.code === -1) {
    return {
      available: false,
      loggedIn: null,
      detail: detail || "Codex login status check did not complete",
      code: result?.code ?? null
    };
  }
  if (result?.code === 0) {
    return { available: true, loggedIn: true, detail: detail || "Logged in", code: 0 };
  }
  if (/\bnot logged in\b|\blogin required\b/i.test(detail)) {
    return { available: true, loggedIn: false, detail: detail || "Not logged in", code: result?.code ?? null };
  }
  return {
    available: false,
    loggedIn: null,
    detail: detail || "Codex login status check did not complete",
    code: result?.code ?? null
  };
}

export function mergeAuthenticationProbe(previous, interpreted) {
  const fallback = {
    loggedIn: false,
    credentialPresent: false,
    authIssue: false,
    mode: "unknown",
    detail: "Not checked yet"
  };
  if (!interpreted.available) {
    return {
      ...(previous || fallback),
      probeUnavailable: true,
      probeDetail: interpreted.detail,
      code: interpreted.code
    };
  }
  if (interpreted.loggedIn) {
    return {
      loggedIn: true,
      credentialPresent: true,
      authIssue: false,
      mode: "codex",
      detail: previous?.authIssue ? "Logged in (live request verified)" : interpreted.detail,
      logoutConfirmationPending: false,
      probeUnavailable: false,
      code: interpreted.code
    };
  }
  if (previous?.loggedIn === false && previous.mode === "none" && !previous.logoutConfirmationPending) {
    return {
      ...previous,
      detail: interpreted.detail,
      probeUnavailable: false,
      code: interpreted.code
    };
  }
  if (!previous?.logoutConfirmationPending) {
    return {
      ...(previous || fallback),
      logoutConfirmationPending: true,
      probeUnavailable: false,
      probeDetail: interpreted.detail,
      detail: "Logged-out status pending confirmation",
      code: interpreted.code
    };
  }
  return {
    loggedIn: false,
    credentialPresent: false,
    authIssue: false,
    mode: "none",
    detail: interpreted.detail,
    logoutConfirmationPending: false,
    probeUnavailable: false,
    code: interpreted.code
  };
}

export function advanceAuthenticationFailure(previousCount, alreadyAlerted, confirmationCount = 2) {
  const count = Math.min(confirmationCount, Math.max(0, previousCount || 0) + 1);
  return { count, shouldAlert: count >= confirmationCount && !alreadyAlerted };
}
