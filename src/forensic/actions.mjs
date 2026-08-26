/**
 * Action ledger — timestamped tool_use trace extracted from request history.
 * Arguments arrive scrubbed and length-capped; the file holds no credentials.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { writeJsonAtomic } from "../runtime/atomic.mjs";
import { dirname, join } from "node:path";
import { scrub } from "../security/redact.mjs";
import { fmt } from "../context/schemas.mjs";

export const TRACE_ARG_MAX = 500;
export const TRACE_DESC_MAX = 140;

/** Pull the one field that matters per tool rather than dumping JSON. */
export function traceEntry(name, rawInput) {
  const i = rawInput && typeof rawInput === "object" ? rawInput : {};
  const str = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  const cut = (v, n) => {
    const s = scrub(str(v)).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + " …" : s;
  };
  const arg = (v) => cut(v, TRACE_ARG_MAX);
  const desc = (v) => cut(v, TRACE_DESC_MAX);
  switch (name) {
    case "Bash":
      return { desc: desc(i.description), arg: arg(i.command) };
    case "Read":
      return { desc: i.offset ? `from line ${i.offset}` : "", arg: arg(i.file_path) };
    case "Write":
      return { desc: `${fmt(str(i.content).length)} chars written`, arg: arg(i.file_path) };
    case "Edit":
      return { desc: i.replace_all ? "replace all occurrences" : "", arg: arg(i.file_path) };
    case "NotebookEdit":
      return { desc: cut(i.edit_mode, 40), arg: arg(i.notebook_path) };
    case "Glob":
      return { desc: desc(i.path), arg: arg(i.pattern) };
    case "Grep":
      return { desc: desc(i.glob || i.path), arg: arg(i.pattern) };
    case "Agent":
      return { desc: desc(i.description || i.subagent_type), arg: arg(i.prompt) };
    case "TaskOutput":
      return { desc: "", arg: arg(i.task_id) };
    case "TaskStop":
      return { desc: "", arg: arg(i.task_id || i.shell_id) };
    case "Skill":
      return { desc: desc(i.args), arg: arg(i.skill) };
    case "WebFetch":
      return { desc: desc(i.prompt), arg: arg(i.url) };
    case "WebSearch":
      return { desc: "", arg: arg(i.query) };
    case "Monitor":
      return { desc: desc(i.description), arg: arg(i.command || i.ws?.url) };
    case "TodoWrite":
      return {
        desc: Array.isArray(i.todos) ? `${i.todos.length} items` : "",
        arg: arg(Array.isArray(i.todos) ? i.todos.map((t) => t?.content).filter(Boolean).join(" · ") : ""),
      };
    case "EnterWorktree":
      return { desc: "", arg: arg(i.name || i.path) };
    case "ExitWorktree":
      return { desc: i.discard_changes ? "discarding changes" : "", arg: arg(i.action) };
    case "AskUserQuestion":
      return { desc: "", arg: arg(i.question ?? i.questions) };
    case "SendMessage":
      return { desc: desc(i.agent_id ?? i.to), arg: arg(i.message ?? i.prompt) };
    default: {
      let best = "";
      for (const v of Object.values(i)) if (typeof v === "string" && v.length > best.length) best = v;
      return { desc: "", arg: arg(best || (Object.keys(i).length ? i : "")) };
    }
  }
}

export function buildTrace(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  messages.forEach((m, mi) => {
    const c = m?.content;
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (b?.type !== "tool_use") continue;
      const { desc, arg } = traceEntry(b.name, b.input);
      out.push({ i: out.length + 1, tool: b.name ?? "(unnamed)", desc, arg, m: mi });
    }
  });
  return out;
}

/**
 * Persistent action ledger.
 * @param {{ path: string, max?: number }} opts
 */
