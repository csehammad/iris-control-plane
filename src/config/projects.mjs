/**
 * Multi-project Iris home under ~/.iris/projects/<id>/.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function irisHome() {
  return process.env.IRIS_HOME ? resolve(process.env.IRIS_HOME) : join(homedir(), ".iris");
}

/** Ensure ~/.iris and ~/.iris/projects exist. */
export function ensureIrisHome() {
  const home = irisHome();
  mkdirSync(join(home, "projects"), { recursive: true });
  return home;
}

/**
 * Walk up from cwd looking for a project root (.claude/settings.json or .git).
 * Falls back to cwd.
 */
export function resolveProjectRoot(cwd = process.cwd()) {
  let dir = resolve(cwd || process.cwd());
  for (;;) {
    if (existsSync(join(dir, ".claude", "settings.json"))) return dir;
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(cwd || process.cwd());
}

/**
 * Stable, filesystem-safe project id derived from an absolute path.
 * Prefers a readable slug; falls back to a short hash if the slug is empty/huge.
 */
export function projectIdFromPath(cwd) {
  const abs = resolve(cwd || process.cwd());
  const slug = abs
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9._+-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug && slug.length <= 120) return slug;
  return createHash("sha256").update(abs).digest("hex").slice(0, 16);
}

/**
 * @returns {{ root: string, payloads: string, sessions: string, exports: string, projectJson: string }}
 */
export function getProjectPaths(projectId) {
  if (!projectId || typeof projectId !== "string") throw new Error("getProjectPaths requires projectId");
  const root = join(ensureIrisHome(), "projects", projectId);
  return {
    root,
    payloads: join(root, "payloads"),
    sessions: join(root, "sessions"),
    exports: join(root, "exports"),
    projectJson: join(root, "project.json"),
  };
}

/** Canonical Task Authority Envelope path (init, server, and hook must agree). */
export function authorityPath(projectId) {
  return join(getProjectPaths(projectId).sessions, "authority.json");
}

/** Pre-1.0 location. Prefer sessions/authority.json. */
export function legacyAuthorityPath(projectId) {
  return join(ensureIrisHome(), "projects", projectId, "authority.json");
}

export function decisionsPath(projectId) {
  return join(getProjectPaths(projectId).sessions, "decisions.json");
}

/**
 * Copy a leftover project-root authority.json into sessions/ once.
 * If the canonical file already exists, leave it (that is the UI-accepted envelope).
 * @returns {{ path: string, migrated: boolean, from?: string }}
 */
export function migrateLegacyAuthority(projectId) {
  if (!projectId || typeof projectId !== "string") {
    throw new Error("migrateLegacyAuthority requires projectId");
  }
  const dest = authorityPath(projectId);
  const src = legacyAuthorityPath(projectId);
  if (existsSync(dest)) return { path: dest, migrated: false };
  if (!existsSync(src)) return { path: dest, migrated: false };
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.warn(`[iris] migrated authority envelope ${src} → ${dest}`);
  return { path: dest, migrated: true, from: src };
}

function defaultProjectMeta(projectId, cwd) {
  const abs = resolve(cwd || process.cwd());
  return {
    id: projectId,
    name: basename(abs) || projectId,
    cwd: abs,
    createdAt: new Date().toISOString(),
  };
}

/** Create project dirs + project.json if missing; return loaded metadata. */
export function createProject(projectId, cwd = process.cwd()) {
  const paths = getProjectPaths(projectId);
  mkdirSync(paths.payloads, { recursive: true });
  mkdirSync(paths.sessions, { recursive: true });
  mkdirSync(paths.exports, { recursive: true });
  if (!existsSync(paths.projectJson)) {
    const meta = defaultProjectMeta(projectId, cwd);
    writeFileSync(paths.projectJson, JSON.stringify(meta, null, 2) + "\n");
    return meta;
  }
  return loadProject(projectId);
}

/** Load project.json; create if absent. */
export function loadProject(projectId, cwd = process.cwd()) {
  const paths = getProjectPaths(projectId);
  try {
    const j = JSON.parse(readFileSync(paths.projectJson, "utf8"));
    if (j && typeof j === "object" && j.id) return j;
  } catch {
    /* create below */
  }
  return createProject(projectId, cwd);
}

/** Resolve cwd → project id, ensure on-disk layout, return { id, meta, paths }. */
export function ensureProject(cwd = process.cwd()) {
  const root = resolveProjectRoot(cwd);
  const id = projectIdFromPath(root);
  const meta = createProject(id, root);
  const paths = getProjectPaths(id);
  return { id, meta, paths, projectRoot: root };
}

/** True when path looks like an Iris project directory (has project.json). */
export function isProjectDir(dir) {
  try {
    return statSync(join(dir, "project.json")).isFile();
  } catch {
    return false;
  }
}
