/**
 * Iris Guard policy / authority schema (1.0).
 * Pure validation + light migration. Zero deps.
 */

export const POLICY_SCHEMA_VERSION = 1;

const MODE_ADA = new Set(["ask", "deny", "allow"]);
const MODE_DA = new Set(["deny", "ask"]);

/**
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePolicy(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["policy must be an object"] };
  }
  const p = /** @type {Record<string, unknown>} */ (obj);

  if (p.version != null && p.version !== POLICY_SCHEMA_VERSION && p.version !== 1) {
    errors.push(`unsupported policy version: ${String(p.version)}`);
  }

  if (p.rules != null && !Array.isArray(p.rules)) {
    errors.push("policy.rules must be an array when present");
  }

  if (p.default != null) {
    const d = String(p.default).toUpperCase();
    if (!["ALLOW", "ASK", "DENY"].includes(d)) {
      errors.push(`policy.default must be ALLOW|ASK|DENY, got ${String(p.default)}`);
    }
  }

  if (p.hardDeny != null && !Array.isArray(p.hardDeny)) {
    errors.push("policy.hardDeny must be an array when present");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateEnvelope(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["envelope must be an object"] };
  }
  const e = /** @type {Record<string, unknown>} */ (obj);

  if (e.version !== 1 && e.version !== POLICY_SCHEMA_VERSION) {
    if (e.version == null) {
      errors.push("envelope.version is required (expected 1)");
    } else {
      errors.push(`unsupported envelope version: ${String(e.version)}`);
    }
  }

  if (typeof e.task !== "string") {
    errors.push("envelope.task must be a string");
  }

  if (e.acceptedAt != null && typeof e.acceptedAt !== "string") {
    errors.push("envelope.acceptedAt must be an ISO string or null");
  }

  if (!e.scope || typeof e.scope !== "object" || Array.isArray(e.scope)) {
    errors.push("envelope.scope must be an object");
    return { ok: false, errors };
  }

  const s = /** @type {Record<string, unknown>} */ (e.scope);

  if (!Array.isArray(s.filesystem) || s.filesystem.some((x) => typeof x !== "string")) {
    errors.push("scope.filesystem must be an array of strings");
  }
  if (!Array.isArray(s.environments) || s.environments.some((x) => typeof x !== "string")) {
    errors.push("scope.environments must be an array of strings");
  }
  if (!Array.isArray(s.network) || s.network.some((x) => typeof x !== "string")) {
    errors.push("scope.network must be an array of strings");
  }
  if (!Array.isArray(s.credentials) || s.credentials.some((x) => typeof x !== "string")) {
    errors.push("scope.credentials must be an array of strings");
  }

  if (!MODE_ADA.has(String(s.destructive ?? ""))) {
    errors.push('scope.destructive must be "ask"|"deny"|"allow"');
  }
  if (!MODE_DA.has(String(s.production ?? ""))) {
    errors.push('scope.production must be "deny"|"ask"');
  }
  if (!MODE_ADA.has(String(s.externalWrites ?? ""))) {
    errors.push('scope.externalWrites must be "ask"|"deny"|"allow"');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Migrate a policy object to schema v1 when version is missing.
 * @param {unknown} obj
 * @returns {Record<string, unknown>}
 */
export function migratePolicy(obj) {
  const base =
    obj && typeof obj === "object" && !Array.isArray(obj)
      ? { .../** @type {Record<string, unknown>} */ (obj) }
      : {};

  if (base.version == null) {
    base.version = POLICY_SCHEMA_VERSION;
  }

  if (base.default == null) base.default = "ASK";
  if (base.rules == null) base.rules = [];
  if (base.hardDeny == null) base.hardDeny = [];

  return base;
}

/**
 * Migrate an envelope-shaped object toward v1 (fills missing scope keys).
 * @param {unknown} obj
 * @returns {Record<string, unknown>}
 */
export function migrateEnvelope(obj) {
  const base =
    obj && typeof obj === "object" && !Array.isArray(obj)
      ? { .../** @type {Record<string, unknown>} */ (obj) }
      : {};

  if (base.version == null) base.version = 1;
  if (typeof base.task !== "string") base.task = String(base.task ?? "");
  if (base.acceptedAt === undefined) base.acceptedAt = null;

  const prevScope =
    base.scope && typeof base.scope === "object" && !Array.isArray(base.scope)
      ? /** @type {Record<string, unknown>} */ (base.scope)
      : {};

  base.scope = {
    filesystem: Array.isArray(prevScope.filesystem) ? prevScope.filesystem : ["$PROJECT/**"],
    environments: Array.isArray(prevScope.environments) ? prevScope.environments : ["staging"],
    network: Array.isArray(prevScope.network) ? prevScope.network : [],
    destructive: MODE_ADA.has(String(prevScope.destructive ?? ""))
      ? String(prevScope.destructive)
      : "ask",
    production: MODE_DA.has(String(prevScope.production ?? ""))
      ? String(prevScope.production)
      : "deny",
    credentials: Array.isArray(prevScope.credentials) ? prevScope.credentials : ["staging"],
    externalWrites: MODE_ADA.has(String(prevScope.externalWrites ?? ""))
      ? String(prevScope.externalWrites)
      : "ask",
  };

  return base;
}
