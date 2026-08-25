/**
 * Deterministic Guard policy engine. No LLM.
 *
 * Evaluation order:
 *   hard deny → scope violation → authority expansion → high-consequence → explicit allow → default
 */

import { resolve, relative, isAbsolute } from "node:path";
import { authorizeCredential } from "../security/credentials.mjs";

/**
 * @typedef {'ALLOW'|'ASK'|'DENY'} Decision
 * @typedef {{ decision: Decision, reason: string, rule: string }} PolicyResult
 */

/**
 * @param {string} pattern
 * @param {string} projectRoot
 */
function expandPattern(pattern, projectRoot) {
  const root = projectRoot ? resolve(projectRoot) : "";
  return String(pattern || "")
    .replace(/\$PROJECT/g, root || "$PROJECT")
    .replace(/\/\*\*$/, "")
    .replace(/\*\*$/, "");
}

/**
 * @param {string} absPath
 * @param {string[]} patterns
 * @param {string} projectRoot
 */
export function pathInFilesystemScope(absPath, patterns, projectRoot) {
  if (!absPath) return false;
  let abs;
  try {
    abs = resolve(absPath);
  } catch {
    return false;
  }
  const root = projectRoot ? resolve(projectRoot) : "";
  const list = Array.isArray(patterns) ? patterns : [];

  for (const pat of list) {
    const p = String(pat);
    // $PROJECT/** → anything under project root
    if (p.includes("$PROJECT") || p === "**" || p === "*") {
      if (!root) continue;
      const base = expandPattern(p, root) || root;
      const rel = relative(base, abs);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
      continue;
    }
    // Absolute or relative glob-ish prefix match (deterministic, not full glob)
    const base = p.includes("*")
      ? resolve(root || process.cwd(), p.replace(/\/?\*\*.*$/, "").replace(/\*.*$/, ""))
      : resolve(root || process.cwd(), p);
    const rel = relative(base, abs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

/**
 * @param {string|null|undefined} host
 * @param {string[]} allowlist
 */
function hostAllowed(host, allowlist) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  const list = (allowlist || []).map((x) => String(x).toLowerCase());
  if (list.length === 0) return false;
  return list.some((entry) => h === entry || h.endsWith(`.${entry}`) || entry === "*");
}

function envAllowed(environment, environments) {
  if (!environment) return true;
  const list = (environments || []).map((e) => String(e).toLowerCase());
  return list.includes(String(environment).toLowerCase());
}

function credentialAllowed(credential, credentials) {
  if (!credential) return true;
  const c = String(credential).toLowerCase();
  if (c === "production" || c === "prod") return false; // never via allowlist alone
  const list = (credentials || []).map((x) => String(x).toLowerCase());
  if (c === "secret" || c === "aws" || c === "npm" || c === "database") {
    // generic secret kinds require explicit listing or ASK later
    return list.includes(c);
  }
  return list.includes(c);
}

/**
 * Evaluate a normalized effect against an authority envelope.
 *
 * @param {{
 *   effect?: Record<string, unknown>,
 *   envelope?: Record<string, unknown>,
 *   toolName?: string,
 *   input?: Record<string, unknown>,
 *   projectRoot?: string,
 * }} args
 * @returns {PolicyResult}
 */
export function evaluate({ effect = {}, envelope = null, toolName = "", input = {}, projectRoot = "" } = {}) {
  const scope = /** @type {Record<string, unknown>} */ (envelope?.scope || {});
  const root =
    projectRoot ||
    /** @type {string} */ (envelope?.projectRoot || "") ||
    "";

  const env = effect.environment ? String(effect.environment) : null;
  const destructive = effect.destructive;
  const unknown = effect.unknown === true;
  const external = effect.external === true;
  const credential = effect.credential ? String(effect.credential) : null;
  const productionMode = String(scope.production || "deny").toLowerCase();
  const destructiveMode = String(scope.destructive || "ask").toLowerCase();
  const externalWritesMode = String(scope.externalWrites || "ask").toLowerCase();
  const filesystem = /** @type {string[]} */ (scope.filesystem || ["$PROJECT/**"]);
  const environments = /** @type {string[]} */ (scope.environments || []);
  const network = /** @type {string[]} */ (scope.network || []);
  const credentials = /** @type {string[]} */ (scope.credentials || []);

  // ── 1. Hard deny ──────────────────────────────────────────────
  if (productionMode === "deny" && env === "production") {
    return {
      decision: "DENY",
      reason: "Production environment is denied by authority envelope",
      rule: "hard-deny.production",
    };
  }

  if (credential) {
    const cred = authorizeCredential({
      resource: effect.service ? String(effect.service) : undefined,
      operation: effect.effect ? String(effect.effect) : undefined,
      credentialKind: credential,
      envelope: { credentials, scope: { credentials } },
    });
    if (cred.decision === "DENY") {
      return {
        decision: "DENY",
        reason: cred.reason,
        rule: credential === "production" || credential === "prod"
          ? "hard-deny.production-credentials"
          : "hard-deny.credentials",
      };
    }
  }

  if (
    destructive === true &&
    destructiveMode === "deny" &&
    (external || env === "production" || effect.service === "railway" || effect.service === "aws")
  ) {
    return {
      decision: "DENY",
      reason: "Destructive operations are denied by authority envelope",
      rule: "hard-deny.destructive",
    };
  }

  if (externalWritesMode === "deny" && external && (effect.effect === "write" || effect.effect === "delete" || effect.effect === "deploy" || effect.effect === "publish" || effect.effect === "push")) {
    return {
      decision: "DENY",
      reason: "External writes are denied by authority envelope",
      rule: "hard-deny.external-writes",
    };
  }

  // ── 2. Scope violation ────────────────────────────────────────
  if (effect.service === "filesystem" || effect.resourceType === "file") {
    const abs =
      /** @type {string|null} */ (effect.raw && /** @type {any} */ (effect.raw).path) ||
      (input && (input.file_path || input.path || input.filePath)) ||
      null;
    if (abs) {
      let resolved;
      try {
        resolved = root && !isAbsolute(String(abs)) ? resolve(root, String(abs)) : resolve(String(abs));
      } catch {
        resolved = null;
      }
      if (resolved && !pathInFilesystemScope(resolved, filesystem, root)) {
        // Outside project: DENY when clearly absolute/outside; ASK if ambiguous scope flag
        if (effect.scope === "outside-project" || effect.external === true) {
          return {
            decision: "DENY",
            reason: `Filesystem path outside project scope: ${resolved}`,
            rule: "scope.filesystem",
          };
        }
        return {
          decision: "ASK",
          reason: `Filesystem path not clearly inside $PROJECT: ${resolved}`,
          rule: "scope.filesystem-ambiguous",
        };
      }
    } else if (effect.scope === "outside-project") {
      return {
        decision: "DENY",
        reason: "Filesystem effect targets a path outside the project",
        rule: "scope.filesystem",
      };
    }
  }

  if (env && !envAllowed(env, environments) && env !== "development") {
    // production already hard-denied when production=deny; other envs not listed → scope
    if (env === "production" && productionMode === "ask") {
      // handled under authority expansion
    } else if (env !== "production") {
      return {
        decision: "DENY",
        reason: `Environment "${env}" is not in envelope.scope.environments`,
        rule: "scope.environment",
      };
    }
  }

  if (external && (effect.effect === "fetch" || effect.effect === "search" || effect.effect === "write" || effect.service === "http" || effect.service === "web")) {
    const host =
      (effect.service && !["http", "web", "bash", "filesystem"].includes(String(effect.service))
        ? null
        : null) ||
      (typeof effect.service === "string" && effect.service.includes(".") ? String(effect.service) : null);
    // Prefer host from raw command/url when present
    const rawCmd = /** @type {any} */ (effect.raw)?.command || input?.url || "";
    const hostMatch = String(rawCmd).match(/https?:\/\/([^/\s"'`]+)/i);
    const h = (hostMatch ? hostMatch[1].replace(/:\d+$/, "") : host)?.toLowerCase();

    if (h && network.length > 0 && !hostAllowed(h, network)) {
      return {
        decision: "DENY",
        reason: `Network host "${h}" is not in envelope.scope.network`,
        rule: "scope.network",
      };
    }
    if (h && network.length === 0 && (effect.effect === "write" || effect.effect === "delete")) {
      // empty allowlist: writes need ASK via externalWrites later; reads may proceed to allow/default
    }
  }

  if (credential && credential !== "production" && !credentialAllowed(credential, credentials)) {
    if (credential === "secret" || credential === "aws" || credential === "npm" || credential === "database") {
      // fall through to ASK as high-consequence / default rather than hard DENY
    } else {
      return {
        decision: "DENY",
        reason: `Credential kind "${credential}" is not permitted by envelope.scope.credentials`,
        rule: "scope.credentials",
      };
    }
  }

  // ── 3. Authority expansion ────────────────────────────────────
  // Staging-only envelope attempting production (when production=ask) or credential escalation.
  if (env === "production" && productionMode === "ask") {
    return {
      decision: "ASK",
      reason: "Authority expansion: staging-scoped session → production effect",
      rule: "authority-expansion.staging-to-production",
    };
  }

  if (
    credential &&
    (credential === "secret" || credential === "aws") &&
    !credentials.map((c) => String(c).toLowerCase()).includes(credential)
  ) {
    return {
      decision: "ASK",
      reason: `Authority expansion: credential discovery/use (${credential}) exceeds envelope`,
      rule: "authority-expansion.credentials",
    };
  }

  if (
    effect.effect === "delete" &&
    effect.service === "railway" &&
    (!envAllowed(env, environments) || env === "production")
  ) {
    return {
      decision: "DENY",
      reason: "Authority expansion blocked: production/destructive Railway volume or resource delete",
      rule: "authority-expansion.railway-destructive",
    };
  }

  // ── 4. High-consequence ───────────────────────────────────────
  if (unknown || destructive === null) {
    return {
      decision: "ASK",
      reason: "Unknown or ambiguous consequential effect requires confirmation",
      rule: "high-consequence.unknown",
    };
  }

  if (destructive === true) {
    if (destructiveMode === "ask") {
      return {
        decision: "ASK",
        reason: "Destructive effect requires confirmation (envelope.scope.destructive=ask)",
        rule: "high-consequence.destructive",
      };
    }
    if (destructiveMode === "allow") {
      // continue toward explicit allow
    }
  }

  if (external && (effect.effect === "write" || effect.effect === "delete" || effect.effect === "deploy" || effect.effect === "publish" || effect.effect === "push")) {
    if (externalWritesMode === "ask") {
      return {
        decision: "ASK",
        reason: "External write requires confirmation (envelope.scope.externalWrites=ask)",
        rule: "high-consequence.external-writes",
      };
    }
  }

  if (credential === "staging" && credentials.map((c) => String(c).toLowerCase()).includes("staging")) {
    // permitted — fall through
  } else if (credential && !credentialAllowed(credential, credentials)) {
    return {
      decision: "ASK",
      reason: `Credential use (${credential}) requires confirmation`,
      rule: "high-consequence.credentials",
    };
  }

  // ── 5. Explicit allow ─────────────────────────────────────────
  const benignFs =
    (effect.service === "filesystem" || effect.resourceType === "file") &&
    (effect.scope === "project" || effect.external === false) &&
    destructive !== true &&
    ["read", "write", "edit"].includes(String(effect.effect || ""));

  // A local, non-destructive, well-understood command is benign whichever
  // recognizer produced it. Restricting this to service==="bash" meant
  // `git status` and `npm test` fell through to the default ASK.
  const benignLocalShell =
    ["bash", "git", "npm"].includes(String(effect.service || "")) &&
    destructive === false &&
    unknown === false &&
    effect.external !== true;

  const stagingOk =
    env === "staging" &&
    envAllowed("staging", environments) &&
    destructive !== true &&
    effect.effect !== "delete";

  if (benignFs || benignLocalShell || stagingOk) {
    return {
      decision: "ALLOW",
      reason: benignFs
        ? "In-project non-destructive filesystem effect permitted"
        : stagingOk
          ? "Staging non-destructive effect permitted by envelope"
          : "Local non-destructive command permitted",
      rule: "explicit-allow.in-scope",
    };
  }

  if (destructive === true && destructiveMode === "allow" && env !== "production") {
    return {
      decision: "ALLOW",
      reason: "Destructive effect explicitly allowed by envelope",
      rule: "explicit-allow.destructive",
    };
  }

  // ── 6. Default ────────────────────────────────────────────────
  void toolName;
  return {
    decision: "ASK",
    reason: "No explicit allow rule matched; defaulting to ASK",
    rule: "default.ask",
  };
}
