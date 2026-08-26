/**
 * Resolve data directories for the running Iris process.
 * Prefer project-local .claude/ for backward compatibility; optionally mirror to ~/.iris.
 */

import { mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorityPath,
  createProject,
  ensureIrisHome,
  getProjectPaths,
  migrateLegacyAuthority,
  projectIdFromPath,
  resolveProjectRoot,
} from "../config/projects.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function resolveRuntimePaths(opts = {}) {
  const projectRoot = resolve(opts.projectRoot || resolveProjectRoot(process.cwd()));
  const claudeDir = join(projectRoot, ".claude");
  const projectId = opts.projectId || projectIdFromPath(projectRoot);
  ensureIrisHome();
  const project = createProject(projectId, projectRoot);
  const irisPaths = getProjectPaths(projectId);

  // Prefer existing .claude data so migration is seamless.
  const useClaude = existsSync(claudeDir) || opts.preferClaude !== false;
  const dataDir = useClaude ? claudeDir : irisPaths.root;
  const logDir = process.env.PROXY_LOG_DIR || join(dataDir, useClaude ? "proxy-logs" : "payloads");
  mkdirSync(logDir, { recursive: true });

  const settingsPath =
    process.env.PROXY_SETTINGS_PATH || join(claudeDir, "settings.json");
  const historyPath = process.env.PROXY_HISTORY_PATH || join(dataDir, "history-index.json");
  const actionsPath = process.env.PROXY_ACTIONS_PATH || join(dataDir, "action-log.json");
  migrateLegacyAuthority(projectId);
  const decisionsPath = process.env.IRIS_DECISIONS_PATH || join(irisPaths.sessions, "decisions.json");
  const envelopePath = process.env.IRIS_ENVELOPE_PATH || authorityPath(projectId);
  const irisHtml =
    process.env.PROXY_IRIS_PATH || join(PKG_ROOT, "ui", "iris.html");
  const guideHtml = join(PKG_ROOT, "ui", "guide.html");
  /* Served to the browser as-is at /__pricing.mjs. Both UIs import their prices from
     this file rather than carrying a copy, so there is one price book, not three. */
  const pricingModule = join(PKG_ROOT, "src", "billing", "pricing.mjs");
  /* Same rule for the billing-mode table, served at /__plan.mjs: the UI labels its
     numbers from the same records the proxy classifies with. */
  const planModule = join(PKG_ROOT, "src", "billing", "plan.mjs");

  return {
    pkgRoot: PKG_ROOT,
    projectRoot,
    projectId,
    project,
    claudeDir,
    dataDir,
    logDir,
    settingsPath,
    historyPath,
    actionsPath,
    decisionsPath,
    envelopePath,
    irisHtml,
    pricingModule,
    planModule,
    guideHtml,
    irisPaths,
  };
}
