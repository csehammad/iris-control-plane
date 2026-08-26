import {
  detectAuthMode,
  createPlanDetector,
  planFor,
  PLAN_MODES,
  PLAN_BY_ID,
  DEFAULT_PLAN_ID,
} from "../src/billing/plan.mjs";

let n = 0,
  fail = 0;
function assert(cond, msg) {
  n++;
  if (!cond) {
    fail++;
    console.error("  FAIL", msg);
  }
}

const ANTHROPIC = "https://api.anthropic.com";

/* ── classification ─────────────────────────────────────────────────────── */

const key = detectAuthMode({ "x-api-key": "sk-ant-api03-xxx" }, ANTHROPIC);
assert(key.mode === "api", "x-api-key classifies as Console API key");
assert(key.confident === true, "an API key is a conclusive signal");

const oauth = detectAuthMode(
  { authorization: "Bearer sk-ant-oat01-xxx", "anthropic-beta": "oauth-2025-04-20" },
  ANTHROPIC
);
assert(oauth.mode === "subscription", "bearer token classifies as a seat");
assert(
  oauth.confident === false,
  "a seat cannot be proven to be inside its allowance, so never confident"
);
assert(
  oauth.signals.some((x) => x.includes("oauth-")),
  "the oauth beta flag is recorded as corroboration"
);

/* The SDK resolves an explicit key ahead of a stored profile, so a request
   carrying both is an API-key request. */
const both = detectAuthMode(
  { "x-api-key": "sk-ant-api03-xxx", authorization: "Bearer sk-ant-oat01-xxx" },
  ANTHROPIC
);
assert(both.mode === "api", "x-api-key outranks Authorization");

/* Header casing is not guaranteed, and node lowercases while other callers may not. */
const upper = detectAuthMode({ "X-Api-Key": "sk-ant-api03-xxx" }, ANTHROPIC);
assert(upper.mode === "api", "header lookup is case-insensitive");

const arrayed = detectAuthMode({ authorization: ["Bearer sk-x"] }, ANTHROPIC);
assert(arrayed.mode === "subscription", "array-valued headers are joined, not stringified as objects");

assert(detectAuthMode({}, ANTHROPIC).mode === null, "no credential means no claim");
assert(
  detectAuthMode({ authorization: "Bearer" }, ANTHROPIC).mode === null,
  "a bearer scheme with no token is not a credential"
);

/* ── cloud providers beat every header ──────────────────────────────────── */

for (const host of [
  "https://bedrock-runtime.us-east-1.amazonaws.com",
  "https://us-central1-aiplatform.googleapis.com",
  "https://my-resource.inference.ai.azure.com",
]) {
  const d = detectAuthMode({ "x-api-key": "sk-ant-api03-xxx" }, host);
  assert(d.mode === "cloud", `${host} classifies as a cloud provider`);
  assert(d.confident === true, "the upstream Iris was pointed at is conclusive");
}
assert(
  detectAuthMode({ "x-api-key": "k" }, "not a url").mode === "api",
  "an unparseable upstream falls through to header classification"
);

/* ── the mode table ─────────────────────────────────────────────────────── */

assert(PLAN_MODES.length === 4, "four metering regimes");
for (const m of PLAN_MODES) {
  assert(typeof m.id === "string" && !!PLAN_BY_ID[m.id], `${m.id} is indexed`);
  assert(m.cacheTtlMin === 5 || m.cacheTtlMin === 60, `${m.id} carries a real cache TTL`);
  assert(!!m.label && !!m.meter && !!m.why, `${m.id} carries UI copy`);
}
/* Cache lifetime is an hour only on a seat inside its allowance — the moment
   credits are in play it drops to five minutes, and that changes what a trim
   is worth. Pin it so the copy on the dashboard cannot silently go wrong. */
assert(PLAN_BY_ID.subscription.cacheTtlMin === 60, "seat: 1h cache");
assert(PLAN_BY_ID.credits.cacheTtlMin === 5, "credits: 5m cache");
assert(PLAN_BY_ID.api.cacheTtlMin === 5, "api key: 5m cache");
/* Dollars are the literal bill only where per-token billing is happening. */
assert(PLAN_BY_ID.subscription.moneyIsReal === false, "a seat is not billed per token");
assert(PLAN_BY_ID.credits.moneyIsReal === true, "credits are billed per token");
assert(PLAN_BY_ID.api.moneyIsReal === true, "an API key is billed per token");
assert(PLAN_BY_ID.cloud.priceBookApplies === false, "partner rates are not in our price book");

assert(planFor("api").id === "api", "planFor resolves a known id");
assert(planFor("nonsense").id === DEFAULT_PLAN_ID, "planFor falls back rather than returning undefined");
assert(planFor(undefined).id === DEFAULT_PLAN_ID, "planFor tolerates a missing id");

/* ── running detection across a capture ─────────────────────────────────── */

const det = createPlanDetector({ upstream: ANTHROPIC });
assert(det.snapshot().mode === null, "nothing claimed before any traffic");
assert(det.snapshot().observed === 0, "nothing observed before any traffic");

det.observe({ authorization: "Bearer sk-x" });
det.observe({ authorization: "Bearer sk-x" });
let snap = det.snapshot();
assert(snap.mode === "subscription", "settles on the observed mode");
assert(snap.observed === 2, "counts classified requests");
assert(snap.mixed === false, "one credential is not mixed");

/* Requests with no credential must not be counted — they are noise (health
   checks, preflights), not evidence of a regime. */
det.observe({});
assert(det.snapshot().observed === 2, "unclassifiable requests are not counted");

/* A /login mid-capture legitimately changes credential. Report the dominant
   mode but stop claiming confidence. */
det.observe({ "x-api-key": "sk-ant-api03-x" });
snap = det.snapshot();
assert(snap.mixed === true, "two credentials is mixed");
assert(snap.mode === "subscription", "the majority credential wins");
assert(snap.confident === false, "mixed traffic is never confident");
det.observe({ "x-api-key": "sk-ant-api03-x" });
det.observe({ "x-api-key": "sk-ant-api03-x" });
assert(det.snapshot().mode === "api", "the mode flips once the key is the majority");

det.reset();
snap = det.snapshot();
assert(snap.mode === null && snap.observed === 0 && snap.mixed === false, "reset clears the classification");

/* ── the credential itself must never survive ───────────────────────────── */

const secret = "sk-ant-oat01-SUPERSECRETVALUE";
const leak = createPlanDetector({ upstream: ANTHROPIC });
leak.observe({ authorization: `Bearer ${secret}`, "x-api-key": undefined });
const serialized = JSON.stringify(leak.snapshot());
assert(!serialized.includes(secret), "no token in the snapshot");
assert(!serialized.includes("SUPERSECRET"), "not even a fragment of the token");
assert(!serialized.includes(secret.slice(0, 12)), "not a prefix of the token");

console.log(`plan: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
