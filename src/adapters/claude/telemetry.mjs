/**
 * Claude Code telemetry join points.
 * Prefer joining Claude's OTel (request_id, agent.name, skill, MCP) over rebuilding it.
 */

import { correlate } from "../../forensic/correlation.mjs";

/**
 * @param {{ session?: object, paths?: object, toolDocs?: { list: Function } }} ctx
 */
export function createClaudeTelemetry(ctx = {}) {
  return {
    getSessionMetadata() {
      return {
        host: "claude-code",
        sessionId: ctx.session?.id ?? null,
        startedAt: ctx.session?.startedAt ?? null,
        projectId: ctx.paths?.projectId ?? null,
        projectRoot: ctx.paths?.projectRoot ?? null,
        settingsPath: ctx.paths?.settingsPath ?? null,
        proxyPort: ctx.port ?? null,
      };
    },

    getToolMetadata(name) {
      const tools = typeof ctx.toolDocs?.list === "function" ? ctx.toolDocs.list() : [];
      return tools.find((t) => t.name === name) || null;
    },

    /**
     * Join Iris wire record with optional Claude OTel attrs.
     * Degrades gracefully when telemetry is absent.
     */
    joinOtel({ requestId, irisUid, otelAttrs, irisRecord } = {}) {
      return correlate({ requestId, irisUid, otelAttrs, irisRecord });
    },
  };
}
