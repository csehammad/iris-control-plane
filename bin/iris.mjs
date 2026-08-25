#!/usr/bin/env node
/**
 * Iris for Claude Code — local context & execution control plane
 *
 *   iris              Start proxy + UI
 *   iris init         Wire Claude Code (proxy URL, hooks, authority)
 *   iris hook         PreToolUse / PostToolUse stdin→stdout
 *   iris version
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/runtime/server.mjs";
import { createClaudeAdapter, HOOK_PATH } from "../src/adapters/claude/index.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`Iris for Claude Code
See what Claude carries. Control what Claude can do.

Usage:
  iris                     Start the proxy (http://127.0.0.1:8787)
  iris init                Configure this project for Claude Code
  iris hook                Run as Claude Code Pre/PostToolUse hook
  iris version

  After start: UI /__monitor  ·  guide /__guide

Env:
  PROXY_PORT              Listen port (default 8787)
  ANTHROPIC_PROXY_TARGET  Upstream (default https://api.anthropic.com)
  PROXY_REDACT=0          Disable at-rest redaction
  PROXY_REDACT_WIRE=1     Enable wire redaction + rehydration
  IRIS_UI_TOKEN           Require X-Iris-Token on mutating UI routes
  IRIS_HOME               Override ~/.iris
  IRIS_ENVELOPE_PATH      Authority envelope (default: ~/.iris/projects/<id>/sessions/authority.json)
  IRIS_ADAPTER            Host adapter (default: claude-code)
                          UI: open /__monitor?iris_token=… once when IRIS_UI_TOKEN is set
`);
}

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === "start" || cmd === "run") {
  startServer({});
} else if (cmd === "init") {
  const adapter = createClaudeAdapter({
    settingsPath: join(process.cwd(), ".claude", "settings.json"),
  });
  const result = adapter.install({ cwd: process.cwd() });
  console.log(`
Iris init complete (Claude Code)

  Project     ${result.name} (${result.id})
  Settings    ${result.settingsPath}
  Proxy URL   ${result.proxyUrl}
  Envelope    ${result.envelopePath}
  Guard hook  ${result.hookPath}

Bare tool denies remove schemas from Claude's context.
PreToolUse gates execution against the Task Authority Envelope.

Start:
  npx @zero-drift/iris

UI:    http://127.0.0.1:8787/__monitor
Guide: http://127.0.0.1:8787/__guide
`);
} else if (cmd === "hook") {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [HOOK_PATH, ...args.slice(1)], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 1);
} else if (cmd === "version" || cmd === "-v" || cmd === "--version") {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  console.log(`iris ${pkg.version} (Claude Code adapter)`);
} else if (cmd === "help" || cmd === "-h" || cmd === "--help") {
  usage();
} else {
  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}
