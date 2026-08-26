import { collectFleet, fleetSummary, summarise, listProjects, readLedger, ledgerPathFor } from "../src/billing/fleet.mjs";
import { createHistoryLedger } from "../src/billing/history.mjs";
import { writeJsonAtomic } from "../src/runtime/atomic.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

/* ── atomic writes ──────────────────────────────────────────────────────────
   The property the fleet total depends on: a reader never sees a fragment. A
   torn ledger read is not an error — the reader treats it as "no records" — so
   without atomicity a project silently contributes zero to a cross-project sum. */
const aRoot = mkdtempSync(join(tmpdir(), "iris-atomic-"));
const aPath = join(aRoot, "ledger.json");

writeJsonAtomic(aPath, { records: [{ uid: "a" }] });
assert(JSON.parse(readFileSync(aPath, "utf8")).records.length === 1, "atomic: writes the file");

writeJsonAtomic(aPath, { records: [{ uid: "a" }, { uid: "b" }] });
assert(JSON.parse(readFileSync(aPath, "utf8")).records.length === 2, "atomic: replaces in place");

/* No temp file may survive a successful write — a directory slowly filling with
   .tmp files is its own bug. */
assert(
  readdirSync(aRoot).filter((f) => f.endsWith(".tmp")).length === 0,
  "atomic: leaves no temp file behind"
);

writeJsonAtomic(aPath, { records: [] }, { indent: 2, trailingNewline: true });
const pretty = readFileSync(aPath, "utf8");
assert(pretty.endsWith("\n"), "atomic: honours trailingNewline");
assert(pretty.includes("\n  "), "atomic: honours indent");

/* A failed write must not leave a temp file, and must not swallow the error —
   callers decide whether a failed persist is fatal. */
let threw = false;
try {
  writeJsonAtomic(join(aRoot, "no-such-dir", "x.json"), { a: 1 });
} catch {
  threw = true;
}
assert(threw, "atomic: an unwritable path throws rather than failing silently");
assert(
  readdirSync(aRoot).filter((f) => f.endsWith(".tmp")).length === 0,
  "atomic: cleans up its temp file when the write fails"
);

/* The previous contents must survive a failed write of the same file. */
writeJsonAtomic(aPath, { records: [{ uid: "keep" }] });
const before = readFileSync(aPath, "utf8");
try {
  writeJsonAtomic(aPath, { bad: 1n });   // BigInt is not JSON-serialisable
} catch {
  /* expected */
}
assert(readFileSync(aPath, "utf8") === before, "atomic: a failed write leaves the old file intact");

/* ── a synthetic machine with several projects ──────────────────────────── */
const home = mkdtempSync(join(tmpdir(), "iris-fleet-home-"));
const work = mkdtempSync(join(tmpdir(), "iris-fleet-work-"));

function project(id, name, { records = null, ledger = "ok", exists = true } = {}) {
  mkdirSync(join(home, "projects", id), { recursive: true });
  const cwd = join(work, name);
  writeFileSync(
    join(home, "projects", id, "project.json"),
    JSON.stringify({ id, name, cwd, createdAt: "2026-08-01T00:00:00.000Z" })
  );
  if (!exists) return cwd;
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  if (ledger === "none") return cwd;
  const p = ledgerPathFor(cwd);
  if (ledger === "corrupt") writeFileSync(p, "{ this is not json");
  else writeJsonAtomic(p, { builtAt: "2026-08-26T10:00:00.000Z", records: records || [] });
  return cwd;
}

/* Deliberately colliding `id` values across projects: they are per-session
   counters, and a fleet total that keys on them loses rows. */
const alpha = [
  { uid: "u-a-1", id: "0001", time: "2026-08-20T10:00:00Z", model: "claude-opus-5", in: 100, cr: 900, cw: 0, out: 10 },
  { uid: "u-a-2", id: "0002", time: "2026-08-21T10:00:00Z", model: "claude-opus-5", in: 100, cr: 900, cw: 0, out: 10 },
];
const beta = [
  { uid: "u-b-1", id: "0001", time: "2026-08-22T10:00:00Z", model: "claude-sonnet-5", in: 50, cr: 400, cw: 0, out: 5 },
];

project("p-alpha", "alpha", { records: alpha });
project("p-beta", "beta", { records: beta });
project("p-empty", "empty", { records: [] });
project("p-noledger", "noledger", { ledger: "none" });
project("p-corrupt", "corrupt", { ledger: "corrupt" });
project("p-gone", "gone", { exists: false });

/* ── listing ────────────────────────────────────────────────────────────── */
const listed = listProjects({ home });
assert(listed.length === 6, `lists every registered project (got ${listed.length})`);
assert(listed.map((p) => p.name).join(",") === "alpha,beta,corrupt,empty,gone,noledger", "listed in name order");
assert(listProjects({ home: join(home, "nope") }).length === 0, "a missing registry is an empty fleet, not an error");

