import { attributeToolResults, rankToolResults, remediationAdvice } from "../src/context/tool-results.mjs";
import { contextDiff } from "../src/context/diff.mjs";
import { simulateTrim } from "../src/context/trim.mjs";
import { calibrate, applyCalibration } from "../src/context/calibration.mjs";
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
