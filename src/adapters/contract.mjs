/**
 * AgentAdapter — host-agnostic contracts for coding-agent control planes.
 *
 * Iris core (context, billing, policy, authority, forensics, UI) must not
 * branch on host product names. Host-specific wiring lives in adapters.
 *
 * Marketing niche for v1: Claude Code.
 * Internal architecture: adapters (Claude now; Cursor only when contracts are real).
 *
 * @typedef {object} AgentAdapter
 * @property {string} id                          e.g. "claude-code"
 * @property {string} label                       human label
 * @property {(req: object) => void|Promise<void>} [observeModelRequest]
 * @property {(res: object) => void|Promise<void>} [observeModelResponse]
 * @property {() => Promise<object[]>|object[]} [listTools]
 * @property {(name: string) => Promise<object>|object} disableTool
 * @property {(name: string) => Promise<object>|object} enableTool
 * @property {(payload: object, ctx?: object) => object} beforeToolExecution
 * @property {(payload: object, ctx?: object) => object} afterToolExecution
 * @property {() => object} getSessionMetadata
 * @property {(name: string) => object|null} [getToolMetadata]
 * @property {(opts?: object) => object|Promise<object>} [install]  project wiring
 * @property {object} [capabilities]  feature flags this host actually supports
 */

export const ADAPTER_METHODS = Object.freeze([
  "observeModelRequest",
  "observeModelResponse",
  "listTools",
  "disableTool",
  "enableTool",
  "beforeToolExecution",
  "afterToolExecution",
  "getSessionMetadata",
  "getToolMetadata",
]);

/**
 * Soft-validate an adapter. Missing optional methods are filled with no-ops.
 * Required: id, disableTool, enableTool, beforeToolExecution, afterToolExecution, getSessionMetadata.
 * @param {Partial<AgentAdapter>} adapter
 * @returns {AgentAdapter}
 */
export function normalizeAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("normalizeAdapter requires an adapter object");
  }
  if (!adapter.id) throw new Error("adapter.id is required");
  for (const m of ["disableTool", "enableTool", "beforeToolExecution", "afterToolExecution", "getSessionMetadata"]) {
    if (typeof adapter[m] !== "function") {
      throw new Error(`adapter.${m} is required`);
    }
  }
  return {
    label: adapter.label || adapter.id,
    observeModelRequest: adapter.observeModelRequest || (() => {}),
    observeModelResponse: adapter.observeModelResponse || (() => {}),
    listTools: adapter.listTools || (() => []),
    getToolMetadata: adapter.getToolMetadata || (() => null),
    install: adapter.install || (() => ({ ok: false, error: "install not supported" })),
    capabilities: adapter.capabilities || {},
    ...adapter,
  };
}
