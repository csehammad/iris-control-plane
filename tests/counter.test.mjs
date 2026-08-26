import { createTokenCounter, reconcile, countHeaders, systemOf } from "../src/context/counter.mjs";

let n = 0,
  fail = 0;
function assert(cond, msg) {
  n++;
  if (!cond) {
    fail++;
    console.error("  FAIL", msg);
  }
}

/* ---- header selection ---------------------------------------------------- */
const h = countHeaders({
  host: "127.0.0.1:8787",
  "content-length": "9999",
  "accept-encoding": "gzip",
  "x-api-key": "sk-test",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "context-1m-2025-08-07",
  cookie: "should-not-travel",
});
assert(h["x-api-key"] === "sk-test", "api key forwarded");
assert(h["anthropic-version"] === "2023-06-01", "version forwarded");
assert(h["anthropic-beta"] === "context-1m-2025-08-07", "beta forwarded");
assert(h["content-type"] === "application/json", "content-type set");
assert(!("host" in h) && !("content-length" in h), "host/content-length dropped");
assert(!("cookie" in h), "unrelated headers not forwarded");
assert(countHeaders({ authorization: "Bearer x" }).authorization === "Bearer x", "oauth bearer forwarded");

/* ---- system normalization ------------------------------------------------ */
assert(systemOf({ system: "hi" }) === "hi", "string system");
assert(Array.isArray(systemOf({ system: [{ type: "text", text: "a" }] })), "block system");
assert(systemOf({ system: "" }) === null, "empty string system is null");
assert(systemOf({}) === null, "absent system is null");

/* ---- reconcile: pure arithmetic ------------------------------------------ */
// est totals 1000; measured 1550 -> factor 1.55
const rc = reconcile({ sys: 400, tools: 900 }, { estSys: 200, estTools: 300, estMsg: 500 }, 1550);
assert(Math.abs(rc.factor - 1.55) < 1e-9, "factor = measured / estimated");
assert(rc.calibrated.sys === 310 && rc.calibrated.tools === 465, "calibrated split scales by factor");
assert(rc.counted.sys === 400 && rc.counted.tools === 900, "counted prefix passes through");
// conversation is derived, never counted
assert(rc.counted.msg === 1550 - 400 - 900, "messages derived by subtraction");
assert(rc.delta.sys === 90 && rc.delta.tools === 435, "per-bucket delta");
assert(rc.delta.prefix === 1300 - 775, "prefix delta is what Optimize sells on");
assert(Math.abs(rc.delta.prefixPct - ((1300 - 775) / 775) * 100) < 1e-9, "prefix delta pct");

// with no counted split, the calibrated view is still returned
const rcNo = reconcile(null, { estSys: 1, estTools: 1, estMsg: 2 }, 400);
assert(rcNo && rcNo.counted === null && rcNo.delta === null, "null counted still reconciles");
assert(reconcile(null, { estSys: 0, estTools: 0, estMsg: 0 }, 100) === null, "zero estimate -> null");
assert(reconcile(null, { estSys: 1, estTools: 1, estMsg: 1 }, 0) === null, "zero measured -> null");

/* ---- counter: differentials, caching, dedupe ------------------------------ */
function stubFetch(table) {
  const calls = [];
  return {
    calls,
    fn: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      const hasSys = body.system != null;
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const key = hasTools ? "tools" : hasSys ? "sys" : "base";
      return { ok: true, status: 200, text: async () => JSON.stringify({ input_tokens: table[key] }) };
    },
  };
}

// base 10, system+base 60, tools+base 310 -> sys 50, tools 300
const s1 = stubFetch({ base: 10, sys: 60, tools: 310 });
const c1 = createTokenCounter({ upstream: "https://x", fetchImpl: s1.fn });
const r1 = await c1.countPrefix({
  headers: { "x-api-key": "k" },
  model: "claude-opus-5",
  system: "you are a scientist",
  tools: [{ name: "t", description: "d", input_schema: {} }],
});
assert(r1.base === 10, "base floor counted");
assert(r1.sys === 50, "sys is differential against base");
assert(r1.tools === 300, "tools is differential against base");
assert(r1.prefix === 350, "prefix is sys + tools");
assert(s1.calls.length === 3, "three counting calls on a cold prefix");
assert(r1.fromCache === false, "cold prefix is not a cache hit");

