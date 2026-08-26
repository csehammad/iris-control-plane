/**
 * Exact token counts from POST /v1/messages/count_tokens.
 *
 * Why this exists
 * ---------------
 * Iris sizes the system prompt and each tool schema with `chars/4` (schemas.mjs),
 * then scales the result by a factor fitted so the three buckets sum to the input
 * total the response reported. That makes the TOTAL exact and leaves the SPLIT
 * wrong: one factor is applied to system prose, JSON tool schemas and conversation
 * alike, and they do not tokenize at the same rate. The factor is dominated by
 * whichever bucket is largest — usually the conversation — so the prefix, the part
 * Optimize actually sells decisions on, is the bucket it serves worst.
 *
 * Two things `chars/4` cannot see at all:
 *   - the tool-use system prompt the API adds whenever any tool is present
 *     (286 tokens on Opus 5 for tool_choice auto/none, 406 for any/tool). There is
 *     no text to count; it is added server-side.
 *   - that Claude 4.7+ tokenizers emit ~30% more tokens for the same characters.
 *
 * The endpoint uses the same tokenizer as inference, accepts `system`/`tools`/
 * `messages`, is free, and sits on a rate-limit pool independent of message
 * creation. Claude Code already calls it through this very proxy, so the forwarded
 * credentials are known to work for it.
 *
 * Cost control
 * ------------
 * The system prompt and tool schemas are stable across a session, so each is counted
 * once per (model, content) hash and cached. The conversation is never counted: it
 * falls out by subtraction from usage that already arrived. A warm session therefore
 * makes ZERO counting calls.
 *
 * This never blocks the proxy hop and never throws into it. A failure degrades to
 * "no counted split for this call" and trips a cooldown, leaving the chars/4 path
 * exactly as it was.
 */

import { createHash } from "node:crypto";

/** Smallest legal message list — the floor every differential subtracts. */
const TINY = [{ role: "user", content: "." }];

const DEFAULTS = {
  maxEntries: 500,
  cooldownMs: 60_000,
  timeoutMs: 10_000,
  maxErrors: 3,
};

const hash = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 32);

/** Normalize the system field to what the API accepts, or null when absent. */
export function systemOf(body) {
  const s = body?.system;
  if (typeof s === "string") return s.length ? s : null;
  if (Array.isArray(s) && s.length) return s;
  return null;
}

/**
 * Only the headers the counting endpoint needs. Everything else — host,
 * content-length, accept-encoding — is either wrong for a new request or would
 * describe the original body rather than ours.
 */
