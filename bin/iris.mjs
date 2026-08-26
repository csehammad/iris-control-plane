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
  iris [--port N]          Start the proxy (http://127.0.0.1:8787)
  iris init [--port N]     Configure this project for Claude Code
  iris hook                Run as Claude Code Pre/PostToolUse hook
  iris version

  After start: UI /__monitor  ·  guide /__guide

Running more than one project? Start each in its own directory. If 8787 is
taken, Iris moves to the next free port and tells you to re-run init there.

Env:
  PROXY_PORT              Listen port (default 8787; explicit = never auto-moved)
  ANTHROPIC_PROXY_TARGET  Upstream (default https://api.anthropic.com)
  PROXY_REDACT=0          Disable at-rest redaction
  PROXY_REDACT_WIRE=1     Enable wire redaction + rehydration
  IRIS_UI_TOKEN           Require X-Iris-Token on mutating UI routes
  IRIS_HOME               Override ~/.iris
  IRIS_ENVELOPE_PATH      Authority envelope (default: ~/.iris/projects/<id>/sessions/authority.json)
  IRIS_ADAPTER            Host adapter (default: claude-code)
  IRIS_AUTOWIRE=0         Do not keep ANTHROPIC_BASE_URL on the bound port
                          UI: open /__monitor?iris_token=… once when IRIS_UI_TOKEN is set
`);
}

const args = process.argv.slice(2);
const cmd = args[0];

/** `--port 8788` or `--port=8788`; returns null when absent or not a number. */
function portArg(argv) {
  const i = argv.findIndex((a) => a === "--port" || a === "-p");
  if (i !== -1 && argv[i + 1] && /^\d+$/.test(argv[i + 1])) return Number(argv[i + 1]);
  const inline = argv.find((a) => /^--port=\d+$/.test(a));
  return inline ? Number(inline.split("=")[1]) : null;
}

/**
 * Find a running Iris that is already serving this project, so `init` writes
 * the port that instance actually bound rather than assuming 8787.
 * @param {string} projectRoot
 */
async function discoverPort(projectRoot) {
  const candidates = Array.from({ length: 12 }, (_, i) => 8787 + i);
  const metas = await Promise.all(
    candidates.map(async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/__meta`, {
          signal: AbortSignal.timeout(400),
        });
        if (!res.ok) return null;
        const meta = await res.json();
        return meta?.projectId ? { port, meta } : null;
      } catch {
        // FALLBACK-GUARD: INTENTIONAL — nothing listening, or not Iris
        return null;
      }
    })
  );
  const live = metas.filter(Boolean);
  const mine = live.find((m) => m.meta.cwd === projectRoot);
  return mine ? mine.port : null;
}

if (!cmd || cmd === "start" || cmd === "run") {
  const port = portArg(args);
  startServer(port ? { port } : {});
} else if (cmd === "init") {
  const cwd = process.cwd();
  const explicit = portArg(args);
  const discovered = explicit == null ? await discoverPort(cwd) : null;
  const port = explicit ?? discovered ?? Number(process.env.PROXY_PORT || 8787);

  const adapter = createClaudeAdapter({
    settingsPath: join(cwd, ".claude", "settings.json"),
    port,
  });
  const result = adapter.install({ cwd, port });

  const hookNote = {
    installed: "installed",
    refreshed: "path refreshed to this copy of Iris",
    unchanged: "already correct",
  }[result.hookAction] || "installed";

  const baseUrlNote = {
    set: "written",
    repointed: `re-pointed from ${result.previousBaseUrl}`,
    kept: "already correct",
    external: `left as ${result.previousBaseUrl} — not a local Iris URL, so Iris did not touch it`,
  }[result.baseUrlAction] || "written";

  console.log(`
Iris init complete (Claude Code)

  Project     ${result.name} (${result.id})
  Settings    ${result.settingsPath}
  Proxy URL   ${result.proxyUrl}  (${baseUrlNote})${
    discovered ? `\n  Port        ${port} — discovered a running Iris for this project` : ""
  }
  Envelope    ${result.envelopePath}
  Guard hook  ${result.hookPath}  (${hookNote})

Bare tool denies remove schemas from Claude's context.
PreToolUse gates execution against the Task Authority Envelope.
${result.baseUrlAction === "external" ? "\n! Claude Code is NOT pointed at Iris. Set env.ANTHROPIC_BASE_URL yourself if that is not deliberate.\n" : ""}
Start:
  npx @hammadulhaq/iris${port === 8787 ? "" : ` --port ${port}`}

UI:    http://127.0.0.1:${port}/__monitor
Guide: http://127.0.0.1:${port}/__guide
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
