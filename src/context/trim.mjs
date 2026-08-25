/**
 * Trim simulator — schemas that ship every turn but were never called.
 * Matches the Iris Optimize "enabled but never called" logic.
 */

/**
 * @param {{ tools: Array<{name:string,tokens?:number}>, callCounts?: Record<string,number>|Map, denySet?: Iterable<string>|Set }} args
 * @returns {{ removable: Array<{name:string,tokens:number,calls:number}>, potentialTokens: number }}
 */
export function simulateTrim({ tools, callCounts, denySet } = {}) {
  const denied = denySet instanceof Set ? denySet : new Set(denySet ?? []);
  const counts =
    callCounts instanceof Map
      ? callCounts
      : new Map(Object.entries(callCounts ?? {}));

  const list = Array.isArray(tools) ? tools : [];
  const removable = [];
  for (const t of list) {
    if (!t?.name) continue;
    if (denied.has(t.name)) continue;
    const tokens = Number(t.tokens) || 0;
    if (tokens <= 0) continue;
    const calls = Number(counts.get(t.name) ?? t.calls ?? 0) || 0;
    if (calls !== 0) continue;
    removable.push({ name: t.name, tokens, calls });
  }
  removable.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  const potentialTokens = removable.reduce((s, r) => s + r.tokens, 0);
  return { removable, potentialTokens };
}
