/**
 * Join Iris ledger rows to Claude Code OTel attributes when present.
 * Degrades gracefully — missing otel simply leaves attribution fields null.
 */

/**
 * @param {{
 *   requestId?: string|null,
 *   irisUid?: string|null,
 *   otelAttrs?: Record<string, any>|null,
 *   irisRecord?: Record<string, any>|null,
 * }} args
 * @returns {Record<string, any>}
 */
export function correlate({ requestId = null, irisUid = null, otelAttrs = null, irisRecord = null } = {}) {
  const otel = otelAttrs && typeof otelAttrs === "object" ? otelAttrs : null;
  const base = irisRecord && typeof irisRecord === "object" ? irisRecord : {};

  const pick = (...keys) => {
    if (!otel) return null;
    for (const k of keys) {
      if (otel[k] != null && otel[k] !== "") return otel[k];
      // dotted / attribute-map forms
      const attrs = otel.attributes ?? otel.attrs;
      if (attrs && typeof attrs === "object" && attrs[k] != null && attrs[k] !== "") return attrs[k];
    }
    return null;
  };

  const otelRequestId =
    pick("request_id", "requestId", "gen_ai.request.id", "rpc.request_id") ?? null;

  return {
    ...base,
    requestId: requestId ?? base.requestId ?? otelRequestId ?? null,
    irisUid: irisUid ?? base.uid ?? base.irisUid ?? null,
    otelPresent: !!otel,
    // Claude Code OTel surfaces (absent → null, never invented)
    querySource: pick("query_source", "querySource") ?? null,
    agentName: pick("agent.name", "agent_name", "agentName") ?? null,
    skillName: pick("skill.name", "skill_name", "skillName") ?? null,
    mcpServerName: pick("mcp_server.name", "mcp.server", "mcpServerName") ?? null,
    sessionId: pick("session.id", "session_id", "sessionId") ?? base.sessionId ?? null,
    otel: otel
      ? {
          requestId: otelRequestId,
          querySource: pick("query_source", "querySource"),
          agentName: pick("agent.name", "agent_name", "agentName"),
          skillName: pick("skill.name", "skill_name", "skillName"),
          mcpServerName: pick("mcp_server.name", "mcp.server", "mcpServerName"),
        }
      : null,
  };
}
