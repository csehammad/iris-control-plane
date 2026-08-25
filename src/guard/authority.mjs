/**
 * Task Authority Envelope — model proposes, user accepts, Iris enforces.
 * Persisted outside the model conversation. Discovery does not grant authority.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { migrateEnvelope, validateEnvelope } from "./policy-schema.mjs";

/** Default envelope for a local coding task. */
export const DEFAULT_ENVELOPE = Object.freeze({
  version: 1,
  task: "",
  acceptedAt: null,
  scope: Object.freeze({
    filesystem: Object.freeze(["$PROJECT/**"]),
    environments: Object.freeze(["staging"]),
    network: Object.freeze([]),
    destructive: "ask",
    production: "deny",
    credentials: Object.freeze(["staging"]),
    externalWrites: "ask",
  }),
});

/**
 * @param {{ task?: string, projectRoot?: string, projectName?: string }} args
 */
export function createEnvelope({ task = "", projectRoot = "", projectName = "" } = {}) {
  return {
    version: 1,
    task: String(task || ""),
    acceptedAt: null,
    projectRoot: projectRoot ? String(projectRoot) : undefined,
    projectName: projectName ? String(projectName) : undefined,
    scope: {
      filesystem: ["$PROJECT/**"],
      environments: ["staging"],
      network: [],
      destructive: "ask",
      production: "deny",
      credentials: ["staging"],
      externalWrites: "ask",
    },
  };
}

/**
 * Build a user-facing proposal: may / mayNot lists + envelope draft.
 * @param {{ task?: string, projectRoot?: string, projectName?: string }} args
 */
export function proposeEnvelope({ task = "", projectRoot = "", projectName = "" } = {}) {
  const name = projectName || (projectRoot ? projectRoot.split(/[/\\]/).filter(Boolean).pop() : "project");
  const envelope = createEnvelope({ task, projectRoot, projectName: name });

  const may = [
    `modify files inside ${name} ($PROJECT/**)`,
    "read project files and run local non-destructive tools",
    "execute tests and local build/dev commands",
    "use staging services and staging credentials",
    "install dependencies (when asked)",
  ];

  const mayNot = [
    "access production environments",
    "use production credentials",
    "modify resources outside this workspace",
    "perform destructive external operations without confirmation",
    "expand this authority envelope from model output",
  ];

  const summary = {
    title: "Task Authority Envelope",
    task: envelope.task || "(untitled task)",
    project: name,
    projectRoot: projectRoot || null,
    may,
    mayNot,
    ask: [
      "destructive operations (rm, drop, volume delete, force-push, …)",
      "external network writes outside an approved host list",
    ],
  };

  return { envelope, summary, may, mayNot };
}

/**
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
export function loadEnvelope(path) {
  if (!path || typeof path !== "string") {
    throw new Error("loadEnvelope requires a path");
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e.code === "ENOENT") throw new Error(`envelope not found: ${path}`);
    throw new Error(`failed to load envelope at ${path}: ${e.message}`);
  }

  const migrated = migrateEnvelope(raw);
  const { ok, errors } = validateEnvelope(migrated);
  if (!ok) {
    throw new Error(`invalid envelope at ${path}: ${errors.join("; ")}`);
  }
  return migrated;
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} envelope
 */
export function saveEnvelope(path, envelope) {
  if (!path || typeof path !== "string") {
    throw new Error("saveEnvelope requires a path");
  }
  const migrated = migrateEnvelope(envelope);
  const { ok, errors } = validateEnvelope(migrated);
  if (!ok) {
    throw new Error(`refusing to save invalid envelope: ${errors.join("; ")}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(migrated, null, 2) + "\n", "utf8");
  return migrated;
}

/**
 * Mark envelope accepted now (mutates a copy).
 * @param {Record<string, unknown>} envelope
 */
export function acceptEnvelope(envelope) {
  const next = migrateEnvelope(envelope);
  next.acceptedAt = new Date().toISOString();
  return next;
}

function asArray(v) {
  return Array.isArray(v) ? v.map(String) : [];
}

function modeRank(mode, kind) {
  const m = String(mode || "").toLowerCase();
  if (kind === "ada") {
    // allow > ask > deny
    if (m === "allow") return 2;
    if (m === "ask") return 1;
    return 0;
  }
  // production: ask > deny (no allow in schema)
  if (m === "ask") return 1;
  return 0;
}

function setExpands(prevList, nextList) {
  const prev = new Set(asArray(prevList).map((s) => s.toLowerCase()));
  for (const item of asArray(nextList)) {
    if (!prev.has(String(item).toLowerCase())) return true;
  }
  return false;
}

/**
 * True when `next` grants more authority than `prev`.
 * Model-proposed expansions must be rejected.
 *
 * @param {Record<string, unknown>|null|undefined} prev
 * @param {Record<string, unknown>|null|undefined} next
 */
export function canExpand(prev, next) {
  if (!next || typeof next !== "object") return false;
  if (!prev || typeof prev !== "object") return true; // any concrete authority from nothing

  const ps = /** @type {Record<string, unknown>} */ (prev.scope || {});
  const ns = /** @type {Record<string, unknown>} */ (next.scope || {});

  if (setExpands(ps.filesystem, ns.filesystem)) return true;
  if (setExpands(ps.environments, ns.environments)) return true;
  if (setExpands(ps.network, ns.network)) return true;
  if (setExpands(ps.credentials, ns.credentials)) return true;

  if (modeRank(ns.destructive, "ada") > modeRank(ps.destructive, "ada")) return true;
  if (modeRank(ns.production, "da") > modeRank(ps.production, "da")) return true;
  if (modeRank(ns.externalWrites, "ada") > modeRank(ps.externalWrites, "ada")) return true;

  // Broader task text alone is not expansion; scope is.
  return false;
}
