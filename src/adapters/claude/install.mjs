/**
 * Wire a project for Iris × Claude Code:
 * ANTHROPIC_BASE_URL, PreToolUse/PostToolUse hooks, deny list, authority draft.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorityPath,
  ensureProject,
  irisHome,
  migrateLegacyAuthority,
  resolveProjectRoot,
} from "../../config/projects.mjs";
import { proposeEnvelope, saveEnvelope } from "../../guard/authority.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI_PATH = join(PKG_ROOT, "bin", "iris.mjs");
const HOOK_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "hooks.mjs");
const HOOK_CMD = `node "${CLI_PATH}" hook`;

/**
 * Any command that runs Iris as a hook, wherever that copy of Iris lives —
 * current layout, the pre-1.0 entry points, or the old `iris-agent` binary.
 * @param {unknown} raw
 */
export function isIrisHookCommand(raw) {
  const s = String(raw || "");
  return (
    (s.includes("iris.mjs") && s.includes("hook")) ||
    s.includes("iris-agent hook") ||
    s.includes("adapters/claude/hooks.mjs") ||
    s.includes("guard/hook.mjs")
  );
}

/**
 * Point every Iris hook at the copy of Iris being run right now, and add one
 * if the project has none.
 *
 * A hook command is an absolute path, and the path moves: `npx` resolves into
 * a cache directory that is pruned and re-created under a new hash, a global
 * install moves with the Node version, a checkout gets relocated. Treating
 * "some Iris hook exists" as "nothing to do" left projects pointing at a
 * deleted interpreter path, and re-running init could not repair it — the
 * exact situation this function now fixes.
 *
 * Hooks that are not Iris are left untouched, including ones sharing an entry
 * with an Iris hook. A second, redundant Iris hook is dropped rather than
 * rewritten, so the hook cannot end up running twice per tool call.
 *
 * @param {unknown} list
 * @param {string} hookCmd
 * @returns {{ hooks: object[], action: "installed"|"refreshed"|"unchanged" }}
 */
function ensureHookEvent(list, hookCmd) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  let installed = false;
  let changed = false;

  for (const entry of arr) {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
    if (!hooks.some((h) => isIrisHookCommand(h?.command))) {
      out.push(entry);
      continue;
    }
    const next = [];
    for (const h of hooks) {
      if (!isIrisHookCommand(h?.command)) {
        next.push(h);
        continue;
      }
      if (installed) {
        changed = true; // redundant duplicate — drop it
        continue;
      }
      installed = true;
      if (h?.command !== hookCmd || h?.type !== "command") changed = true;
      next.push({ ...h, type: "command", command: hookCmd });
    }
    if (next.length) out.push({ ...entry, matcher: entry.matcher || "*", hooks: next });
    else changed = true;
  }

  if (!installed) {
    out.push({ matcher: "*", hooks: [{ type: "command", command: hookCmd }] });
    return { hooks: out, action: "installed" };
  }
  return { hooks: out, action: changed ? "refreshed" : "unchanged" };
}

