/**
 * End-to-end: a real request through the proxy produces a counted prefix and a
 * reconciliation against the chars/4 estimate, without the counting calls ever
 * touching the client's latency or breaking the forward path.
 */
import { startServer } from "../src/runtime/server.mjs";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let n = 0,
  fail = 0;
function assert(cond, msg) {
  n++;
  if (!cond) {
    fail++;
    console.error("  FAIL", msg);
  }
}

/* ---- stub upstream ------------------------------------------------------- */
// base = 10, +system = 510, +tools = 2010  ->  sys 500, tools 2000
const COUNTS = { base: 10, sys: 510, tools: 2010 };
const MEASURED = { input: 1000, cache_read: 8000, cache_create: 1000 }; // total 10,000
const upstreamCalls = { messages: 0, count: 0, countBodies: [] };
let failCounting = false;

const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    if (req.url.includes("count_tokens")) {
      upstreamCalls.count++;
      upstreamCalls.countBodies.push(parsed);
      if (failCounting) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "counting is down" }));
        return;
      }
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const hasSys = parsed.system != null;
      const t = hasTools ? COUNTS.tools : hasSys ? COUNTS.sys : COUNTS.base;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: t }));
      return;
    }
    upstreamCalls.messages++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: MEASURED.input,
            cache_read_input_tokens: MEASURED.cache_read,
            cache_creation_input_tokens: MEASURED.cache_create,
          },
        },
      })}\n`
    );
    res.write(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 50 } })}\n`);
    res.end();
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

/* ---- iris pointed at the stub -------------------------------------------- */
const root = mkdtempSync(join(tmpdir(), "iris-audit-"));
mkdirSync(join(root, ".claude"), { recursive: true });
writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: [] } }, null, 2));
process.env.IRIS_HOME = join(root, ".iris-home");
process.env.PROXY_SETTINGS_PATH = join(root, ".claude", "settings.json");
process.env.PROXY_LOG_DIR = join(root, ".claude", "proxy-logs");
process.env.PROXY_HISTORY_PATH = join(root, ".claude", "history-index.json");
process.env.PROXY_ACTIONS_PATH = join(root, ".claude", "action-log.json");
process.env.IRIS_AUTOWIRE = "0";

const port = 17300 + Math.floor(Math.random() * 600);
const { server } = startServer({
  port,
  projectRoot: root,
  handleSignals: false,
  upstream: `http://127.0.0.1:${stubPort}`,
});
await new Promise((r) => setTimeout(r, 200));

const reqBody = {
  model: "claude-opus-5",
  system: "S".repeat(2000), // chars/4 -> 500
  tools: [{ name: "Read", description: "D".repeat(1000), input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "M".repeat(8000) }],
};

async function send() {
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(reqBody),
  });
  await r.text();
  return r;
}

const res = await send();
assert(res.ok, "proxied request succeeds");
assert(upstreamCalls.messages === 1, "one message forwarded upstream");

// counting is awaited after clientRes.end(), so give the record a moment to land
await new Promise((r) => setTimeout(r, 400));

const audit = await fetch(`http://127.0.0.1:${port}/__token-audit`).then((r) => r.json());
assert(audit.enabled === true, "counter enabled by default");
assert(audit.counted === 1, "one call carries a counted split");

const a = audit.recent.at(-1);
assert(a.measured === 10000, "measured total is input + cache read + cache write");
assert(a.counted.sys === 500, "counted system is the differential against base");
assert(a.counted.tools === 2000, "counted tools is the differential against base");
// conversation is derived, never counted
assert(a.counted.msg === 10000 - 500 - 2000, "conversation derived by subtraction");
assert(upstreamCalls.countBodies.every((b) => b.model === "claude-opus-5"), "counted against the real model");

// the calibrated split must sum to the measured total — that is what makes the
// TOTAL right today and the SPLIT wrong
const calSum = a.calibrated.sys + a.calibrated.tools + a.calibrated.msg;
assert(Math.abs(calSum - 10000) <= 2, "calibrated split still sums to measured");
assert(a.factor > 1, "factor corrects chars/4 upward");
assert(a.delta.prefix === a.counted.sys + a.counted.tools - (a.calibrated.sys + a.calibrated.tools),
  "prefix delta is counted minus calibrated");
assert(typeof a.delta.prefixPct === "number", "prefix delta reported as a percentage");

/* ---- the cache: a warm prefix costs nothing ------------------------------ */
const afterFirst = upstreamCalls.count;
assert(afterFirst === 3, "cold prefix cost three counting calls (base, system, tools)");
await send();
await new Promise((r) => setTimeout(r, 400));
assert(upstreamCalls.count === afterFirst, "identical prefix makes no further counting calls");
const audit2 = await fetch(`http://127.0.0.1:${port}/__token-audit`).then((r) => r.json());
assert(audit2.counted === 2, "second call also carries a counted split");
assert(audit2.counter.hits > 0, "cache hits recorded");

/* ---- counting never breaks the forward path ------------------------------ */
failCounting = true;
reqBody.system = "X".repeat(2000); // new hash, so a fresh count is attempted and fails
const res3 = await send();
assert(res3.ok, "request still succeeds when counting fails");
assert(upstreamCalls.messages === 3, "the message itself still reached upstream");
await new Promise((r) => setTimeout(r, 400));
const audit3 = await fetch(`http://127.0.0.1:${port}/__token-audit`).then((r) => r.json());
assert(audit3.calls === 3, "the failed-count call is still audited");
assert(audit3.recent.at(-1).counted === null, "no counted split when counting fails");
assert(audit3.recent.at(-1).calibrated, "calibrated estimate still present as the fallback");
assert(audit3.counter.errors > 0, "the failure is recorded, not swallowed silently");
failCounting = false;

/* ---- opt-out ------------------------------------------------------------- */
assert(typeof audit.counter.cacheSize === "number", "counter reports cache size");

server.close();
stub.close();
console.log(`token-audit: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
