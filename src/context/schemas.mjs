/** Tool schema sizing and capture — extracted from proxy.mjs. Zero deps. */

export const estTokens = (str) => Math.round(String(str ?? "").length / 4);
export const fmt = (n) => Number(n).toLocaleString("en-US");

/** Rank tools in a request body by estimated schema tokens (desc). */
export function rankTools(body) {
  if (!body || !Array.isArray(body.tools) || body.tools.length === 0) return null;
  const rows = body.tools
    .map((t) => {
      const json = JSON.stringify(t);
      return { name: t.name ?? "(unnamed)", tokens: estTokens(json), bytes: json.length };
    })
    .sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  return { rows, total };
}

/**
 * In-memory store of tool schemas seen on the wire.
 * Kept out of SSE events on purpose — the same schemas re-ship every turn.
 */
export function createToolDocsStore() {
  const toolDocs = new Map(); // name -> { name, desc, schema, tokens, bytes }

  function captureToolDocs(body) {
    if (!Array.isArray(body?.tools)) return;
    for (const t of body.tools) {
      if (!t?.name) continue;
      const json = JSON.stringify(t);
      toolDocs.set(t.name, {
        name: t.name,
        desc: typeof t.description === "string" ? t.description : "",
        schema: t.input_schema ? JSON.stringify(t.input_schema, null, 2) : "",
        tokens: estTokens(json),
        bytes: json.length,
      });
    }
  }

  function list() {
    return [...toolDocs.values()].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  }

  return { toolDocs, captureToolDocs, list };
}

/** Default process-wide store (matches monolith singleton behaviour). */
const defaultStore = createToolDocsStore();
export const toolDocs = defaultStore.toolDocs;
export const captureToolDocs = defaultStore.captureToolDocs;
export const listToolDocs = defaultStore.list;

export class ToolDocsStore {
  constructor() {
    const s = createToolDocsStore();
    this.toolDocs = s.toolDocs;
    this.captureToolDocs = s.captureToolDocs;
    this.list = s.list;
  }
}