export function createActionLedger({ path, max = 20000 } = {}) {
  if (!path) throw new Error("createActionLedger requires { path }");
  let actionLog = [];
  const actionKeys = new Set();
  let actionsDirty = 0;
  let actionsBackfilled = false;

  function load() {
    try {
      const j = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(j?.actions)) {
        actionLog = j.actions.slice(-max);
        actionKeys.clear();
        for (const a of actionLog) actionKeys.add(a.k);
      }
      actionsBackfilled = !!j?.backfilled;
    } catch {
      /* first run */
    }
    return actionLog;
  }

  /**
   * Adopt anything another writer added since this process last read.
   *
   * Same hazard as the spend ledger: two Iris instances can serve one project,
   * and a whole-file write from memory silently discards the other's actions.
   * Rows carry a content-hashed key `k`, so the union is well defined.
   *
   * @returns {number} rows adopted
   */
  function mergeFromDisk() {
    let j;
    try {
      j = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // FALLBACK-GUARD: INTENTIONAL — no file yet; this process's log stands
      return 0;
    }
    const rows = Array.isArray(j?.actions) ? j.actions : [];
    let adopted = 0;
    for (const a of rows) {
      if (!a || !a.k || actionKeys.has(a.k)) continue;
      actionKeys.add(a.k);
      actionLog.push(a);
      adopted++;
    }
    if (adopted) {
      /* Keep chronological order so the FIFO cap evicts the oldest, not whatever
         happened to be merged last. */
      actionLog.sort((x, y) => String(x.t || "").localeCompare(String(y.t || "")) || (x.i - y.i));
      if (actionLog.length > max) {
        const drop = actionLog.splice(0, actionLog.length - max);
        for (const d of drop) actionKeys.delete(d.k);
      }
    }
    return adopted;
  }

  function save() {
    try {
      mkdirSync(dirname(path), { recursive: true });
      mergeFromDisk();
      writeJsonAtomic(path, {
        savedAt: new Date().toISOString(),
        backfilled: actionsBackfilled,
        actions: actionLog,
      });
      actionsDirty = 0;
    } catch (e) {
      console.error("  ! could not persist action log:", e.message);
    }
  }

  function recordActions(trace, timeIso) {
    if (!Array.isArray(trace)) return;
    for (const a of trace) {
      if (!a?.tool) continue;
      const k = `${a.i}|${a.tool}|${createHash("sha256").update(String(a.arg ?? "")).digest("hex").slice(0, 10)}`;
      if (actionKeys.has(k)) continue;
      actionKeys.add(k);
      actionLog.push({ k, t: timeIso, i: a.i, tool: a.tool, desc: a.desc || "", arg: a.arg || "" });
      actionsDirty++;
    }
    if (actionLog.length > max) {
      const drop = actionLog.splice(0, actionLog.length - max);
      for (const d of drop) actionKeys.delete(d.k);
    }
    if (actionsDirty >= 25) save();
  }

  /**
   * One-time / incremental backfill from proxy-logs/*.req.json.
   * @param {string} logDir
   * @param {(messages:any[])=>any[]} [buildTraceFn=buildTrace]
   * @param {number} [limit=1500]
   */
  async function backfillActions(logDir, buildTraceFn = buildTrace, limit = 1500) {
    const t0 = Date.now();
    let files = [];
    try {
      if (!existsSync(logDir)) return { added: 0, files: 0 };
      files = readdirSync(logDir)
        .filter((f) => f.endsWith(".req.json"))
        .sort()
        .slice(-limit);
      for (let i = 0; i < files.length; i++) {
        if (i % 20 === 0) await new Promise((r) => setImmediate(r));
        try {
          const log = JSON.parse(readFileSync(join(logDir, files[i]), "utf8"));
          const body = typeof log.body === "object" && log.body != null ? log.body : null;
          if (!Array.isArray(body?.messages)) continue;
          recordActions(buildTraceFn(body.messages), log.time);
        } catch {
          /* skip */
        }
      }
      actionsBackfilled = true;
      actionLog.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.i - b.i));
      save();
      console.log(
        `Action ledger: backfilled to ${actionLog.length} actions from ${files.length} logs in ${Date.now() - t0}ms`
      );
    } catch (e) {
      console.error("  ! action backfill failed:", e.message);
    }
    return { added: actionLog.length, files: files.length, backfilled: actionsBackfilled };
  }

  function getActions({ since } = {}) {
    if (!since) return actionLog.slice();
    const cut = String(since);
    return actionLog.filter((a) => a.t >= cut);
  }

  return {
    get path() {
      return path;
    },
    get actions() {
      return actionLog;
    },
    get backfilled() {
      return actionsBackfilled;
    },
    load,
    save,
    mergeFromDisk,
    recordActions,
    backfillActions,
    getActions,
    /**
     * Drop every recorded action and persist the empty ledger. `backfilled` is
     * reset too, so a later backfill can repopulate from whatever logs remain.
     * Returns how many actions were discarded.
     */
    clear() {
      const n = actionLog.length;
      actionLog = [];
      actionKeys.clear();
      actionsDirty = 0;
      actionsBackfilled = false;
      save();
      return n;
    },
  };
}
