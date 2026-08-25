// Shared Anthropic list prices (USD per 1M tokens), matching iris/ui/iris.html.
// Sorted longest-id-first so prefix matching picks the most specific model id.
export const PRICE_BOOK = [
  { id: "claude-fable-5",    label: "Fable 5",    in: 10,   cw5: 12.50, cw1: 20,   cr: 1,    out: 50 },
  { id: "claude-mythos-5",   label: "Mythos 5",   in: 10,   cw5: 12.50, cw1: 20,   cr: 1,    out: 50 },
  { id: "claude-opus-5",     label: "Opus 5",     in: 5,    cw5: 6.25,  cw1: 10,   cr: 0.50, out: 25 },
  { id: "claude-opus-4-8",   label: "Opus 4.8",   in: 5,    cw5: 6.25,  cw1: 10,   cr: 0.50, out: 25 },
  { id: "claude-opus-4-7",   label: "Opus 4.7",   in: 5,    cw5: 6.25,  cw1: 10,   cr: 0.50, out: 25 },
  { id: "claude-opus-4-6",   label: "Opus 4.6",   in: 5,    cw5: 6.25,  cw1: 10,   cr: 0.50, out: 25 },
  { id: "claude-opus-4-5",   label: "Opus 4.5",   in: 5,    cw5: 6.25,  cw1: 10,   cr: 0.50, out: 25 },
  { id: "claude-opus-4-1",   label: "Opus 4.1",   in: 15,   cw5: 18.75, cw1: 30,   cr: 1.50, out: 75 },
  { id: "claude-opus-4",     label: "Opus 4",     in: 15,   cw5: 18.75, cw1: 30,   cr: 1.50, out: 75 },
  /* Sonnet 5 runs at introductory pricing through 2026-08-31, then steps up. */
  { id: "claude-sonnet-5",   label: "Sonnet 5",   in: 2,    cw5: 2.50,  cw1: 4,    cr: 0.20, out: 10,
    until: "2026-09-01T00:00:00Z", after: { in: 3, cw5: 3.75, cw1: 6, cr: 0.30, out: 15 } },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", in: 3,    cw5: 3.75,  cw1: 6,    cr: 0.30, out: 15 },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5", in: 3,    cw5: 3.75,  cw1: 6,    cr: 0.30, out: 15 },
  { id: "claude-sonnet-4",   label: "Sonnet 4",   in: 3,    cw5: 3.75,  cw1: 6,    cr: 0.30, out: 15 },
  { id: "claude-haiku-4-5",  label: "Haiku 4.5",  in: 1,    cw5: 1.25,  cw1: 2,    cr: 0.10, out: 5 },
  { id: "claude-haiku-3-5",  label: "Haiku 3.5",  in: 0.80, cw5: 1,     cw1: 1.60, cr: 0.08, out: 4 },
].sort((a, b) => b.id.length - a.id.length);

function toRates(row) {
  return {
    input: row.in,
    output: row.out,
    cacheRead: row.cr,
    cw5m: row.cw5,
    cw1h: row.cw1,
  };
}

/**
 * Longest-id-first prefix match against PRICE_BOOK.
 * @param {string|null|undefined} model
 * @returns {{ input: number, output: number, cacheRead: number, cw5m: number, cw1h: number }|null}
 */
export function rateFor(model) {
  if (!model) return null;
  // strip a beta/context suffix ("claude-opus-5[1m]") and any dated snapshot
  const id = String(model).toLowerCase().replace(/\[.*$/, "");
  const hit = PRICE_BOOK.find((r) => id.startsWith(r.id));
  if (!hit) return null;
  let row = { in: hit.in, cw5: hit.cw5, cw1: hit.cw1, cr: hit.cr, out: hit.out };
  if (hit.until && Date.now() >= Date.parse(hit.until)) Object.assign(row, hit.after);
  return toRates(row);
}

/**
 * Token cost of one usage object at the model's list rates.
 * Returns null — not 0 — when the model is not in the book.
 *
 * @param {{ input?: number, cacheRead?: number, cw5m?: number, cw1h?: number, output?: number }|null|undefined} usage
 * @param {string|null|undefined} model
 * @returns {number|null}
 */
export function costOf(usage, model) {
  const r = rateFor(model);
  if (!r || !usage) return null;
  return (
    (usage.input ?? 0) * r.input +
    (usage.cacheRead ?? 0) * r.cacheRead +
    (usage.cw5m ?? 0) * r.cw5m +
    (usage.cw1h ?? 0) * r.cw1h +
    (usage.output ?? 0) * r.output
  ) / 1e6;
}
