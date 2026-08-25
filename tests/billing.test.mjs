import { extractUsage } from "../src/billing/usage.mjs";
import { rateFor, costOf, serverToolFees } from "../src/billing/pricing.mjs";
import { cacheWritePremium, avoidedByCache } from "../src/billing/cache.mjs";
import { monthlyProjection } from "../src/billing/projections.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let n = 0,
  fail = 0;
function assert(cond, msg) {
  n++;
  if (!cond) {
    fail++;
    console.error("  FAIL", msg);
  }
}

const sse = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":50,"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":40}}}}',
  'data: {"type":"message_delta","usage":{"output_tokens":20}}',
].join("\n");
const u = extractUsage(sse);
assert(u.input === 10, "input");
assert(u.cacheRead === 100, "cache read");
assert(u.cw1h === 40, "1h write");
assert(u.cw5m === 10, "5m write");
assert(u.output === 20, "output");

assert(rateFor("claude-opus-5-20250101")?.input === 5, "opus 5 rate");
assert(rateFor("totally-unknown-model") === null, "unknown null");
assert(costOf({ input: 1_000_000, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 }, "claude-opus-5") === 5, "costOf");

// Sonnet 5 is $2/$10. The scheduled 2026-09-01 step-up to $3/$15 was cancelled by
// Anthropic, so this must not drift upward on a date boundary.
assert(rateFor("claude-sonnet-5")?.input === 2, "sonnet 5 input stays $2");
assert(rateFor("claude-sonnet-5")?.output === 10, "sonnet 5 output stays $10");
assert(rateFor("claude-sonnet-4-6")?.input === 3, "sonnet 4.6 input");

// Rate modifiers must be applied, not silently dropped.
const fast = rateFor("claude-opus-5", { speed: "fast" });
assert(fast.input === 10 && fast.output === 50, "fast mode doubles opus 5 base");
assert(fast.cw1h === 20 && fast.cacheRead === 1, "cache multipliers ride on the fast base");
assert(/fast mode/.test(fast.note), "fast mode noted");
assert(rateFor("claude-opus-4-7", { speed: "fast" }).input === 5, "no fast mode on opus 4.7");

assert(rateFor("claude-opus-5", { batch: true }).input === 2.5, "batch -50%");
assert(Math.abs(rateFor("claude-opus-5", { inferenceGeo: "us" }).output - 27.5) < 1e-9, "us residency x1.1");
assert(rateFor("claude-opus-5", { serviceTier: "priority" }).unknownTier === "priority", "unknown tier surfaced");
assert(rateFor("claude-opus-5", { serviceTier: "standard" }).unknownTier === null, "standard tier is not flagged");

// Long context is a mechanism with no rows in it: 1M-window models bill at standard rates.
assert(rateFor("claude-opus-5", null, 900_000).input === 5, "1M window bills at standard rates");
assert(rateFor("claude-opus-5[1m]")?.input === 5, "context suffix stripped");

// costOf threads billing through to the rate card.
assert(costOf({ output: 1_000_000 }, "claude-opus-5", { speed: "fast" }) === 50, "costOf applies fast mode");
assert(costOf({ input: 1_000_000 }, "claude-opus-5", { batch: true }) === 2.5, "costOf applies batch");
assert(costOf({ input: 1 }, "totally-unknown-model") === null, "unpriced model returns null, not 0");

// Server tools bill on top of tokens; unrateable ones are surfaced, not costed at zero.
const stf = serverToolFees({ web_search_requests: 3, web_fetch_requests: 2, code_execution_requests: 1 });
assert(Math.abs(stf.usd - 0.03) < 1e-9, "web search at $10/1k");
assert(stf.unpriced.length === 1 && stf.unpriced[0].count === 1, "code execution left unpriced");
assert(serverToolFees(null).usd === 0, "no server tools is $0");

const rates = rateFor("claude-opus-5");
const prem = cacheWritePremium({ cw5m: 1000, cw1h: 1000 }, rates);
assert(prem > 0, "write premium");
const avoided = avoidedByCache({ cacheRead: 10000 }, rates);
assert(avoided > 0, "avoided by cache");

// Single source: pricing.mjs is the only price book. Both UIs import it over
// /__pricing.mjs rather than declaring their own — three copies is how the
// cancelled Sonnet 5 step-up and classic.html's retired Opus 4.1 rates survived.
for (const ui of ["iris", "classic"]) {
  const html = readFileSync(join(ROOT, "ui", `${ui}.html`), "utf8");
  assert(/["'\/]__pricing\.mjs/.test(html), `${ui}.html imports the shared price book`);
  assert(!/\bconst\s+(PRICE_BOOK|PRICING)\s*=/.test(html), `${ui}.html declares no price book of its own`);
  assert(!/claude-opus-5['"]?\s*,?\s*(label|in)\s*:/.test(html), `${ui}.html holds no model rate rows`);
}
// The server must actually be able to hand that file to the browser.
assert(
  /url === "\/__pricing\.mjs"/.test(readFileSync(join(ROOT, "src/runtime/server.mjs"), "utf8")),
  "server routes /__pricing.mjs",
);

const proj = monthlyProjection({ perRequestTokens: 1000, requestsPerDay: 100, ratePerMtok: 5 });
assert(proj.estimated === true, "projection labeled estimated");
assert(proj.usdPerMonth > 0, "monthly > 0");

console.log(`billing: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