export function countHeaders(src) {
  const out = { "content-type": "application/json" };
  if (!src) return out;
  for (const [k, v] of Object.entries(src)) {
    const key = k.toLowerCase();
    if (
      key === "x-api-key" ||
      key === "authorization" ||
      key === "anthropic-version" ||
      key === "anthropic-beta" ||
      key === "anthropic-dangerous-direct-browser-access"
    ) {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Reconcile a counted split against the calibrated chars/4 split for one call.
 * Pure — no I/O — so the arithmetic is testable on its own.
 *
 * @param {{ sys: number, tools: number }|null} counted
 * @param {{ estSys: number, estTools: number, estMsg: number }} est
 * @param {number} measuredInputTotal  usage.input + cacheRead + cacheCreate
 */
export function reconcile(counted, est, measuredInputTotal) {
  const estSys = Number(est?.estSys) || 0;
  const estTools = Number(est?.estTools) || 0;
  const estMsg = Number(est?.estMsg) || 0;
  const estTotal = estSys + estTools + estMsg;
  const measured = Number(measuredInputTotal);
  if (!Number.isFinite(measured) || measured <= 0 || estTotal <= 0) return null;

  /* The factor the UI applies today: one number fitted to the whole request. */
  const factor = measured / estTotal;
  const calibrated = {
    sys: Math.round(estSys * factor),
    tools: Math.round(estTools * factor),
    msg: Math.round(estMsg * factor),
  };
  if (!counted) return { factor, calibrated, counted: null, delta: null, measured };

  /* Counted prefix is exact. The conversation is what is left of the measured
     total once the prefix is removed — no call needed, and it absorbs anything
     the endpoint counts that billing does not. */
  const cSys = Math.round(counted.sys);
  const cTools = Math.round(counted.tools);
  const cMsg = Math.round(measured - cSys - cTools);

  return {
    factor,
    measured,
    calibrated,
    counted: { sys: cSys, tools: cTools, msg: cMsg },
    /* What switching to counted values would move, in tokens and in percent of
       the calibrated figure. Positive = chars/4 was under-reporting. */
    delta: {
      sys: cSys - calibrated.sys,
      tools: cTools - calibrated.tools,
      msg: cMsg - calibrated.msg,
      sysPct: calibrated.sys ? ((cSys - calibrated.sys) / calibrated.sys) * 100 : null,
      toolsPct: calibrated.tools ? ((cTools - calibrated.tools) / calibrated.tools) * 100 : null,
      msgPct: calibrated.msg ? ((cMsg - calibrated.msg) / calibrated.msg) * 100 : null,
      /* The prefix is the figure Optimize sells decisions on. */
      prefix: cSys + cTools - (calibrated.sys + calibrated.tools),
      prefixPct: calibrated.sys + calibrated.tools
        ? ((cSys + cTools - (calibrated.sys + calibrated.tools)) / (calibrated.sys + calibrated.tools)) * 100
        : null,
    },
  };
}

/**
 * @param {{ upstream: string, fetchImpl?: typeof fetch, maxEntries?: number,
 *           cooldownMs?: number, timeoutMs?: number, maxErrors?: number,
 *           now?: () => number }} opts
 */
export function createTokenCounter(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const upstream = String(cfg.upstream || "https://api.anthropic.com").replace(/\/+$/, "");
  const doFetch = cfg.fetchImpl || globalThis.fetch;
  const now = cfg.now || Date.now;

  /* key -> tokens. Insertion-ordered, evicted oldest-first past maxEntries. */
  const cache = new Map();
  /* key -> in-flight promise, so N concurrent calls sharing a prefix make one request. */
  const inflight = new Map();
  const stats = {
    hits: 0,
    misses: 0,
    requests: 0,
    errors: 0,
    consecutiveErrors: 0,
    disabledUntil: 0,
    lastError: null,
    lastErrorAt: null,
  };

  const available = () => typeof doFetch === "function" && now() >= stats.disabledUntil;

  function remember(key, tokens) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, tokens);
    while (cache.size > cfg.maxEntries) cache.delete(cache.keys().next().value);
    return tokens;
  }

  /** One POST to count_tokens. Returns input_tokens, or throws. */
  async function post(headers, body) {
    stats.requests++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    try {
      const res = await doFetch(`${upstream}/v1/messages/count_tokens`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      const json = JSON.parse(text);
      const n = json?.input_tokens;
      if (!Number.isFinite(n)) throw new Error(`no input_tokens in response: ${text.slice(0, 200)}`);
      stats.consecutiveErrors = 0;
      return n;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cache-and-dedupe wrapper around post(). */
  function counted(key, headers, body) {
    if (cache.has(key)) {
      stats.hits++;
      return Promise.resolve(cache.get(key));
    }
    if (inflight.has(key)) return inflight.get(key);
    stats.misses++;
    const p = post(headers, body)
      .then((n) => remember(key, n))
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /**
   * Exact token counts for the stable prefix of a request.
   *
   * Three differentials against a fixed floor:
   *   base  = count(tiny message)                 — request scaffolding
   *   sys   = count(system + tiny) - base
   *   tools = count(tools + tiny)  - base         — includes the tool-use system
   *                                                 prompt the API adds once
   *
   * Counted separately rather than as one call so each half caches on its own
   * hash: changing one tool must not force the system prompt to be recounted.
   *
   * @returns {Promise<{sys:number, tools:number, base:number, prefix:number,
   *                    model:string, fromCache:boolean, ms:number}|null>}
   *   null when counting is unavailable, disabled by cooldown, or fails.
   */
  async function countPrefix({ headers, model, system, tools, toolChoice }) {
    if (!model || !available()) return null;
    const h = countHeaders(headers);
    if (!h["x-api-key"] && !h.authorization) return null; // nothing to authenticate with

    const startedAt = now();
    const before = stats.misses;
    try {
      const baseKey = `b:${model}`;
      const base = await counted(baseKey, h, { model, messages: TINY });

      let sys = 0;
      if (system != null) {
        const key = `s:${model}:${hash(JSON.stringify(system))}`;
        sys = (await counted(key, h, { model, system, messages: TINY })) - base;
      }

      let toolsTok = 0;
      if (Array.isArray(tools) && tools.length) {
        /* tool_choice is part of the key: auto/none cost 286 tokens of tool-use
           system prompt on Opus 5, any/tool cost 406. Same tools, different total. */
        const key = `t:${model}:${hash(JSON.stringify(tools))}:${hash(JSON.stringify(toolChoice ?? null))}`;
        const body = { model, tools, messages: TINY };
        if (toolChoice) body.tool_choice = toolChoice;
        toolsTok = (await counted(key, h, body)) - base;
      }

      return {
        model,
        base,
        sys: Math.max(0, sys),
        tools: Math.max(0, toolsTok),
        prefix: Math.max(0, sys) + Math.max(0, toolsTok),
        fromCache: stats.misses === before,
        ms: now() - startedAt,
      };
    } catch (e) {
      stats.errors++;
      stats.consecutiveErrors++;
      stats.lastError = e?.message ? String(e.message).slice(0, 300) : String(e);
      stats.lastErrorAt = new Date().toISOString();
      /* Repeated failure is usually a rate limit or an auth shape this endpoint
         rejects. Back off rather than retrying on every single turn. */
      if (stats.consecutiveErrors >= cfg.maxErrors) {
        stats.disabledUntil = now() + cfg.cooldownMs;
        stats.consecutiveErrors = 0;
      }
      return null;
    }
  }

  return {
    countPrefix,
    reconcile,
    available,
    stats: () => ({
      ...stats,
      cacheSize: cache.size,
      inflight: inflight.size,
      cooling: now() < stats.disabledUntil,
    }),
    clear() {
      cache.clear();
      inflight.clear();
    },
  };
}