/* One unparseable project.json must not hide the others. */
mkdirSync(join(home, "projects", "p-bad"), { recursive: true });
writeFileSync(join(home, "projects", "p-bad", "project.json"), "not json");
assert(listProjects({ home }).length === 6, "a corrupt registry entry is skipped, the rest survive");
rmSync(join(home, "projects", "p-bad"), { recursive: true, force: true });

/* ── per-ledger states ──────────────────────────────────────────────────── */
assert(readLedger(join(work, "alpha")).state === "ok", "a ledger with rows reads ok");
assert(readLedger(join(work, "empty")).state === "empty", "a ledger with no rows reads empty");
assert(readLedger(join(work, "noledger")).state === "empty", "a project with no ledger file reads empty");
assert(readLedger(join(work, "gone")).state === "gone", "a deleted project reads gone");
/* The distinction that matters: unreadable is not zero. */
const corrupt = readLedger(join(work, "corrupt"));
assert(corrupt.state === "unreadable", "an unparseable ledger reads unreadable, never empty");
assert(corrupt.records.length === 0, "an unreadable ledger yields no rows");
assert(readLedger(join(work, "alpha")).builtAt === "2026-08-26T10:00:00.000Z", "builtAt is reported for staleness");

/* ── the fleet ──────────────────────────────────────────────────────────── */
const f = collectFleet({ home, currentId: "p-beta" });

assert(f.totals.projects === 6, "counts every registered project");
assert(f.totals.contributing === 2, "counts only projects with rows as contributing");
assert(f.totals.calls === 3, "sums rows across projects at unrelated paths");
assert(f.totals.unreadable === 1, "reports how many ledgers could not be read");
assert(f.totals.gone === 1, "reports how many projects no longer exist");

assert(f.records.length === 3, "collects every row");
assert(new Set(f.records.map((r) => r.uid)).size === 3, "uid stays unique fleet-wide");
/* The trap this guards: two projects both have a call with id 0001. */
assert(new Set(f.records.map((r) => r.id)).size === 2, "id genuinely collides across projects — do not key on it");
assert(f.records.every((r) => r.projectName && r.projectId), "every row is tagged with its origin");
assert(f.records.filter((r) => r.projectName === "alpha").length === 2, "rows are attributed to the right project");

/* Pricing inputs must survive the tagging, or the caller cannot price them. */
assert(
  f.records.every((r) => ["model", "in", "cr", "cw", "out"].every((k) => k in r)),
  "tagging preserves the pricing inputs"
);
assert(!f.records.some((r) => "cost" in r), "no cost is baked in — one price book prices the fleet");

const current = f.projects.find((p) => p.current);
assert(current && current.id === "p-beta", "the current project is flagged exactly once");
assert(f.projects.filter((p) => p.current).length === 1, "only one project is current");
assert(collectFleet({ home }).projects.every((p) => !p.current), "with no currentId, nothing is current");

/* An unreadable project must appear in the listing rather than vanishing — its
   spend is unknown, and a total that hides it reads as complete when it is not. */
const corruptRow = f.projects.find((p) => p.name === "corrupt");
assert(corruptRow && corruptRow.state === "unreadable", "an unreadable project still appears in the listing");
assert(corruptRow.calls === 0, "an unreadable project contributes no rows");

/* ── summarisation ──────────────────────────────────────────────────────────
   Pricing moved server-side so the response is O(projects), not O(calls). It must
   use the same book the dashboard does, and treat an unknown model the same way. */
const priced = summarise([
  { time: "2026-08-20T10:00:00Z", model: "claude-opus-5", in: 1000, cr: 2000, cw: 0, cw5: 0, cw1: 0, out: 100 },
  { time: "2026-08-20T12:00:00Z", model: "claude-opus-5", in: 1000, cr: 2000, cw: 0, cw5: 0, cw1: 0, out: 100 },
]);
assert(priced.calls === 2, "summarise: counts calls");
assert(priced.cost > 0, "summarise: prices known models");
assert(priced.tok === 6000, "summarise: input+cache tokens, output excluded");
assert(priced.out === 200, "summarise: output counted separately");
assert(priced.activeDays === 1, "summarise: two calls on one day is one active day");
assert(priced.unpriced === 0, "summarise: nothing unpriced when the model is known");

const unknown = summarise([{ time: "2026-08-20T10:00:00Z", model: "not-a-real-model", in: 500, cr: 0, cw: 0, out: 5 }]);
assert(unknown.unpriced === 1, "summarise: an unknown model is counted as unpriced");
assert(unknown.cost === 0, "summarise: an unknown model adds no cost rather than a fake zero-rate one");
assert(unknown.tok === 500, "summarise: an unpriced call still contributes tokens");

assert(summarise([]).calls === 0 && summarise([]).activeDays === 0, "summarise: an empty ledger is all zeroes");

