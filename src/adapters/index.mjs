/**
 * Resolve the active AgentAdapter.
 * v1 ships Claude Code only. Future hosts register here without touching core.
 */

import { createClaudeAdapter } from "./claude/index.mjs";

const REGISTRY = {
  "claude-code": createClaudeAdapter,
  claude: createClaudeAdapter,
};

/**
 * @param {string} [id]
 * @param {object} [opts]
 */
export function resolveAdapter(id = process.env.IRIS_ADAPTER || "claude-code", opts = {}) {
  const key = String(id || "claude-code").toLowerCase();
  const factory = REGISTRY[key];
  if (!factory) {
    const known = Object.keys(REGISTRY).join(", ");
    throw new Error(`Unknown adapter "${id}". v1 supports: ${known}. Cursor is not promised until contracts are proven.`);
  }
  return factory(opts);
}

export { createClaudeAdapter } from "./claude/index.mjs";
export { normalizeAdapter, ADAPTER_METHODS } from "./contract.mjs";