// identical request: fully cached, zero new upstream calls
const r2 = await c1.countPrefix({
  headers: { "x-api-key": "k" },
  model: "claude-opus-5",
  system: "you are a scientist",
  tools: [{ name: "t", description: "d", input_schema: {} }],
});
assert(s1.calls.length === 3, "warm prefix makes no upstream calls");
assert(r2.prefix === 350 && r2.fromCache === true, "warm prefix served from cache");

// changing tools must not force the system prompt to be recounted
await c1.countPrefix({
  headers: { "x-api-key": "k" },
  model: "claude-opus-5",
  system: "you are a scientist",
  tools: [{ name: "other", description: "d2", input_schema: {} }],
});
assert(s1.calls.length === 4, "only the tools half is recounted when tools change");

// tool_choice is part of the key: auto and any cost different tool-use prompts
await c1.countPrefix({
  headers: { "x-api-key": "k" },
  model: "claude-opus-5",
  system: "you are a scientist",
  tools: [{ name: "t", description: "d", input_schema: {} }],
  toolChoice: { type: "any" },
});
assert(s1.calls.length === 5, "tool_choice change recounts tools");

// concurrent identical requests share one in-flight call
const s2 = stubFetch({ base: 10, sys: 60, tools: 310 });
const c2 = createTokenCounter({ upstream: "https://x", fetchImpl: s2.fn });
await Promise.all(
  Array.from({ length: 5 }, () =>
    c2.countPrefix({ headers: { "x-api-key": "k" }, model: "m", system: "s" })
  )
);
assert(s2.calls.length === 2, "concurrent identical prefixes dedupe to one base + one sys");

/* ---- counter: never throws into the proxy -------------------------------- */
const boom = createTokenCounter({
  upstream: "https://x",
  fetchImpl: async () => {
    throw new Error("network down");
  },
  maxErrors: 2,
  cooldownMs: 50_000,
});
assert((await boom.countPrefix({ headers: { "x-api-key": "k" }, model: "m" })) === null, "error -> null");
await boom.countPrefix({ headers: { "x-api-key": "k" }, model: "m" });
assert(boom.stats().cooling === true, "repeated failure trips the cooldown");
assert(boom.available() === false, "cooling counter reports unavailable");
assert((await boom.countPrefix({ headers: { "x-api-key": "k" }, model: "m" })) === null, "cooled counter no-ops");

const http500 = createTokenCounter({
  upstream: "https://x",
  fetchImpl: async () => ({ ok: false, status: 429, text: async () => "rate limited" }),
});
assert((await http500.countPrefix({ headers: { "x-api-key": "k" }, model: "m" })) === null, "non-2xx -> null");
assert(http500.stats().errors === 1, "error recorded");

// no credential means no call at all
const s3 = stubFetch({ base: 1, sys: 2, tools: 3 });
const c3 = createTokenCounter({ upstream: "https://x", fetchImpl: s3.fn });
assert((await c3.countPrefix({ headers: {}, model: "m" })) === null, "no credential -> null");
assert(s3.calls.length === 0, "no credential makes no request");
assert((await c3.countPrefix({ headers: { "x-api-key": "k" } })) === null, "no model -> null");

/* ---- cache eviction ------------------------------------------------------ */
const s4 = stubFetch({ base: 1, sys: 2, tools: 3 });
const c4 = createTokenCounter({ upstream: "https://x", fetchImpl: s4.fn, maxEntries: 3 });
for (let i = 0; i < 6; i++) {
  await c4.countPrefix({ headers: { "x-api-key": "k" }, model: "m", system: `sys-${i}` });
}
assert(c4.stats().cacheSize <= 3, "cache respects maxEntries");

console.log(`counter: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
