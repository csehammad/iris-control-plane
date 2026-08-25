/**
 * Request preview / estimation — extracted from proxy.mjs.
 */

import { scrub } from "../security/redact.mjs";
import { estTokens, fmt, rankTools } from "./schemas.mjs";
import { buildTrace } from "../forensic/actions.mjs";

export { buildTrace };

export function previewText(v, max = 300) {
  if (v == null) return "";
  const s = scrub(typeof v === "string" ? v : JSON.stringify(v));
  return s.length > max ? s.slice(0, max) + " …" : s;
}

export function blockSummary(b) {
  if (typeof b === "string") return { type: "text", chars: b.length, text: previewText(b) };
  const type = b?.type ?? "unknown";
  if (type === "text") return { type, chars: (b.text || "").length, text: previewText(b.text) };
  if (type === "thinking") return { type, chars: (b.thinking || "").length, text: previewText(b.thinking) };
  if (type === "tool_use") {
    return { type, name: b.name, chars: JSON.stringify(b.input || {}).length, text: previewText(b.input) };
  }
  if (type === "tool_result") {
    const c = b.content;
    let text = "";
    if (Array.isArray(c)) text = c.map((x) => (typeof x === "string" ? x : x?.text ?? JSON.stringify(x))).join("\n");
    else text = typeof c === "string" ? c : JSON.stringify(c ?? "");
    return { type, chars: text.length, text: previewText(text), isError: !!b.is_error };
  }
  if (type === "image") return { type, chars: 0, text: "[image]" };
  return { type, chars: JSON.stringify(b).length, text: previewText(b) };
}

/** Never throws — a bad payload must not break request forwarding. */
export function buildPreview(parsed) {
  try {
    if (!parsed || typeof parsed !== "object") return null;
    let sysBlocks = [];
    let sysCache = 0;
    // System prompt is shown in FULL (not previewed) — users need the whole
    // thing to audit the token tax. Cap only guards against pathological size.
    const SYS_MAX = 200000;
    const sysFull = (v) => {
      const s = scrub(typeof v === "string" ? v : v != null ? JSON.stringify(v) : "");
      return s.length > SYS_MAX ? s.slice(0, SYS_MAX) + " … [truncated]" : s;
    };
    if (typeof parsed.system === "string") {
      sysBlocks = [{ chars: parsed.system.length, text: sysFull(parsed.system), cache: false }];
    } else if (Array.isArray(parsed.system)) {
      sysBlocks = parsed.system.map((s) => {
        const cache = !!s?.cache_control;
        if (cache) sysCache++;
        return { chars: (s?.text || "").length, text: sysFull(s?.text), cache };
      });
    }
    let msgCache = 0;
    const messages = (Array.isArray(parsed.messages) ? parsed.messages : []).map((m) => {
      const c = m?.content;
      let blocks;
      if (typeof c === "string") blocks = [{ type: "text", chars: c.length, text: previewText(c) }];
      else if (Array.isArray(c)) {
        blocks = c.map((b) => {
          if (b?.cache_control) msgCache++;
          return blockSummary(b);
        });
      } else blocks = [];
      return { role: m?.role ?? "?", blocks };
    });
    const ranked = rankTools(parsed);
    return {
      system: { count: sysBlocks.length, blocks: sysBlocks },
      tools: ranked ? ranked.rows : [],
      toolTotal: ranked ? ranked.total : 0,
      messages,
      trace: buildTrace(parsed.messages),
      cacheBreakpoints: sysCache + msgCache,
      params: {
        max_tokens: parsed.max_tokens ?? null,
        temperature: parsed.temperature ?? null,
        stream: !!parsed.stream,
        thinking: parsed?.thinking?.type
          ? parsed.thinking.type + (parsed.thinking.budget_tokens ? " " + parsed.thinking.budget_tokens : "")
          : null,
      },
    };
  } catch {
    return null;
  }
}

/** Estimate prompt size the same way the live path does. */
export function estimateRequest(body) {
  let sysText = "";
  if (typeof body?.system === "string") sysText = body.system;
  else if (Array.isArray(body?.system)) sysText = body.system.map((s) => s?.text ?? "").join("\n");
  const estSys = estTokens(sysText);
  const estMsg = Array.isArray(body?.messages) ? estTokens(JSON.stringify(body.messages)) : 0;
  const ranked = rankTools(body);
  return {
    estSys,
    estMsg,
    estTools: ranked?.total ?? 0,
    toolCount: ranked?.rows.length ?? 0,
    msgCount: Array.isArray(body?.messages) ? body.messages.length : 0,
  };
}

export function printTable(id, url, body) {
  const ranked = rankTools(body);
  const line = "─".repeat(58);
  console.log(`\n#${id}  ${url}  ·  ${new Date().toLocaleTimeString()}`);
  if (body?.model) console.log(`     model: ${body.model}`);
  if (!ranked) {
    console.log("     (no tools in this request)");
    return;
  }
  console.log(line);
  console.log(`  ${"TOOL".padEnd(38)}${"~TOKENS".padStart(10)}${"SHARE".padStart(9)}`);
  console.log(line);
  for (const r of ranked.rows) {
    const share = ranked.total ? `${((r.tokens / ranked.total) * 100).toFixed(1)}%` : "-";
    console.log(`  ${r.name.slice(0, 38).padEnd(38)}${fmt(r.tokens).padStart(10)}${share.padStart(9)}`);
  }
  console.log(line);
  console.log(`  ${"TOTAL (tools only)".padEnd(38)}${fmt(ranked.total).padStart(10)}`);
  console.log(line);
}
