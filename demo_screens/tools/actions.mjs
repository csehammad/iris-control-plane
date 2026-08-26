/**
 * Give Flight Recorder the same session Guard just judged.
 *
 * Actions are derived from the `tool_use` blocks in a request's message history,
 * with the displayed argument pulled from the field that tool actually uses —
 * `file_path` for Read, `pattern` for Grep, `command` for Bash. The first pass of
 * the harness put everything in `command`, so every non-Bash row rendered with a
 * blank argument.
 *
 * This sends one turn carrying the whole trace, so the recorder shows the same
 * arc the Guard view does: ordinary work, then commands that needed asking about,
 * then the ones that were refused.
 */
const PORT = Number(process.env.DEMO_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;

const meta = await fetch(`${BASE}/__meta`).then((r) => r.json());
/* Project-relative, because the recorder prints the argument verbatim and an
   absolute temp path would fill the column with /var/folders noise. */
const R = ".";

/* Mirrors guard.mjs, in the same order. */
const TRACE = [
  ["Read",  { file_path: `src/queue/consumer.ts` }],
  ["Read",  { file_path: `src/webhooks/handler.ts` }],
  ["Grep",  { pattern: "ack\\(", path: `src/queue`, output_mode: "content" }],
  ["Bash",  { command: "npm test -- queue", description: "Run the queue test suite" }],
  ["Read",  { file_path: `src/queue/retry.ts` }],
  ["Grep",  { pattern: "prefetch", glob: "**/*.ts" }],
  ["Edit",  { file_path: `src/queue/consumer.ts`, old_string: "await ack(msg)", new_string: "await persist(msg); await ack(msg)" }],
  ["Bash",  { command: "npm test -- queue --watch=false", description: "Re-run after the fix" }],
  ["Bash",  { command: "npm run build", description: "Type-check the change" }],
  ["Bash",  { command: "git diff --stat", description: "Review what changed" }],
  ["Bash",  { command: "git status --short" }],
  ["TodoWrite", { todos: [{ content: "Trace the ack path", status: "completed" }, { content: "Add a load test", status: "in_progress" }] }],
  ["Bash",  { command: "rm -rf ./build", description: "Clear the build directory" }],
  ["Bash",  { command: "find . -name '*.log' -delete" }],
  ["Bash",  { command: "python3 scripts/migrate.py" }],
  ["Bash",  { command: "npx prisma migrate deploy" }],
  ["Bash",  { command: "git push origin fix/webhook-drop" }],
  ["Bash",  { command: "git push --force origin main" }],
  ["Write", { file_path: "/Users/dev/.ssh/config", content: "Host *\n  ForwardAgent yes" }],
  ["Bash",  { command: "rm -rf /etc/nginx" }],
  ["Bash",  { command: "aws s3 rm s3://acme-prod-assets --recursive" }],
  ["Bash",  { command: "railway volume delete vol_9f2 --environment production" }],
  ["Bash",  { command: "kubectl --context prod-cluster delete deploy checkout" }],
  ["Bash",  { command: "deploy --env production" }],
];

const messages = [
  { role: "user", content: [{ type: "text", text: "The billing webhook is dropping events under load. Can you find out why?" }] },
];
TRACE.forEach(([name, input], i) => {
  messages.push({ role: "assistant", content: [{ type: "tool_use", id: `tu_${i}`, name, input }] });
  messages.push({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: i % 4 === 3 ? "ok" : "done" }],
  });
});

/* Actions inherit the timestamp of the request that carried them, so sending the
   whole trace in one call gives all 30 rows the same clock time. Send growing
   prefixes instead — the ledger dedupes by key, so re-sent rows are skipped and
   each batch stamps only what is new. */
async function sendPrefix(upTo) {
  const msgs = messages.slice(0, upTo * 2 + 1);
  await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-ant-oat01-DEMOSESSIONTOKENVALUE",
      "anthropic-beta": "oauth-2025-04-20",
    },
    body: JSON.stringify({
      model: "claude-opus-5", max_tokens: 8192, stream: true, messages: msgs,
      system: [{ type: "text", text: "You are an interactive coding agent running in the user's terminal." }],
    }),
  }).then((r) => r.text()).catch(() => {});
}
for (let n = 4; n < TRACE.length; n += 4) {
  await sendPrefix(n);
  await new Promise((r) => setTimeout(r, 7000));
}

const res = await fetch(`${BASE}/v1/messages`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer sk-ant-oat01-DEMOSESSIONTOKENVALUE",
    "anthropic-beta": "oauth-2025-04-20",
  },
  body: JSON.stringify({
    model: "claude-opus-5",
    max_tokens: 8192,
    stream: true,
    messages,
    system: [{ type: "text", text: "You are an interactive coding agent running in the user's terminal." }],
  }),
});
await res.text();

await new Promise((r) => setTimeout(r, 900));
const a = await fetch(`${BASE}/__actions`).then((r) => r.json());
console.log(`\n  actions recorded: ${a.total}\n`);
for (const x of (a.actions || []).slice(-24)) {
  console.log(`  ${String(x.i).padStart(2)} ${x.tool.padEnd(10)} ${(x.arg || x.desc || "").slice(0, 66)}`);
}
