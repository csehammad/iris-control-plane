/**
 * tool_result attribution (Iris 0.2) — rank which file/command blew the window,
 * and pair each offender with concrete remediation advice.
 */

import { estTokens } from "./schemas.mjs";

const PREVIEW_MAX = 240;

function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) => (typeof x === "string" ? x : x?.text ?? JSON.stringify(x)))
      .join("\n");
  }
  return JSON.stringify(content);
}

function previewOf(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + " …" : s;
}

/** Pull the human-meaningful "source" string from a tool_use input. */
export function sourceFromToolUse(toolName, rawInput) {
  const i = rawInput && typeof rawInput === "object" ? rawInput : {};
  const str = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  switch (toolName) {
    case "Bash":
      return str(i.command) || str(i.description) || "(bash)";
    case "Read":
      return str(i.file_path) || "(read)";
    case "Write":
    case "Edit":
      return str(i.file_path) || `(${toolName.toLowerCase()})`;
    case "NotebookEdit":
      return str(i.notebook_path) || "(notebook)";
    case "Glob":
      return [str(i.pattern), str(i.path)].filter(Boolean).join(" in ") || "(glob)";
    case "Grep":
      return [str(i.pattern), str(i.glob || i.path)].filter(Boolean).join(" in ") || "(grep)";
    case "WebFetch":
      return str(i.url) || "(web_fetch)";
    case "WebSearch":
      return str(i.query) || "(web_search)";
    case "Agent":
      return str(i.description || i.subagent_type || i.prompt) || "(agent)";
    case "Skill":
      return str(i.skill) || "(skill)";
    default: {
      for (const key of ["file_path", "path", "command", "url", "query", "pattern", "prompt"]) {
        if (typeof i[key] === "string" && i[key]) return i[key];
      }
      let best = "";
      for (const v of Object.values(i)) if (typeof v === "string" && v.length > best.length) best = v;
      return best || toolName || "(unknown)";
    }
  }
}

/**
 * Pair every tool_result with the prior tool_use that produced it (by tool_use_id).
 * @returns {Array<{toolUseId:string,toolName:string,source:string,tokens:number,chars:number,isError:boolean,preview:string}>}
 */
export function attributeToolResults(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;

  /** @type {Map<string,{name:string,input:any}>} */
  const uses = new Map();

  for (const m of messages) {
    const blocks = m?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b?.type === "tool_use" && b.id) {
        uses.set(b.id, { name: b.name ?? "(unnamed)", input: b.input });
      }
      if (b?.type !== "tool_result") continue;
      const id = b.tool_use_id ?? "";
      const use = uses.get(id);
      const toolName = use?.name ?? "(unknown)";
      const text = contentText(b.content);
      const chars = text.length;
      out.push({
        toolUseId: id,
        toolName,
        source: use ? sourceFromToolUse(toolName, use.input) : id || "(unpaired)",
        tokens: estTokens(text),
        chars,
        isError: !!b.is_error,
        preview: previewOf(text),
      });
    }
  }
  return out;
}

/** Sort attributions by estimated tokens descending. */
export function rankToolResults(attributions) {
  const rows = Array.isArray(attributions) ? [...attributions] : [];
  rows.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || (b.chars ?? 0) - (a.chars ?? 0));
  return rows;
}

/**
 * Concrete remediation suggestions for a ranked tool_result offender.
 * @param {{toolName?:string,source?:string,tokens?:number,chars?:number,isError?:boolean}} item
 */
export function remediationAdvice(item) {
  if (!item || typeof item !== "object") return "No attribution — cannot suggest a fix.";
  const name = item.toolName ?? "(unknown)";
  const tokens = Number(item.tokens) || 0;
  const chars = Number(item.chars) || 0;
  const tips = [];

  if (item.isError) {
    tips.push("This result is an error payload — fix the failing call so the stack/trace is not re-sent every turn.");
  }

  if (name === "Bash") {
    tips.push(
      'Cap shell output with env BASH_MAX_OUTPUT_LENGTH (e.g. "30000") in .claude/settings.json so large command dumps are truncated before they enter context.'
    );
    tips.push("Prefer narrower commands (head/tail, specific paths, --stat) over recursive listings of whole trees.");
    if (tokens >= 2000 || chars >= 8000) {
      tips.push("Add a PreToolUse hook that denies or rewrites Bash when the command looks like an unbounded find/cat/ls -R.");
    }
  } else if (name === "Read") {
    tips.push("Read with offset/limit instead of whole files; avoid re-reading the same path every turn.");
    tips.push("Add a PreToolUse filter that blocks Read on generated bundles, lockfiles, and binary-ish paths.");
    if (tokens >= 2000 || chars >= 8000) {
      tips.push("Split large files or point the agent at a summary instead of pasting the full contents into the conversation.");
    }
  } else if (name === "Grep" || name === "Glob") {
    tips.push("Tighten the pattern/glob so fewer hits return; exclude node_modules, dist, and build artefacts.");
    tips.push("A PreToolUse allowlist on search roots prevents runaway workspace scans from bloating tool_result.");
  } else if (name === "WebFetch" || name === "WebSearch") {
    tips.push("Summarise remote pages before they re-enter context; avoid fetching the same URL repeatedly.");
  } else if (name === "Agent") {
    tips.push("Subagent transcripts can dwarf the parent — keep delegated prompts short and return summaries, not full logs.");
  } else {
    tips.push(`Rank this ${name} result by source and deny or gate the tool if the schema is optional (Optimize → permissions.deny).`);
    tips.push("Consider a PreToolUse hook that truncates or rejects oversized tool outputs before they are appended to messages.");
  }

  if (tokens >= 5000) {
    tips.push(
      `This single result is ~${tokens.toLocaleString("en-US")} tokens — it alone can dominate the conversation band; treat it as the first trim target.`
    );
  }

  return tips.join(" ");
}
