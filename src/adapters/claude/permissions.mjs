/**
 * Claude Code permission surface for Optimize.
 *
 * Bare-name deny  → tool schema removed from context (Iris Optimize path).
 * Scoped deny     → tool may remain visible; particular executions blocked by Claude Code.
 */

/**
 * @param {ReturnType<import('./settings.mjs').createClaudeSettings>} settings
 */
export function createClaudePermissions(settings) {
  return {
    /** Tools currently barred from context via bare deny. */
    listDenied() {
      return settings.readDeny();
    },

    /**
     * Remove tool from Claude's context (bare deny).
     * Subsequent /v1/messages requests should omit the schema — Iris proves this on the wire.
     */
    disableTool(name) {
      return settings.setToolDenied(name, true);
    },

    /** Restore tool to context by removing bare deny. */
    enableTool(name) {
      return settings.setToolDenied(name, false);
    },

    /**
     * Explain how a deny rule affects context vs execution.
     * @param {string|object} rule
     */
    classifyRule(rule) {
      if (typeof rule === "string") {
        return {
          kind: "bare",
          tool: rule,
          removesFromContext: true,
          blocksExecution: true,
          note: "Bare deny removes the tool schema from Claude's context entirely.",
        };
      }
      return {
        kind: "scoped",
        rule,
        removesFromContext: false,
        blocksExecution: true,
        note: "Scoped deny can leave the tool visible while blocking particular executions.",
      };
    },
  };
}
