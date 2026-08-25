import { scrub } from "./redact.mjs";

export const WIRE_REDACT = process.env.PROXY_REDACT_WIRE === "1";
export const PLACEHOLDER_RE = /\{\{[a-z-]+:[0-9a-f]{8}\}\}/g;

// placeholder -> real value, memory only and per proxy run. Never written to disk:
// a vault on disk is just a smaller file containing all your secrets.
export const vault = new Map();
export let wireStats = { redacted: 0, restored: 0, skippedThinking: 0 };

// Redact a string and remember how to undo it.
export function scrubToVault(text) {
  if (typeof text !== "string" || !text) return text;
  const before = vault.size;
  const out = scrub(text, vault);
  if (vault.size !== before) wireStats.redacted += vault.size - before;
  return out;
}

// Walk a request body, redacting strings. Thinking blocks are returned untouched.
export function scrubDeep(node) {
  if (typeof node === "string") return scrubToVault(node);
  if (Array.isArray(node)) return node.map(scrubDeep);
  if (node && typeof node === "object") {
    if (node.type === "thinking" || node.type === "redacted_thinking") {
      wireStats.skippedThinking++;
      return node; // modifying it invalidates the signature
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = k === "signature" ? v : scrubDeep(v);
    return out;
  }
  return node;
}

// Stateful placeholder -> value replacer that tolerates a token split across chunks.
export function makeRehydrator() {
  let carry = "";
  const swap = (s) =>
    s.replace(PLACEHOLDER_RE, (m) => {
      const real = vault.get(m);
      if (real == null) return m; // unknown placeholder: leave it visible
      wireStats.restored++;
      return real;
    });
  return {
    feed(text) {
      let s = swap(carry + text);
      carry = "";
      // hold back a possible partial "{{kind:hash" at the tail
      const i = s.lastIndexOf("{{");
      if (i >= 0 && !s.slice(i).includes("}}") && s.length - i < 48) {
        carry = s.slice(i);
        s = s.slice(0, i);
      }
      return s;
    },
    pending: () => carry,
    flush() {
      const s = swap(carry);
      carry = "";
      return s;
    },
  };
}

// Rewrites an SSE stream in flight. Frames are only emitted once complete, and any
// held-back tail is flushed as a valid delta before its content block closes.
export function makeSseRewriter() {
  const reh = makeRehydrator();
  let buf = "";
  let lastIndex = 0;

  const frameFor = (text) =>
    "event: content_block_delta\ndata: " +
    JSON.stringify({ type: "content_block_delta", index: lastIndex, delta: { type: "text_delta", text } }) +
    "\n\n";

  const rewrite = (frame) => {
    let prefix = "";
    const lines = frame.split("\n").map((line) => {
      if (!line.startsWith("data:")) return line;
      let d;
      try {
        d = JSON.parse(line.slice(5).trim());
      } catch {
        return line;
      }
      if (typeof d?.index === "number") lastIndex = d.index;
      let touched = false;
      if (d?.type === "content_block_delta" && d.delta) {
        if (typeof d.delta.text === "string") { d.delta.text = reh.feed(d.delta.text); touched = true; }
        else if (typeof d.delta.partial_json === "string") { d.delta.partial_json = reh.feed(d.delta.partial_json); touched = true; }
      } else if (d?.type === "content_block_start" && typeof d.content_block?.text === "string") {
        d.content_block.text = reh.feed(d.content_block.text);
        touched = true;
      } else if (d?.type === "content_block_stop" || d?.type === "message_stop") {
        // nothing may be left dangling once the block is closed
        const tail = reh.flush();
        if (tail) prefix += frameFor(tail);
      }
      return touched ? "data: " + JSON.stringify(d) : line;
    });
    return prefix + lines.join("\n");
  };

  return {
    push(chunk) {
      buf += chunk;
      let out = "";
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        out += rewrite(buf.slice(0, i)) + "\n\n";
        buf = buf.slice(i + 2);
      }
      return out;
    },
    end() {
      let out = buf ? rewrite(buf) : "";
      buf = "";
      const tail = reh.flush();
      if (tail) out += frameFor(tail);
      return out;
    },
  };
}
