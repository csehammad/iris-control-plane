/**
 * Claude Code adapter — the only v1 host implementation.
 *
 * Maps Claude Code primitives onto AgentAdapter:
 *   ANTHROPIC_BASE_URL proxy  → observeModelRequest/Response
 *   permissions.deny (bare)   → disableTool / enableTool (context removal)
 *   PreToolUse / PostToolUse  → beforeToolExecution / afterToolExecution
 *   settings.json + OTel join → getSessionMetadata / telemetry
 */

import { normalizeAdapter } from "../contract.mjs";
import { createClaudeSettings } from "./settings.mjs";
import { createClaudePermissions } from "./permissions.mjs";
import { createClaudeTelemetry } from "./telemetry.mjs";
import { handlePreToolUse, handlePostToolUse } from "./hooks.mjs";
import { installClaudeProject, HOOK_PATH } from "./install.mjs";
import { handleProxyRequest } from "../../runtime/proxy.mjs";

/**
 * @param {{
 *   settingsPath: string,
 *   session?: object,
 *   paths?: object,
 *   toolDocs?: object,
 *   port?: number,
 *   proxyCtx?: object,
 * }} opts
 */
export function createClaudeAdapter(opts = {}) {
  const settings = createClaudeSettings({ settingsPath: opts.settingsPath });
  const permissions = createClaudePermissions(settings);
  const telemetry = createClaudeTelemetry({
    session: opts.session,
    paths: opts.paths,
    toolDocs: opts.toolDocs,
    port: opts.port,
  });

  const seenTools = new Map();

  const adapter = normalizeAdapter({
    id: "claude-code",
    label: "Claude Code",
    capabilities: {
      modelProxy: true,
      bareDenyRemovesContext: true,
      scopedDenyKeepsContext: true,
      preToolUseHook: true,
      postToolUseHook: true,
      otelJoin: true,
      // Cursor-class hosts are intentionally unsupported until contracts are proven.
      cursorParity: false,
    },

    observeModelRequest(event) {
      if (Array.isArray(event?.preview?.tools)) {
        for (const t of event.preview.tools) {
          if (t?.name) seenTools.set(t.name, t);
        }
      }
      if (Array.isArray(event?.tools)) {
        for (const t of event.tools) {
          if (t?.name) seenTools.set(t.name, t);
        }
      }
    },

    observeModelResponse(_event) {
      /* billing/forensics handled by core ledgers; adapter stays thin */
    },

    listTools() {
      const fromDocs = typeof opts.toolDocs?.list === "function" ? opts.toolDocs.list() : [];
      if (fromDocs.length) return fromDocs;
      return [...seenTools.values()];
    },

    disableTool(name) {
      return permissions.disableTool(name);
    },

    enableTool(name) {
      return permissions.enableTool(name);
    },

    beforeToolExecution(payload, ctx) {
      return handlePreToolUse(payload, ctx);
    },

    afterToolExecution(payload, ctx) {
      return handlePostToolUse(payload, ctx);
    },

    getSessionMetadata() {
      return telemetry.getSessionMetadata();
    },

    getToolMetadata(name) {
      return telemetry.getToolMetadata(name) || seenTools.get(name) || null;
    },

    install(installOpts) {
      return installClaudeProject(installOpts || {});
    },

    /** Claude-specific helpers (not part of the generic contract). */
    host: {
      settings,
      permissions,
      telemetry,
      hookPath: HOOK_PATH,
      /** Forward Anthropic traffic; observation mode remains byte-identical. */
      handleProxyRequest,
      classifyRule: permissions.classifyRule.bind(permissions),
      joinOtel: telemetry.joinOtel.bind(telemetry),
      readDeny: () => permissions.listDenied(),
    },
  });

  return adapter;
}

export { HOOK_PATH, installClaudeProject };
export { handlePreToolUse, handlePostToolUse } from "./hooks.mjs";