function ensureGitignore(projectRoot) {
  const gi = join(projectRoot, ".gitignore");
  const lines = [
    ".claude/proxy-logs/",
    ".claude/history-index.json",
    ".claude/action-log.json",
    ".claude/proxy-run.log",
  ];
  let existing = "";
  try {
    existing = readFileSync(gi, "utf8");
  } catch {
    // FALLBACK-GUARD: INTENTIONAL — missing .gitignore is created below
  }
  const add = lines.filter((l) => !existing.includes(l));
  if (add.length) {
    appendFileSync(gi, (existing && !existing.endsWith("\n") ? "\n" : "") + add.join("\n") + "\n");
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * True when a base URL points at a local Iris rather than a deliberate custom
 * upstream. Only these are safe to re-point when the port moves.
 * @param {unknown} url
 */
function isLocalIrisUrl(url) {
  try {
    return LOOPBACK_HOSTS.has(new URL(String(url)).hostname);
  } catch {
    // FALLBACK-GUARD: INTENTIONAL — unparseable value is left alone
    return false;
  }
}

/**
 * @param {{ cwd?: string, proxyUrl?: string, port?: number|string }} opts
 */
export function installClaudeProject(opts = {}) {
  const projectRoot = resolveProjectRoot(opts.cwd || process.cwd());
  const { id, meta, paths } = ensureProject(projectRoot);
  const claudeDir = join(projectRoot, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  const port = Number(opts.port ?? process.env.PROXY_PORT ?? 8787);
  const proxyUrl = opts.proxyUrl || `http://127.0.0.1:${port}`;

  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    // FALLBACK-GUARD: INTENTIONAL — first install; settings.json may not exist yet
    settings = {};
  }

  settings.env = settings.env || {};
  // A stale loopback URL is worse than no URL: it silently routes this
  // project's traffic into whichever Iris instance holds that port, which
  // records it under a different project and evaluates Guard against a
  // different envelope and project root. Re-point those; leave a custom
  // (non-loopback) upstream exactly as the user set it.
  const previousBaseUrl = settings.env.ANTHROPIC_BASE_URL;
  let baseUrlAction = "kept";
  if (!previousBaseUrl) {
    settings.env.ANTHROPIC_BASE_URL = proxyUrl;
    baseUrlAction = "set";
  } else if (previousBaseUrl !== proxyUrl && isLocalIrisUrl(previousBaseUrl)) {
    settings.env.ANTHROPIC_BASE_URL = proxyUrl;
    baseUrlAction = "repointed";
  } else if (previousBaseUrl !== proxyUrl) {
    baseUrlAction = "external";
  }
  settings.env.IRIS_HOME = settings.env.IRIS_HOME || irisHome();
  settings.permissions = settings.permissions || {};
  if (!Array.isArray(settings.permissions.deny)) settings.permissions.deny = [];

  settings.hooks = settings.hooks || {};
  const pre = ensureHookEvent(settings.hooks.PreToolUse, HOOK_CMD);
  const post = ensureHookEvent(settings.hooks.PostToolUse, HOOK_CMD);
  settings.hooks.PreToolUse = pre.hooks;
  settings.hooks.PostToolUse = post.hooks;
  // "refreshed" outranks "installed": a moved path is the notable event, and a
  // genuine first install refreshes nothing, so it still reports "installed".
  const hookAction =
    pre.action === "refreshed" || post.action === "refreshed"
      ? "refreshed"
      : pre.action === "installed" || post.action === "installed"
        ? "installed"
        : "unchanged";

  mkdirSync(paths.sessions, { recursive: true });
  migrateLegacyAuthority(id);
  const envPath = authorityPath(id);
  settings.env.IRIS_ENVELOPE_PATH = envPath;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  writeFileSync(
    join(claudeDir, "iris-project.json"),
    JSON.stringify(
      {
        id,
        name: meta.name,
        root: projectRoot,
        host: "claude-code",
        createdAt: meta.createdAt || new Date().toISOString(),
        policySchema: 1,
      },
      null,
      2
    ) + "\n"
  );

  if (!existsSync(envPath)) {
    const { envelope } = proposeEnvelope({
      task: "",
      projectRoot,
      projectName: meta.name,
    });
    saveEnvelope(envPath, envelope);
  }

  ensureGitignore(projectRoot);

  return {
    ok: true,
    host: "claude-code",
    id,
    name: meta.name,
    settingsPath,
    proxyUrl: settings.env.ANTHROPIC_BASE_URL,
    baseUrlAction,
    previousBaseUrl: previousBaseUrl || null,
    hookAction,
    hookCommand: HOOK_CMD,
    envelopePath: envPath,
    hookPath: HOOK_PATH,
  };
}

export { HOOK_PATH };
