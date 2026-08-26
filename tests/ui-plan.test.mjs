/**
 * Dashboard rendering under each billing mode.
 *
 * plan.test.mjs proves the classifier; server.test.mjs proves the wiring. This
 * proves the part users actually see: that every view renders in all four modes
 * without throwing, and that the labels genuinely change — a seat must not be
 * shown a dollar figure as though it were a bill, and a cloud provider must not
 * be shown one at all. Those are the claims the whole feature rests on, so they
 * are asserted on the real ui/iris.html rather than on a copy of its logic.
 *
 * The page's own script blocks are executed in a vm against a minimal DOM shim.
 * No browser, no dependencies.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as pricing from "../src/billing/pricing.mjs";
import * as planmod from "../src/billing/plan.mjs";

let n = 0,
  fail = 0;
function assert(cond, msg) {
  n++;
  if (!cond) {
    fail++;
    console.error("  FAIL", msg);
  }
}

/* ── DOM shim ───────────────────────────────────────────────────────────────
   Only what the page touches at render time. Every node is inert: the point is
   to exercise the string-building, not to simulate a browser. */
const el = () => ({
  textContent: "", innerHTML: "", value: "", style: {}, dataset: {}, title: "",
  classList: {
    _s: new Set(),
    add(x) { this._s.add(x); },
    remove(x) { this._s.delete(x); },
    toggle(x, f) { f ? this._s.add(x) : this._s.delete(x); },
    contains(x) { return this._s.has(x); },
  },
  getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 40, right: 200 }),
  addEventListener() {}, focus() {}, blur() {}, scrollIntoView() {},
  closest: () => null, querySelector: () => null, querySelectorAll: () => [],
  appendChild() {}, remove() {},
});

