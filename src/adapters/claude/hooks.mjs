/**
 * Claude Code PreToolUse / PostToolUse hook entry for Iris Guard.
 *
 * CLI: `node hook.mjs` reads JSON from stdin, writes permission JSON to stdout, exit 0.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorityPath,
  decisionsPath,
  migrateLegacyAuthority,
  projectIdFromPath,
  resolveProjectRoot,
} from "../../config/projects.mjs";
import { loadEnvelope } from "../../guard/authority.mjs";
import { createDecisionLedger } from "../../guard/decisions.mjs";
import { normalizeEffect } from "../../guard/effects.mjs";
import { evaluate } from "../../guard/policy.mjs";
import { createTrajectoryTracker } from "../../guard/trajectory.mjs";

/**
 * Support common Claude Code hook payload shapes.
 * @param {Record<string, unknown>} payload
 */
export function extractToolCall(payload = {}) {
  const toolName =
    payload.tool_name ||
    payload.toolName ||
    payload.name ||
    /** @type {any} */ (payload.tool)?.name ||
    "";

  const toolInput =
    payload.tool_input ||
    payload.toolInput ||
    payload.input ||
    /** @type {any} */ (payload.tool)?.input ||
    {};

  const sessionId =
    payload.session_id ||
    payload.sessionId ||
    /** @type {any} */ (payload.context)?.sessionId ||
    null;

  const requestId =
    payload.request_id ||
    payload.requestId ||
    payload.tool_use_id ||
    payload.toolUseId ||
    null;

  const cwd =
    payload.cwd ||
    payload.working_directory ||
    /** @type {any} */ (payload.context)?.cwd ||
    process.cwd();

  const hookEvent =
    payload.hook_event_name ||
    payload.hookEventName ||
    payload.event ||
    "PreToolUse";

  return {
    toolName: String(toolName || ""),
    toolInput: toolInput && typeof toolInput === "object" ? toolInput : {},
    sessionId: sessionId ? String(sessionId) : null,
    requestId: requestId ? String(requestId) : null,
    cwd: String(cwd || process.cwd()),
    hookEvent: String(hookEvent),
  };
}

/**
 * Resolve authority.json path.
 * @param {{ cwd?: string, envelopePath?: string|null }} args
 */
export function resolveEnvelopePath({ cwd = process.cwd(), envelopePath = null } = {}) {
  if (envelopePath) return resolve(envelopePath);
  if (process.env.IRIS_ENVELOPE_PATH) return resolve(process.env.IRIS_ENVELOPE_PATH);
  const root = resolveProjectRoot(cwd);
  const id = projectIdFromPath(root);
  migrateLegacyAuthority(id);
  return authorityPath(id);
}

/**
 * Map policy decision → Claude Code permission fields (+ legacy aliases).
 * @param {'ALLOW'|'ASK'|'DENY'|string} decision
 * @param {string} reason
 */
export function toHookResponse(decision, reason) {
  const d = String(decision || "ASK").toUpperCase();
  let permissionDecision = "ask";
  let legacy = "ask";
  if (d === "ALLOW") {
    permissionDecision = "allow";
    legacy = "approve";
  } else if (d === "DENY") {
    permissionDecision = "deny";
    legacy = "block";
  } else {
    permissionDecision = "ask";
    legacy = "ask";
  }

  return {
    permissionDecision,
    permissionDecisionReason: reason || "",
    // Older Claude Code / docs aliases
    decision: legacy,
    reason: reason || "",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason || "",
    },
  };
}

/**
 * @param {Record<string, unknown>} payload
 * @param {{
 *   envelope?: Record<string, unknown>|null,
 *   envelopePath?: string|null,
 *   projectRoot?: string|null,
 *   ledger?: ReturnType<typeof createDecisionLedger>|null,
 *   ledgerPath?: string|null,
 *   trajectory?: ReturnType<typeof createTrajectoryTracker>|null,
 * }} [ctx]
 */
