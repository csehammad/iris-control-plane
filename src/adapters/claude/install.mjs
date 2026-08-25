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

function hookCommandLooksInstalled(raw) {
  const s = String(raw || "");
  return (
    (s.includes("bin/iris.mjs") && s.includes("hook")) ||
    s.includes("iris-agent hook") ||
    s.includes("adapters/claude/hooks.mjs") ||
    s.includes("guard/hook.mjs")
  );
}

function isLegacyHookCommand(raw) {
  const s = String(raw || "");
  return s.includes("adapters/claude/hooks.mjs") || s.includes("guard/hook.mjs");
}

function ensureHookEvent(list, hookCmd) {
  const arr = Array.isArray(list) ? list.map((entry) => {
    if (isLegacyHookCommand(JSON.stringify(entry))) {
      return { matcher: entry.matcher || "*", hooks: [{ type: "command", command: hookCmd }] };
    }
    return entry;
  }) : [];
  if (!arr.some((h) => hookCommandLooksInstalled(JSON.stringify(h)) && !isLegacyHookCommand(JSON.stringify(h)))) {
    arr.push({ matcher: "*", hooks: [{ type: "command", command: hookCmd }] });
  }
  return arr;
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
  settings.hooks.PreToolUse = ensureHookEvent(settings.hooks.PreToolUse, HOOK_CMD);
  settings.hooks.PostToolUse = ensureHookEvent(settings.hooks.PostToolUse, HOOK_CMD);

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
    envelopePath: envPath,
    hookPath: HOOK_PATH,
  };
}

export { HOOK_PATH };
