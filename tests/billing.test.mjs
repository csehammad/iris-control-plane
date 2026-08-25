import { extractUsage } from "../src/billing/usage.mjs";
import { rateFor, costOf } from "../src/billing/pricing.mjs";
import { cacheWritePremium, avoidedByCache } from "../src/billing/cache.mjs";
import { monthlyProjection } from "../src/billing/projections.mjs";

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

const rates = rateFor("claude-opus-5");
const prem = cacheWritePremium({ cw5m: 1000, cw1h: 1000 }, rates);
assert(prem > 0, "write premium");
const avoided = avoidedByCache({ cacheRead: 10000 }, rates);
assert(avoided > 0, "avoided by cache");

const proj = monthlyProjection({ perRequestTokens: 1000, requestsPerDay: 100, ratePerMtok: 5 });
assert(proj.estimated === true, "projection labeled estimated");
assert(proj.usdPerMonth > 0, "monthly > 0");

console.log(`billing: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
