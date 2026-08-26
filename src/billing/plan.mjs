/**
 * Billing mode — which of Anthropic's metering regimes this traffic is actually on.
 *
 * Every dollar figure Iris prints is tokens × list rate. That is the literal truth
 * on a Console API key and a useful ceiling everywhere else, but on a Pro/Max seat
 * nobody is billed per token at all, and on Bedrock/Vertex/Foundry the list rates
 * in pricing.mjs are the wrong rate card entirely. Printing one number for four
 * regimes is what makes a real figure look invented.
 *
 * So classify the regime from the credential shape on the wire and let every view
 * label its numbers accordingly. Detection is header-shape only — never the token,
 * never a prefix of it, never anything that survives a log write.
 *
 * Sources: https://code.claude.com/docs/en/costs
 *          https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans
 */

/* Cache lifetime is a per-regime fact, not a constant, and it changes what a
   published trim is worth: schemas resident in a live cache keep billing until it
   expires. An hour on a seat, five minutes once credits are in play or on a key. */
export const PLAN_MODES = [
  {
    id: "subscription",
    label: "Subscription seat",
    /* How the mode reads mid-sentence: "…five minutes on a Console API key". Lowercasing
       the label instead mangles the acronym and drops the article. */
    inline: "a subscription seat",
    short: "Pro / Max / Team / Enterprise",
    meter: "5-hour + weekly allowance, shared with Claude chat and Cowork",
    unit: "plan",
    moneyIsReal: false,
    priceBookApplies: true,
    cacheTtlMin: 60,
    why: "Usage is included in the seat. Token spend draws down a rolling allowance rather than a bill, so a dollar figure is what the same traffic would cost on API rates — not what you are charged.",
  },
  {
    id: "credits",
    label: "Usage credits",
    inline: "usage credits",
    short: "subscription past its limit",
    meter: "per token at list rates, against your monthly spend limit",
    unit: "usd",
    moneyIsReal: true,
    priceBookApplies: true,
    cacheTtlMin: 5,
    why: "Past the plan allowance, extra usage bills per token at list rates. Dollar figures here are literal. Cache lifetime also drops from an hour to five minutes, so idle gaps get more expensive.",
  },
  {
    id: "api",
    label: "Console API key",
    inline: "a Console API key",
    short: "pay per token",
    meter: "per token, billed to your Console workspace",
    unit: "usd",
    moneyIsReal: true,
    priceBookApplies: true,
    cacheTtlMin: 5,
    why: "Straight metered billing against a Console workspace. Every figure on this dashboard is what you are charged, before any contracted discount.",
  },
  {
    id: "cloud",
    label: "Cloud provider",
    inline: "a cloud provider",
    short: "Bedrock / Vertex / Foundry",
    meter: "per token, billed to your cloud account at partner rates",
    unit: "tokens",
    moneyIsReal: false,
    priceBookApplies: false,
    cacheTtlMin: 5,
    why: "Billing runs through your cloud account at that partner's own rates, which Iris does not carry. Token counts are exact; dollar figures are withheld rather than guessed from the wrong price book.",
  },
];

export const PLAN_BY_ID = Object.fromEntries(PLAN_MODES.map((m) => [m.id, m]));

export const DEFAULT_PLAN_ID = "subscription";

/** The mode record for an id, falling back to the default rather than undefined. */
export function planFor(id) {
  return PLAN_BY_ID[id] || PLAN_BY_ID[DEFAULT_PLAN_ID];
}

/* Hosts that mean the request is leaving for a partner-operated Claude, where
   pricing.mjs does not apply. Matched on the upstream Iris was pointed at, not on
   anything the client sends, so a spoofed header cannot move the classification. */
const CLOUD_HOST = /(^|\.)(amazonaws\.com|bedrock[^.]*\.|aws\.dev|googleapis\.com|google\.com|azure\.com|azure-api\.net|microsoft\.com|inference\.ai\.azure\.com)$/i;

function upstreamHost(upstream) {
  try {
    return new URL(upstream).host;
  } catch {
    return "";
  }
}

/**
 * Classify one request's credential shape.
 *
 * Precedence follows the SDK's own resolution order: an explicit API key wins over
 * a stored OAuth profile, which is why `x-api-key` outranks `Authorization: Bearer`
 * when a client somehow sends both.
 *
 * @param {Record<string,string|string[]>} headers  incoming request headers
 * @param {string} upstream                          the URL Iris forwards to
 * @returns {{mode:string|null, source:string, signals:string[], confident:boolean}}
 */
export function detectAuthMode(headers = {}, upstream = "") {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) {
    h[String(k).toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v ?? "");
  }

  const host = upstreamHost(upstream);
  const signals = [];

  if (host && CLOUD_HOST.test(host)) {
    signals.push(`upstream ${host}`);
    return { mode: "cloud", source: "upstream host", signals, confident: true };
  }

  const hasApiKey = !!h["x-api-key"];
  const bearer = /^bearer\s+\S/i.test(h["authorization"] || "");
  /* OAuth access tokens carry this beta flag; an API key never does. Corroborating
     only — the Authorization header alone is enough to classify. */
  const oauthBeta = /\boauth-\d{4}-\d{2}-\d{2}\b/.test(h["anthropic-beta"] || "");

  if (hasApiKey) {
    signals.push("x-api-key header");
    if (bearer) signals.push("Authorization also present — key takes precedence");
    return { mode: "api", source: "x-api-key header", signals, confident: true };
  }

  if (bearer) {
    signals.push("Authorization: Bearer");
    if (oauthBeta) signals.push("anthropic-beta: oauth-*");
    /* A bearer token proves an OAuth sign-in, which proves a subscription seat. It
       cannot prove whether that seat is inside its allowance or already drawing on
       usage credits — nothing on the wire says so. Report the seat and let the user
       switch to credits; claiming to know would be the dishonest half. */
    return {
      mode: "subscription",
      source: "OAuth bearer token",
      signals,
      confident: false,
    };
  }

  signals.push("no recognised credential header");
  return { mode: null, source: "unknown", signals, confident: false };
}

/**
 * Running classification across a capture.
 *
 * One request is enough to classify, but a long session can legitimately change
 * credential (a `/login`, an exported key), so keep counts and report the mode the
 * traffic actually used most, plus whether it was ever mixed.
 */
export function createPlanDetector({ upstream = "" } = {}) {
  const counts = Object.create(null);
  const state = {
    mode: null,
    source: "unknown",
    signals: [],
    confident: false,
    observed: 0,
    mixed: false,
    upstreamHost: upstreamHost(upstream),
  };

  function observe(headers) {
    const d = detectAuthMode(headers, upstream);
    if (!d.mode) return state;
    counts[d.mode] = (counts[d.mode] || 0) + 1;
    state.observed++;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    state.mixed = Object.keys(counts).length > 1;
    state.mode = top;
    state.source = d.source;
    state.signals = d.signals;
    state.confident = d.confident && !state.mixed;
    return state;
  }

  function snapshot() {
    return { ...state, counts: { ...counts } };
  }

  function reset() {
    for (const k of Object.keys(counts)) delete counts[k];
    Object.assign(state, {
      mode: null,
      source: "unknown",
      signals: [],
      confident: false,
      observed: 0,
      mixed: false,
    });
  }

  return { observe, snapshot, reset };
}
