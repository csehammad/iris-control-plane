/**
 * Drive Guard so the demo frames show real decisions.
 *
 * Guard decisions come from the PreToolUse hook, not from proxy traffic, so a
 * capture built only from /v1/messages leaves the Guard and Flight Recorder
 * views empty — which is exactly the wrong impression for a screenshot.
 *
 * Every case below is taken from tests/guard.test.mjs, so what lands on screen
 * is the shipped policy engine's actual verdict rather than a staged one. The
 * order matters: it reads as one session drifting from safe local work toward
 * production, which is what the trajectory tracker exists to catch.
 */
const PORT = Number(process.env.DEMO_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;

const meta = await fetch(`${BASE}/__meta`).then((r) => r.json());
const ROOT = meta.cwd;

/* An envelope with a task on it: an accepted envelope with an empty task reads
   as unfinished in the Guard frame. */
await fetch(`${BASE}/__authority`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    action: "accept",
    task: "Fix the webhook consumer dropping events under load",
  }),
}).then((r) => r.json());

/** One tool call through the policy engine. */
async function evaluate(tool, input, note) {
  const r = await fetch(`${BASE}/__guard/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolName: tool, input }),
  }).then((x) => x.json());
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad(r.decision, 6)} ${pad(tool, 6)} ${pad(r.rule || "—", 34)} ${note}`);
  /* Decisions are stamped server-side at evaluate time. Firing the whole set in
     a tight loop gives every row in the Guard view the same second, which is the
     most obvious tell that a capture was staged. Spread them out. */
  await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 2400)));
  return r;
}

const P = (rel) => `${ROOT}/${rel}`;

console.log("\n  DECISION  TOOL   RULE                               COMMAND\n");

/* ── ordinary in-scope work ──────────────────────────────────────────────── */
await evaluate("Read", { file_path: P("src/queue/consumer.ts") }, "read a project file");
await evaluate("Grep", { pattern: "ack\\(", path: P("src/queue") }, "search the queue package");
await evaluate("Bash", { command: "npm test -- queue" }, "npm test -- queue");
await evaluate("Edit", { file_path: P("src/queue/consumer.ts"), old_string: "await ack(msg)", new_string: "await persist(msg); await ack(msg)" }, "fix the ack ordering");
await evaluate("Bash", { command: "npm run build" }, "npm run build");
await evaluate("Bash", { command: "git status --short" }, "git status --short");

/* ── recoverable, but consequential enough to ask ───────────────────────── */
await evaluate("Bash", { command: "rm -rf ./build" }, "rm -rf ./build");
await evaluate("Bash", { command: "find . -name '*.log' -delete" }, "find . -name '*.log' -delete");
await evaluate("Bash", { command: "python3 scripts/migrate.py" }, "unknown interpreter");
await evaluate("Bash", { command: "npx prisma migrate deploy" }, "npx prisma migrate deploy");
await evaluate("Bash", { command: "git push origin fix/webhook-drop" }, "push a feature branch");
await evaluate("Bash", { command: "git push --force origin main" }, "force-push main");

/* ── outside the envelope entirely ──────────────────────────────────────── */
await evaluate("Write", { file_path: "/Users/dev/.ssh/config", content: "Host *" }, "write outside the project");
await evaluate("Bash", { command: "rm -rf /etc/nginx" }, "delete outside the project");
await evaluate("Bash", { command: "aws s3 rm s3://acme-prod-assets --recursive" }, "wipe a production bucket");
await evaluate("Bash", { command: "railway volume delete vol_9f2 --environment production" }, "delete a production volume");
await evaluate("Bash", { command: "kubectl --context prod-cluster delete deploy checkout" }, "delete a production deployment");

const last = await evaluate("Bash", { command: "deploy --env production" }, "deploy to production");

console.log(`\n  trajectory signals: ${(last.signals || []).length}`);
for (const s of last.signals || []) console.log(`    ${s.type} — ${s.detail}`);

const dec = await fetch(`${BASE}/__decisions`).then((r) => r.json());
const tally = { ALLOW: 0, ASK: 0, DENY: 0 };
for (const d of dec.decisions || []) tally[d.decision] = (tally[d.decision] || 0) + 1;
console.log(`\n  recorded: ${tally.ALLOW} allow · ${tally.ASK} ask · ${tally.DENY} deny\n`);
