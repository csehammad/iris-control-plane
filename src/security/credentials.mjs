/**
 * Credential gate used by Guard at evaluation time.
 * Discovery does not grant authority: a seen secret is not a permitted secret.
 */

/**
 * @param {{ resource?: string, operation?: string, credentialKind?: string, envelope?: { credentials?: string[], scope?: { credentials?: string[] } } }} args
 * @returns {{ decision: 'ALLOW'|'ASK'|'DENY', reason: string }}
 */
export function authorizeCredential({ resource, operation, credentialKind, envelope } = {}) {
  const kind = String(credentialKind ?? "").toLowerCase();
  const hay = `${kind} ${resource ?? ""} ${operation ?? ""}`.toLowerCase();
  const listed = Array.isArray(envelope?.credentials)
    ? envelope.credentials
    : Array.isArray(envelope?.scope?.credentials)
      ? envelope.scope.credentials
      : [];
  const allowed = listed.map((c) => String(c).toLowerCase());

  if (/\bprod(uction)?\b/.test(hay) || kind === "production" || kind === "prod") {
    return {
      decision: "DENY",
      reason: "Production credentials are denied by default",
    };
  }

  if (/\bstaging\b/.test(hay) || kind === "staging") {
    if (allowed.includes("staging")) {
      return {
        decision: "ALLOW",
        reason: "Staging credentials permitted by authority envelope",
      };
    }
    return {
      decision: "DENY",
      reason: "Staging credentials are not listed in envelope.credentials",
    };
  }

  return {
    decision: "ASK",
    reason: "Unknown credential kind requires confirmation",
  };
}

/**
 * Look up a redaction placeholder in an in-memory vault map at the tool boundary.
 * Returns the real value, or null when the placeholder is unknown.
 *
 * @param {string} placeholder
 * @param {Map<string, string>|null|undefined} vaultMap
 * @returns {string|null}
 */
export function injectAtBoundary(placeholder, vaultMap) {
  if (!placeholder || !vaultMap || typeof vaultMap.get !== "function") return null;
  const value = vaultMap.get(placeholder);
  return value == null ? null : value;
}
