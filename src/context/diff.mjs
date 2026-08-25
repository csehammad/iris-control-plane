/**
 * Context Diff (Iris 0.2) — request N→N+1 deltas for system / tools / messages / tool_results.
 */

import { estTokens, rankTools } from "./schemas.mjs";
import { attributeToolResults } from "./tool-results.mjs";

function systemText(body) {
  if (typeof body?.system === "string") return body.system;
  if (Array.isArray(body?.system)) return body.system.map((s) => s?.text ?? "").join("\n");
  return "";
}

function toolResultText(messages) {
  if (!Array.isArray(messages)) return "";
  let out = "";
  for (const m of messages) {
    const c = m?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type !== "tool_result") continue;
      const content = b.content;
      if (typeof content === "string") out += content;
      else if (Array.isArray(content)) {
        out += content.map((x) => (typeof x === "string" ? x : x?.text ?? JSON.stringify(x))).join("\n");
      } else if (content != null) out += JSON.stringify(content);
    }
  }
  return out;
}

function countCacheBreakpoints(body) {
  let n = 0;
  if (Array.isArray(body?.system)) {
    for (const s of body.system) if (s?.cache_control) n++;
  }
  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      const c = m?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) if (b?.cache_control) n++;
    }
  }
  return n;
}

function emptySizes() {
  return {
    system: 0,
    tools: 0,
    messages: 0,
    toolResults: 0,
    cacheBreakpoints: 0,
    toolNames: [],
    sysFingerprint: "",
    toolsFingerprint: "",
  };
}

/** Normalise either a raw Anthropic request body or a buildPreview() result into size buckets. */
export function sizeParts(previewOrBody) {
  if (!previewOrBody || typeof previewOrBody !== "object") return emptySizes();

  // Preview shape from buildPreview()
  const isPreview =
    previewOrBody.system &&
    typeof previewOrBody.system === "object" &&
    Array.isArray(previewOrBody.system.blocks) &&
    Array.isArray(previewOrBody.tools);

  if (isPreview) {
    const sysText = previewOrBody.system.blocks.map((b) => b.text || "").join("\n");
    let msgChars = 0;
    let trChars = 0;
    for (const m of previewOrBody.messages ?? []) {
      for (const b of m.blocks ?? []) {
        const c = b.chars ?? 0;
        msgChars += c;
        if (b.type === "tool_result") trChars += c;
      }
    }
    const toolNames = previewOrBody.tools.map((t) => t.name).filter(Boolean).sort();
    const toolsTok =
      typeof previewOrBody.toolTotal === "number"
        ? previewOrBody.toolTotal
        : previewOrBody.tools.reduce((s, t) => s + (t.tokens ?? 0), 0);
    return {
      system: estTokens(sysText),
      tools: toolsTok,
      messages: Math.round(msgChars / 4),
      toolResults: Math.round(trChars / 4),
      cacheBreakpoints: previewOrBody.cacheBreakpoints ?? 0,
      toolNames,
      sysFingerprint: sysText.slice(0, 2000),
      toolsFingerprint: toolNames.join("|"),
    };
  }

  // Raw request body
  const body = previewOrBody;
  const sys = systemText(body);
  const ranked = rankTools(body);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const msgJson = JSON.stringify(msgs);
  const tr = toolResultText(msgs);
  const toolNames = (Array.isArray(body.tools) ? body.tools : [])
    .map((t) => t?.name)
    .filter(Boolean)
    .sort();
  return {
    system: estTokens(sys),
    tools: ranked?.total ?? 0,
    messages: estTokens(msgJson),
    toolResults: estTokens(tr),
    cacheBreakpoints: countCacheBreakpoints(body),
    toolNames,
    sysFingerprint: sys.slice(0, 2000),
    toolsFingerprint: JSON.stringify(
      (Array.isArray(body.tools) ? body.tools : []).map((t) => [t?.name, estTokens(JSON.stringify(t))])
    ),
  };
}

/**
 * @returns {{
 *   deltaTokens: number,
 *   parts: Array<{kind:string,label:string,tokens:number}>,
 *   cachePrefixChanged: boolean,
 *   summary: string,
 *   prev: object,
 *   next: object,
 * }}
 */
export function contextDiff(prevPreviewOrBody, nextPreviewOrBody) {
  const prev = sizeParts(prevPreviewOrBody);
  const next = sizeParts(nextPreviewOrBody);

  const parts = [
    { kind: "system", label: "System prompt", tokens: next.system - prev.system },
    { kind: "tools", label: "Tool schemas", tokens: next.tools - prev.tools },
    { kind: "messages", label: "Conversation", tokens: next.messages - prev.messages },
    { kind: "tool_results", label: "Tool results", tokens: next.toolResults - prev.toolResults },
  ];

  const deltaTokens = parts.reduce((s, d) => s + d.tokens, 0);
  const cachePrefixChanged =
    prev.sysFingerprint !== next.sysFingerprint || prev.toolsFingerprint !== next.toolsFingerprint;

  let attributionNote = "";
  const prevMsgs = prevPreviewOrBody?.messages;
  const nextMsgs = nextPreviewOrBody?.messages;
  if (Array.isArray(nextMsgs)) {
    const ranked = attributeToolResults(nextMsgs).sort((a, b) => b.tokens - a.tokens);
    if (ranked[0] && ranked[0].tokens > 0) {
      const src = String(ranked[0].source).slice(0, 80);
      attributionNote = ` Largest tool_result: ${ranked[0].toolName} → ${src} (~${ranked[0].tokens} tok).`;
    }
    if (Array.isArray(prevMsgs)) {
      const prevIds = new Set(attributeToolResults(prevMsgs).map((a) => a.toolUseId));
      const added = ranked.filter((a) => !prevIds.has(a.toolUseId));
      if (added.length) {
        const addTok = added.reduce((s, a) => s + a.tokens, 0);
        attributionNote += ` ${added.length} new tool_result(s) (+~${addTok} tok).`;
      }
    }
  }

  const grown = parts.filter((d) => d.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const shrunk = parts.filter((d) => d.tokens < 0).sort((a, b) => a.tokens - b.tokens);
  let summary;
  if (deltaTokens === 0 && !cachePrefixChanged) {
    summary = "No estimated context change between these requests.";
  } else {
    const sign = deltaTokens > 0 ? "+" : "";
    const lead = grown[0]
      ? `${grown[0].label} ${grown[0].tokens > 0 ? "+" : ""}${grown[0].tokens} tok`
      : shrunk[0]
        ? `${shrunk[0].label} ${shrunk[0].tokens} tok`
        : "mix of shifts";
    summary =
      `Δ ~${sign}${deltaTokens} tokens (${lead}).` +
      (cachePrefixChanged
        ? " Cache prefix changed — next turn may pay cache-write instead of cache-read."
        : " Cache prefix stable.") +
      attributionNote;
  }

  return {
    deltaTokens,
    parts,
    cachePrefixChanged,
    summary,
    prev,
    next,
  };
}