/* ── fleet summary ──────────────────────────────────────────────────────── */
const fs1 = fleetSummary({ home, currentId: "p-beta" });
assert(fs1.records === undefined, "fleetSummary: rows are not shipped by default");
assert(fs1.projects.length === 6, "fleetSummary: every project appears");
assert(fs1.totals.calls === 3, "fleetSummary: totals sum across projects");
assert(fs1.totals.unreadable === 1, "fleetSummary: unreadable ledgers are reported, not silently zeroed");
assert(fs1.projects.every((p) => typeof p.cost === "number"), "fleetSummary: every project carries a priced cost");
assert(fs1.projects.find((p) => p.name === "beta").current === true, "fleetSummary: flags the current project");
assert(fleetSummary({ home, withRecords: true }).records.length === 3, "fleetSummary: rows on request for debugging");

/* Active days across projects is a union. alpha worked 08-20 and 08-21; a third
   project working 08-21 must not make that day count twice. */
project("p-overlap", "overlap", {
  records: [{ uid: "u-o-1", id: "0001", time: "2026-08-21T09:00:00Z", model: "claude-opus-5", in: 10, cr: 0, cw: 0, out: 1 }],
});
const fs2 = fleetSummary({ home });
const summed = fs2.projects.reduce((a, p) => a + p.activeDays, 0);
assert(summed === 4, "fixture: per-project days would sum to 4");
assert(fs2.totals.activeDays === 3, "fleetSummary: active days is a union of dates, not a sum");

/* ── mtime cache ────────────────────────────────────────────────────────── */
const beforeCost = fleetSummary({ home }).totals.cost;
assert(fleetSummary({ home }).totals.cost === beforeCost, "cache: a repeat read is stable");
/* A write by another instance must invalidate — the stamp is size+mtime, and an
   atomic rename changes both. */
await new Promise((r) => setTimeout(r, 12));
writeJsonAtomic(ledgerPathFor(join(work, "alpha")), {
  builtAt: "2026-08-26T11:00:00.000Z",
  records: [...alpha, { uid: "u-a-3", id: "0003", time: "2026-08-23T10:00:00Z", model: "claude-opus-5", in: 10, cr: 0, cw: 0, out: 1 }],
});
assert(fleetSummary({ home }).totals.calls === 5, "cache: a co-resident write is picked up, not served stale");

/* ── merge-on-write ─────────────────────────────────────────────────────────
   Two Iris instances can serve one project. Each holds the whole ledger and
   rewrites it, so without a merge the second save discards the first's calls. */
const mRoot = mkdtempSync(join(tmpdir(), "iris-merge-"));
const mPath = join(mRoot, "history-index.json");
const mkRec = (uid, time) => ({ uid, id: uid, time, model: "claude-opus-5", in: 1, cr: 0, cw: 0, cw5: 0, cw1: 0, out: 1 });

const A = createHistoryLedger({ path: mPath, logDir: mRoot });
const B = createHistoryLedger({ path: mPath, logDir: mRoot });

/* addHistory, not records.push — the getter exposes the live array, and pushing
   to it directly bypasses the uid index that dedupe and merge both rely on. */
A.addHistory(mkRec("uid-A1", "2026-08-26T10:00:00Z"));
A.save();
assert(JSON.parse(readFileSync(mPath, "utf8")).records.length === 1, "merge: first instance persists its call");

/* B started empty and never saw A's write. A naive save would truncate to B's
   own view and A's call would be gone. */
B.addHistory(mkRec("uid-B1", "2026-08-26T10:00:05Z"));
B.save();
const merged = JSON.parse(readFileSync(mPath, "utf8")).records;
assert(merged.length === 2, `merge: both instances' calls survive (got ${merged.length})`);
const uids = merged.map((r) => r.uid);
assert(uids.includes("uid-A1") && uids.includes("uid-B1"), "merge: neither instance's call is lost");

/* Idempotent: saving again must not duplicate what was just adopted. */
B.save();
assert(JSON.parse(readFileSync(mPath, "utf8")).records.length === 2, "merge: re-saving does not duplicate rows");

/* Merged rows land in time order so the FIFO cap evicts the oldest, not whatever
   arrived last. */
A.addHistory(mkRec("uid-A2", "2026-08-26T09:00:00Z"));   // deliberately older
A.save();
const times = JSON.parse(readFileSync(mPath, "utf8")).records.map((r) => r.time);
assert(times.join() === [...times].sort().join(), "merge: the persisted ledger stays in time order");

/* A merge must be able to run repeatedly without growth — the flush happens every
   20 calls, so this path is hit constantly in a long session. */
const stableBefore = JSON.parse(readFileSync(mPath, "utf8")).records.length;
A.save(); B.save(); A.save();
assert(
  JSON.parse(readFileSync(mPath, "utf8")).records.length === stableBefore,
  "merge: repeated saves from both instances converge rather than growing"
);

console.log(`fleet: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
