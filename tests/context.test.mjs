import { attributeToolResults, rankToolResults, remediationAdvice } from "../src/context/tool-results.mjs";
import { contextDiff } from "../src/context/diff.mjs";
import { simulateTrim } from "../src/context/trim.mjs";
import { calibrate, applyCalibration, sessionFactor } from "../src/context/calibration.mjs";
import { rankTools, estTokens } from "../src/context/schemas.mjs";
import { buildTimeline } from "../src/forensic/timeline.mjs";
import { correlate } from "../src/forensic/correlation.mjs";
import { exportJson, exportCsv } from "../src/forensic/export.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
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

const messages = [
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a/schema.json" } }],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "x".repeat(4000),
      },
    ],
  },
];
const attrs = attributeToolResults(messages);
assert(attrs.length === 1, "one attribution");
assert(attrs[0].toolName === "Read", "tool name");
assert(attrs[0].tokens > 0, "tokens");
assert(rankToolResults(attrs)[0].tokens >= attrs[0].tokens, "rank");
assert(typeof remediationAdvice(attrs[0]) === "string", "advice");

const prev = { system: "hi", tools: [{ name: "A", description: "d", input_schema: {} }], messages: [] };
const next = {
  system: "hi",
  tools: [{ name: "A", description: "d", input_schema: {} }],
  messages: [{ role: "user", content: "x".repeat(400) }],
};
const diff = contextDiff(prev, next);
assert(typeof diff.deltaTokens === "number", "diff delta");

const trim = simulateTrim({
  tools: [
    { name: "A", tokens: 100 },
    { name: "B", tokens: 50 },
  ],
  callCounts: { A: 1, B: 0 },
  denySet: new Set(),
});
assert(trim.removable.some((r) => r.name === "B"), "trim unused");

const factor = calibrate(1000, 800);
assert(factor === 0.8, "calibrate");
assert(applyCalibration(1000, factor) === 800, "applyCalibration");

// The panels that used to ship raw chars/4 carry their sizes in arrays and in
// aggregate fields; calibration has to reach all of them, not just the traffic view.
const scaled = applyCalibration(
  {
    deltaTokens: 100,
    totalTokens: 200,
    parts: [{ kind: "system", tokens: 10 }, { kind: "tools", tokens: 20 }],
    results: [{ toolName: "Read", tokens: 40 }],
    rows: [{ name: "T", tokens: 8 }],
  },
  1.5
);
assert(scaled.deltaTokens === 150 && scaled.totalTokens === 300, "aggregate fields scale");
assert(scaled.parts[0].tokens === 15 && scaled.parts[1].tokens === 30, "context-diff parts scale");
assert(scaled.results[0].tokens === 60, "tool_result attributions scale");
assert(scaled.rows[0].tokens === 12, "tool rows still scale");
assert(scaled.calUsed === 1.5, "factor is reported alongside the numbers");
assert(scaled.parts[0].kind === "system", "non-numeric fields survive untouched");

// sessionFactor: median of measured/estimated over recent records.
const recs = [
  { estSys: 100, estTools: 100, estMsg: 100, in: 300, cr: 0, cw: 0 }, // 1.0
  { estSys: 100, estTools: 100, estMsg: 100, in: 600, cr: 0, cw: 0 }, // 2.0
  { estSys: 100, estTools: 100, estMsg: 100, in: 450, cr: 0, cw: 0 }, // 1.5
];
assert(sessionFactor(recs) === 1.5, "median ratio");
// cache reads and writes are input too, so they belong in the measured side
assert(sessionFactor([{ estSys: 50, estTools: 50, estMsg: 0, in: 50, cr: 100, cw: 50 }]) === 2, "cr+cw counted");
assert(sessionFactor([]) === null, "no records -> null, never a made-up factor");
assert(sessionFactor([{ estSys: 0, estTools: 0, estMsg: 0, in: 100 }]) === null, "zero estimate skipped");
assert(sessionFactor(null) === null, "non-array -> null");
// one absurd outlier must not drag the panel
const withOutlier = [...recs, { estSys: 1, estTools: 0, estMsg: 0, in: 9999, cr: 0, cw: 0 }];
assert(sessionFactor(withOutlier) < 2, "median resists an outlier");

assert(rankTools({ tools: [{ name: "T", input_schema: { type: "object" } }] }).total > 0, "rankTools");
assert(estTokens("abcd") === 1, "estTokens");

const tl = buildTimeline({
  actions: [{ t: "2026-01-01T00:00:01Z", tool: "Read", arg: "a" }],
  requests: [{ kind: "request", time: "2026-01-01T00:00:00Z", id: "1" }],
  decisions: [{ t: "2026-01-01T00:00:02Z", tool: "Bash", decision: "DENY", reason: "prod" }],
});
assert(tl.length >= 2, "timeline");

const corr = correlate({ requestId: "r1", irisUid: "u1", otelAttrs: { "agent.name": "Explore" } });
assert(corr.requestId === "r1" || corr.irisUid === "u1", "correlate");

const dir = mkdtempSync(join(tmpdir(), "iris-ex-"));
exportJson([{ a: 1 }], join(dir, "x.json"));
exportCsv([{ a: 1, b: 2 }], join(dir, "x.csv"));
assert(readFileSync(join(dir, "x.json"), "utf8").includes('"a"'), "export json");
assert(readFileSync(join(dir, "x.csv"), "utf8").includes("a,b"), "export csv");

console.log(`context: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
