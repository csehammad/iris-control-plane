import { startServer } from "../src/runtime/server.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
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

const root = mkdtempSync(join(tmpdir(), "iris-srv-"));
mkdirSync(join(root, ".claude"), { recursive: true });
writeFileSync(
  join(root, ".claude", "settings.json"),
  JSON.stringify({ permissions: { deny: ["Agent"] }, env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:0" } }, null, 2)
);

process.env.IRIS_HOME = join(root, ".iris-home");
process.env.PROXY_SETTINGS_PATH = join(root, ".claude", "settings.json");
process.env.PROXY_LOG_DIR = join(root, ".claude", "proxy-logs");
process.env.PROXY_HISTORY_PATH = join(root, ".claude", "history-index.json");
process.env.PROXY_ACTIONS_PATH = join(root, ".claude", "action-log.json");

const port = 18787 + Math.floor(Math.random() * 1000);
const { server } = startServer({ port, projectRoot: root, handleSignals: false });

await new Promise((r) => setTimeout(r, 200));

const meta = await fetch(`http://127.0.0.1:${port}/__meta`).then((r) => r.json());
assert(meta.port === port, "meta.port");
assert(typeof meta.version === "string" && meta.version.length > 0, "meta.version");
assert(meta.authRequired === false, "auth optional by default");

const health = await fetch(`http://127.0.0.1:${port}/__health`).then((r) => r.json());
assert(health.ok === true, "health");
assert(health.bind === "127.0.0.1", "health.bind");

const cfg = await fetch(`http://127.0.0.1:${port}/__config`).then((r) => r.json());
assert(cfg.deny.includes("Agent"), "deny list");

const auth = await fetch(`http://127.0.0.1:${port}/__authority`).then((r) => r.json());
assert(auth.path, "authority path");

const ui = await fetch(`http://127.0.0.1:${port}/__monitor`);
assert(ui.ok, "ui");
const html = await ui.text();
assert(html.includes("Iris"), "ui has Iris");
assert(html.includes("Optimize") || html.includes("Flight Recorder"), "nav renamed");
assert(!html.includes("fonts.googleapis.com"), "no Google Fonts CDN");

const guide = await fetch(`http://127.0.0.1:${port}/__guide`);
assert(guide.ok, "guide");
const guideHtml = await guide.text();
assert(guideHtml.includes("npx @zero-drift/iris"), "guide is npm-first");
assert(guideHtml.includes("/__guide"), "guide self-url");

const evalRes = await fetch(`http://127.0.0.1:${port}/__guard/evaluate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    toolName: "Bash",
    input: { command: "echo hi" },
  }),
}).then((r) => r.json());
assert(evalRes.decision, "guard evaluate");

const badJson = await fetch(`http://127.0.0.1:${port}/__guard/evaluate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{not-json",
});
assert(badJson.status === 400, "invalid json is 400");


// ── /__reset clears the capture and nothing else ────────────────────
{
  const logDir = join(root, ".claude", "proxy-logs");
  mkdirSync(logDir, { recursive: true });
  const uid = "2026-08-25T00-00-00-000Z_0001_POST";
  for (const ext of ["meta.json", "req.json", "res.txt"]) {
    writeFileSync(join(logDir, `${uid}.${ext}`), "{}");
  }
  // Anything that is not a capture file must be left alone: PROXY_LOG_DIR can
  // point at a directory the user also keeps other things in.
  writeFileSync(join(logDir, "notes.txt"), "keep me");

  const post = (body) =>
    fetch(`http://127.0.0.1:${port}/__reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  const refused = await post({});
  assert(!!refused.error, "reset refuses without an explicit confirm");
  assert(existsSync(join(logDir, `${uid}.meta.json`)), "refused reset deletes nothing");

  const done = await post({ confirm: "clear" });
  assert(done.ok === true, "reset succeeds when confirmed");
  assert(done.files === 3, `reset removes the 3 capture files (got ${done.files})`);
  assert(!existsSync(join(logDir, `${uid}.meta.json`)), "capture file gone");
  assert(existsSync(join(logDir, "notes.txt")), "unrelated file survives");

  const after = await fetch(`http://127.0.0.1:${port}/__history`).then((r) => r.json());
  assert((after.records || []).length === 0, "history ledger emptied");
}

server.close();

const authPort = port + 1;
const { server: locked } = startServer({
  port: authPort,
  projectRoot: root,
  handleSignals: false,
  uiToken: "secret",
});
await new Promise((r) => setTimeout(r, 200));

const lockedHealth = await fetch(`http://127.0.0.1:${authPort}/__health`).then((r) => r.json());
assert(lockedHealth.ok === true, "health without token");
assert(lockedHealth.authRequired === true, "authRequired");

const denied = await fetch(`http://127.0.0.1:${authPort}/__guard/evaluate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ toolName: "Bash", input: { command: "echo hi" } }),
});
assert(denied.status === 401, "evaluate without token is 401");

const queryLeak = await fetch(`http://127.0.0.1:${authPort}/__guard/evaluate?token=secret`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ toolName: "Bash", input: { command: "echo hi" } }),
});
assert(queryLeak.status === 401, "query token is not accepted");

const allowed = await fetch(`http://127.0.0.1:${authPort}/__guard/evaluate`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-iris-token": "secret" },
  body: JSON.stringify({ toolName: "Bash", input: { command: "echo hi" } }),
});
assert(allowed.status === 200, "evaluate with header is 200");

locked.close();
console.log(`server: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