export function handlePreToolUse(payload, ctx = {}) {
  const call = extractToolCall(payload || {});
  const projectRoot = resolve(ctx.projectRoot || call.cwd || process.cwd());

  let envelope = ctx.envelope || null;
  if (!envelope) {
    const path = resolveEnvelopePath({ cwd: projectRoot, envelopePath: ctx.envelopePath || null });
    if (existsSync(path)) {
      try {
        envelope = loadEnvelope(path);
      } catch (err) {
        const reason = `Failed to load authority envelope: ${/** @type {Error} */ (err).message}`;
        const response = toHookResponse("DENY", reason);
        return {
          ...response,
          effect: null,
          evaluation: { decision: "DENY", reason, rule: "hook.envelope-load" },
          call,
        };
      }
    } else {
      // No envelope yet — fail closed to ASK (never silent allow for consequential tools)
      envelope = {
        version: 1,
        task: "(no envelope)",
        acceptedAt: null,
        projectRoot,
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
  }

  const effect = normalizeEffect({
    toolName: call.toolName,
    input: call.toolInput,
    projectRoot,
  });

  const evaluation = evaluate({
    effect,
    envelope,
    toolName: call.toolName,
    input: call.toolInput,
    projectRoot,
  });

  let ledger = ctx.ledger || null;
  if (!ledger) {
    try {
      const ledgerPath = ctx.ledgerPath || defaultLedgerPath(projectRoot, ctx.envelopePath);
      ledger = createDecisionLedger({ path: ledgerPath });
    } catch {
      ledger = null;
    }
  }

  if (ledger) {
    try {
      ledger.append({
        tool: call.toolName,
        decision: evaluation.decision,
        reason: evaluation.reason,
        effect,
        sessionId: call.sessionId,
        requestId: call.requestId,
        rule: evaluation.rule,
      });
    } catch {
      /* ledger is best-effort; never block the gate decision */
    }
  }

  if (ctx.trajectory) {
    ctx.trajectory.observe({ effect, decision: evaluation, failure: evaluation.decision === "DENY" });
  }

  const response = toHookResponse(evaluation.decision, evaluation.reason);
  return { ...response, effect, evaluation, call, envelope };
}

/**
 * PostToolUse — record outcomes / trajectory failures; always allow continuation.
 * @param {Record<string, unknown>} payload
 * @param {{
 *   projectRoot?: string|null,
 *   ledger?: ReturnType<typeof createDecisionLedger>|null,
 *   ledgerPath?: string|null,
 *   trajectory?: ReturnType<typeof createTrajectoryTracker>|null,
 * }} [ctx]
 */
export function handlePostToolUse(payload, ctx = {}) {
  const call = extractToolCall(payload || {});
  const projectRoot = resolve(ctx.projectRoot || call.cwd || process.cwd());

  const toolResponse =
    /** @type {any} */ (payload).tool_response ||
    /** @type {any} */ (payload).toolResponse ||
    /** @type {any} */ (payload).response ||
    null;

  const failure =
    /** @type {any} */ (payload).is_error === true ||
    /** @type {any} */ (payload).error != null ||
    (typeof toolResponse === "string" && /error|denied|unauthorized|forbidden|failed/i.test(toolResponse));

  const effect = normalizeEffect({
    toolName: call.toolName,
    input: call.toolInput,
    projectRoot,
  });

  if (ctx.trajectory) {
    ctx.trajectory.observe({
      effect,
      decision: failure ? "FAIL" : "ALLOW",
      failure,
    });
  }

  const ledger =
    ctx.ledger ||
    (ctx.ledgerPath ? createDecisionLedger({ path: ctx.ledgerPath }) : null);

  if (ledger) {
    ledger.append({
      tool: call.toolName,
      decision: failure ? "FAIL" : "OBSERVE",
      reason: failure ? "PostToolUse reported failure" : "PostToolUse observed",
      effect,
      sessionId: call.sessionId,
      requestId: call.requestId,
      rule: "hook.post",
    });
  }

  return {
    continue: true,
    effect,
    failure: Boolean(failure),
    call,
    signals: ctx.trajectory ? ctx.trajectory.signals() : [],
  };
}

/**
 * @param {string} projectRoot
 * @param {string|null|undefined} envelopePath
 */
function defaultLedgerPath(projectRoot, envelopePath = null) {
  if (process.env.IRIS_LEDGER_PATH) return resolve(process.env.IRIS_LEDGER_PATH);

  const envPath = envelopePath || process.env.IRIS_ENVELOPE_PATH || null;
  if (envPath) {
    const path = join(dirname(resolve(envPath)), "decisions.json");
    mkdirSync(dirname(path), { recursive: true });
    return path;
  }

  const id = projectIdFromPath(resolveProjectRoot(projectRoot));
  const path = decisionsPath(id);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/**
 * Read stdin fully.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolvePromise(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  let payload = {};
  try {
    const raw = await readStdin();
    if (raw && raw.trim()) payload = JSON.parse(raw);
  } catch (err) {
    const response = toHookResponse("ASK", `Invalid hook stdin JSON: ${/** @type {Error} */ (err).message}`);
    process.stdout.write(JSON.stringify(response) + "\n");
    process.exit(0);
    return;
  }

  const event = String(
    /** @type {any} */ (payload).hook_event_name ||
      /** @type {any} */ (payload).hookEventName ||
      /** @type {any} */ (payload).event ||
      "PreToolUse",
  );

  try {
    if (/post/i.test(event)) {
      const result = handlePostToolUse(payload);
      process.stdout.write(
        JSON.stringify({
          continue: true,
          permissionDecision: "allow",
          permissionDecisionReason: result.failure ? "PostToolUse failure recorded" : "PostToolUse recorded",
          decision: "approve",
          reason: result.failure ? "PostToolUse failure recorded" : "PostToolUse recorded",
        }) + "\n",
      );
    } else {
      const result = handlePreToolUse(payload);
      process.stdout.write(
        JSON.stringify({
          permissionDecision: result.permissionDecision,
          permissionDecisionReason: result.permissionDecisionReason,
          decision: result.decision,
          reason: result.reason,
          hookSpecificOutput: result.hookSpecificOutput,
        }) + "\n",
      );
    }
  } catch (err) {
    const response = toHookResponse("ASK", `Guard hook error: ${/** @type {Error} */ (err).message}`);
    process.stdout.write(JSON.stringify(response) + "\n");
  }
  process.exit(0);
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}