const store = new Map();
const ctx = {
  console: { log() {}, error() {}, warn() {} },
  document: {
    title: "", getElementById: () => el(), querySelector: () => el(),
    querySelectorAll: () => [], addEventListener() {},
    body: el(), documentElement: el(), createElement: () => el(),
  },
  localStorage: {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
  EventSource: class { addEventListener() {} close() {} },
  addEventListener() {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: (f) => f(), innerWidth: 1600, innerHeight: 1200,
  location: { hash: "", href: "" }, history: { replaceState() {} },
  navigator: { clipboard: { writeText() {} } },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

const html = readFileSync(new URL("../ui/iris.html", import.meta.url), "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert(blocks.length >= 1, "iris.html carries inline script");
/* boot() would import over http and fetch live routes; everything it sets up is
   seeded directly below instead. */
vm.runInContext(blocks.join("\n;\n").replace(/\nboot\(\);/, "\n"), ctx, { filename: "iris-ui.js" });
const run = (s) => vm.runInContext(s, ctx);

/* ── a capture that looks like a real session ────────────────────────────────
   12 turns, two tool schemas, one of which ships every turn and is never called
   — the exact situation the Optimize page exists to report. */
ctx.__pricing = pricing;
ctx.__plan = planmod;
run(`
({PRICE_BOOK,FAST_MODE,CACHE_MULT,LONG_CTX_THRESHOLD,SERVER_TOOL_RATES,SERVER_TOOL_UNPRICED,rateFor,serverToolFees}=__pricing);
({PLAN_MODES,PLAN_BY_ID,planFor}=__plan);
const t0=Date.parse('2026-08-26T10:00:00Z');
DATA.meta.model='claude-opus-5';
DATA.meta.pricing=rateFor('claude-opus-5');
for(let i=0;i<12;i++){
  DATA.calls.push({id:String(i+1).padStart(4,'0'), time:new Date(t0+i*20000).toISOString(),
    model:'claude-opus-5', in:120, cr:9000, cw:0, out:40, ms:900, status:200, msgCount:i*2+1,
    est:{sys:500,tools:9055,msg:800,total:10355},
    sysTok:500, msgTok:800, toolTotal:9055, sys:[{c:2000,cache:true}], msgs:[], billing:{},
    tools:[{name:'Read',raw:1400},{name:'WebFetch',raw:7655}]});
}
DATA.tools.push({name:'Read', tokens:1400, calls:6, on:true});
DATA.tools.push({name:'WebFetch', tokens:7655, calls:0, on:true});
/* Cost and cache economics are normally stamped by ingestResponse(); these calls
   are seeded directly, so derive the same fields the same way. */
for(const c of DATA.calls){
  c.cw1=0; c.cw5=c.cw; c.breaks=1; c.error=null;
  c.params={max_tokens:8192,temperature:null,stream:true,thinking:null};
  c.cost=costOf(c); c.inCost=inputCostOf(c);
  const ce=cacheEconomicsOf(c);
  c.saved=ce.avoided; c.cachePremium=ce.premium; c.cacheNet=ce.net;
}
S.tw='all';
recalc();
`);
assert(run("T.unpriced") === 0, "fixture: every seeded call is priced");
assert(run("T.cost") > 0, "fixture: the capture has a measured cost");
assert(run("RATE_IN()") > 0, "fixture: a blended input rate was measured");

/* ── every view, every mode, no throws ─────────────────────────────────────── */
const MODES = ["subscription", "credits", "api", "cloud"];
const seed = (m) =>
  run(`PLAN.detected={mode:'${m}',source:'OAuth bearer token',observed:12,confident:true,mixed:false};PLAN.override=null;`);

for (const m of MODES) {
  seed(m);
  for (const v of ["vOverview", "vSpend", "vTools", "vContext", "vTraffic"]) {
    let out = null;
    try { out = run(`${v}()`); } catch (e) { out = e; }
    assert(typeof out === "string" && out.length > 200, `${m}: ${v}() renders (${out?.message || "thin output"})`);
    if (typeof out === "string") assert(!out.includes("${"), `${m}: ${v}() leaves no unresolved template`);
    if (typeof out === "string") assert(!/\bundefined\b|\bNaN\b/.test(out), `${m}: ${v}() prints no undefined/NaN`);
  }
  for (const f of ["helpSheet", "planPop", "paintPlan", "riskFlags"]) {
    let threw = null;
    try { run(`${f}()`); } catch (e) { threw = e; }
    assert(!threw, `${m}: ${f}() does not throw (${threw?.message || ""})`);
  }
}

/* ── the labels must actually differ ────────────────────────────────────────
   This is the feature. If these pass while the copy silently reverts to one
   dollar figure for everyone, the bug is back. */
const view = (m, v) => { seed(m); return run(`${v}()`); };
const seat = view("subscription", "vTools");
const key = view("api", "vTools");
const cloud = view("cloud", "vTools");

assert(seat.includes("on API rates"), "seat: the dollar figure is bracketed as an API-rate projection");
assert(seat.includes("of metered usage"), "seat: the headline is share of metered usage, not dollars");
assert(seat.includes("would cost on API rates"), "seat: the projection card is retitled");
assert(seat.includes("an hour</b> on a subscription seat"), "seat: states the 1-hour cache lifetime");
assert(!seat.includes("these are your actual charges"), "seat: never claims the figures are a bill");

assert(/Shipping now[\s\S]{0,240}\/mo<\/span>/.test(key), "api key: the headline stays a monthly dollar figure");
assert(key.includes("your actual charges"), "api key: says the figures are the bill");
assert(key.includes("five minutes</b> on a Console API key"), "api key: states the 5-minute cache lifetime");
assert(!key.includes("on API rates"), "api key: no redundant cross-plan bracket");

assert(cloud.includes("partner rates — token counts only"), "cloud: withholds the dollar headline");
assert(cloud.includes("partner rates Iris does not carry"), "cloud: explains why");
assert(!cloud.includes("on API rates"), "cloud: offers no dollar projection at all");
assert(!/\$[\d.]+\/Mtok/.test(cloud), "cloud: never quotes a rate from a price book it has disclaimed");
assert(/\$[\d.]+\/Mtok/.test(seat), "seat: still shows the rate it prices the bracket with");

/* Credits are a subscription past its limit: real money, short cache. */
const credits = view("credits", "vTools");
assert(credits.includes("your actual charges"), "credits: dollars are real");
assert(credits.includes("five minutes</b> on usage credits"), "credits: cache drops to five minutes");
assert(!cloud.includes("Per month"), "cloud: the money columns are dropped, not disclaimed");
assert(cloud.includes("Share of metered usage"), "cloud: tokens are re-expressed as a share instead");

/* ── the help sheet ─────────────────────────────────────────────────────────── */
seed("subscription");
const help = run("helpSheet()");
for (const m of planmod.PLAN_MODES) {
  assert(help.includes(m.label), `help sheet documents "${m.label}"`);
}
assert(help.includes("OAuth bearer token"), "help sheet reports what was actually detected");
assert(help.includes("How much allowance you have left"), "help sheet states what Iris cannot know");
assert(/\$[\d.]+\/Mtok/.test(help), "help sheet quotes the measured rate it prices with");
assert(!help.includes("${"), "help sheet leaves no unresolved template");
assert(!/\bundefined\b/.test(help), "help sheet prints no undefined");

/* ── the override ───────────────────────────────────────────────────────────
   Detection cannot see usage credits, so the manual choice has to win — and
   picking the detected value must mean "follow detection", not pin it. */
run(`PLAN.override='credits';`);
assert(run("planId()") === "credits", "an override wins over detection");
assert(run("planAuto()") === false, "an override is reported as manual");
assert(run("moneyReal()") === true, "credits make the dollar figures real");
assert(run("plan().cacheTtlMin") === 5, "credits shorten the assumed cache lifetime");
run(`setPlan('subscription')`);
assert(run("PLAN.override") === null, "choosing the detected mode clears the override rather than pinning it");
run(`PLAN.detected=null;PLAN.override=null;`);
assert(run("planId()") === "subscription", "with nothing detected, the seat default applies");

/* ── Wiring alert ───────────────────────────────────────────────────────────
   The failure this guards against is a silent one: Iris renders "waiting for the
   agent" while every turn goes to another port, and the user concludes the tool is
   broken. Each state must name the port, say what it means, and give the fix. */
const wiringFor = (w) => { run(`LIVE.wiring=${JSON.stringify(w)};`); return run("wiringAlert()"); };

assert(wiringFor({ state: "ok", boundPort: 8787, agentPort: 8787, autowire: true }) === null,
  "wiring: correct routing raises no alert");
assert(run("LIVE.wiring=null; wiringAlert()") === null, "wiring: an unknown state raises no alert");

const elsewhere = wiringFor({
  state: "elsewhere", url: "http://127.0.0.1:8787", agentPort: 8787, boundPort: 8789,
  autowire: false, settingsPath: "/p/.claude/settings.json",
});
assert(typeof elsewhere === "string", "wiring: a port mismatch raises an alert");
assert(elsewhere.includes("8787") && elsewhere.includes("8789"), "wiring: names both ports");
assert(elsewhere.includes("IRIS_AUTOWIRE=0"), "wiring: says why Iris did not fix it itself");
assert(elsewhere.includes("settings.json"), "wiring: points at the file to change");
assert(!elsewhere.includes("${"), "wiring: leaves no unresolved template");

const unset = wiringFor({ state: "unset", boundPort: 8787, autowire: true, settingsPath: "/p/.claude/settings.json" });
assert(unset.includes("not routed through Iris"), "wiring: an unset base URL is called out");
assert(unset.includes("iris init"), "wiring: an unset base URL gets the init command");
assert(!unset.includes("IRIS_AUTOWIRE=0"), "wiring: no autowire note when autowire is on");

for (const st of ["external", "unparseable", "no-settings"]) {
  const a = wiringFor({ state: st, url: "https://gw.example.com", boundPort: 8787, agentPort: 443, autowire: true, settingsPath: "/p/s.json" });
  assert(typeof a === "string" && a.length > 80, `wiring: ${st} produces an alert`);
  assert(!a.includes("${") && !/\bundefined\b/.test(a), `wiring: ${st} renders cleanly`);
}

/* The waiting screen must change its headline, not just append a note — the old
   copy claimed Iris was "attached" and ready, which is the misleading part. */
run(`LIVE.wiring={state:'elsewhere',url:'http://127.0.0.1:8787',agentPort:8787,boundPort:8789,autowire:false,settingsPath:'/p/s.json'};`);
const waitBad = run("vWaiting()");
assert(waitBad.includes("Nothing is reaching this proxy"), "waiting screen: headline states the real problem");
assert(!waitBad.includes("Waiting for the agent to talk"), "waiting screen: drops the misleading headline");
assert(waitBad.includes("Agent points at"), "waiting screen: shows where traffic is actually going");
run(`LIVE.wiring={state:'ok',url:'http://127.0.0.1:8789',agentPort:8789,boundPort:8789,autowire:true};`);
const waitOk = run("vWaiting()");
assert(waitOk.includes("Waiting for the agent to talk"), "waiting screen: keeps the normal headline when wiring is fine");

/* Overview must flag it too — with old history on screen, the waiting view never
   renders, and stale numbers are the most misleading state of all. */
run(`LIVE.wiring={state:'elsewhere',url:'http://127.0.0.1:8787',agentPort:8787,boundPort:8789,autowire:false,settingsPath:'/p/s.json'};`);
const flags = run("riskFlags()");
assert(flags[0] && /pointed at port 8787/.test(flags[0].title), "overview: the wiring flag outranks every other signal");
assert(flags[0].sev === "bad", "overview: a misrouted agent is a hard failure, not a warning");
assert(/history, not what is happening now/.test(flags[0].body), "overview: says the numbers on screen are stale");
run(`LIVE.wiring={state:'ok',boundPort:8789,agentPort:8789,autowire:true};`);
assert(!run("riskFlags()").some((f) => /pointed at port/.test(f.title)), "overview: no wiring flag when routing is correct");

/* ── Empty states ───────────────────────────────────────────────────────────
   A page with no data is where a user decides whether the tool is working or
   broken, so the empty state has to answer that rather than just apologise. */
run(`HIST.records=[]; HIST.building=false; HIST.logDir='/p/.claude/proxy-logs';`);
run(`LIVE.connected=true; LIVE.port=8787;`);

/* Correctly wired but idle: explain what the page is for. */
run(`LIVE.wiring={state:'ok',url:'http://127.0.0.1:8787',agentPort:8787,boundPort:8787,autowire:true};`);
seed("subscription");
let empty = run("vSpend()");
assert(empty.includes("What appears here once a turn lands"), "empty Spend: says what the page will show");
assert(empty.includes("Cache expiries"), "empty Spend: lists the measures it produces");
assert(empty.includes("listening on :8787"), "empty Spend: reports the proxy is up");
assert(empty.includes("Subscription seat"), "empty Spend: reports the billing mode");
assert(empty.includes("/p/.claude/proxy-logs"), "empty Spend: says where the ledger comes from");
assert(empty.includes("an hour</b> on a subscription seat"), "empty Spend: cache lifetime matches the mode");
assert(empty.includes("API-rate equivalent, not a bill"), "empty Spend: a seat is told what its figures mean");
assert(!empty.includes("${") && !/\bundefined\b/.test(empty), "empty Spend: renders cleanly");

seed("api");
empty = run("vSpend()");
assert(empty.includes("this is what you are charged"), "empty Spend: an API key is told the figures are its bill");
assert(empty.includes("five minutes</b> on a Console API key"), "empty Spend: cache lifetime follows the mode");
seed("cloud");
empty = run("vSpend()");
assert(empty.includes("Token counts only"), "empty Spend: a cloud provider is told dollars are withheld");

/* Misrouted: the empty state must blame the routing, not imply idleness. */
run(`LIVE.wiring={state:'elsewhere',url:'http://127.0.0.1:9999',agentPort:9999,boundPort:8787,autowire:false,settingsPath:'/p/s.json'};`);
seed("subscription");
empty = run("vSpend()");
assert(empty.includes("not sending its traffic to this proxy"), "empty Spend: names routing as the cause");
assert(empty.includes("9999") && empty.includes("8787"), "empty Spend: carries the wiring alert with both ports");
/* Both may show, but the fix has to come first on the page — an explainer above
   the alert would bury the one thing the user needs to act on. */
assert(empty.indexOf("not sending its traffic") < empty.indexOf("What appears here once a turn lands"),
  "empty Spend: the routing fix is placed above the explainer, not below it");

/* Indexing: neither of the above, just say so. */
run(`HIST.building=true;`);
empty = run("vSpend()");
assert(empty.includes("indexing its logs"), "empty Spend: an indexing pass is reported as such");
run(`HIST.building=false;`);

/* Data exists but not in this range — offer the fix rather than a dead end. */
/* HW is a const the page mutates in place; drive it through the real path by
   putting the ledger rows outside the selected window and recalculating. */
run(`HIST.records=[{time:'2026-08-01T10:00:00Z',cost:1},{time:'2026-08-02T10:00:00Z',cost:1}];
     DATA.calls.length=0; S.tw='hour'; recalc();`);
assert(run("HW.records.length") === 0, "narrow range: the window genuinely excludes the ledger rows");
assert(run("HIST.records.length") === 2, "narrow range: the ledger still holds them");
const narrow = run("vSpend()");
assert(narrow.includes("data-setw=\"all\""), "narrow range: offers a control to widen it");
assert(narrow.includes("2026-08-01"), "narrow range: says how far the ledger goes back");
assert(narrow.includes("Show all 2"), "narrow range: says how many rows are waiting");

console.log(`ui-plan: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
