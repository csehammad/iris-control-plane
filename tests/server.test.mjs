import { startServer } from "../src/runtime/server.mjs";
import { installClaudeProject } from "../src/adapters/claude/install.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

/* ── Port conflicts ────────────────────────────────────────────────────────
   Two projects, one port. The failure that matters is not the crash — it is
   a second project silently routing its traffic into the first project's
   instance, which would record it under the wrong project and evaluate Guard
   against the wrong envelope and project root. */

const conflictPort = port + 2;
const rootA = mkdtempSync(join(tmpdir(), "iris-a-"));
const rootB = mkdtempSync(join(tmpdir(), "iris-b-"));
mkdirSync(join(rootA, ".claude"), { recursive: true });
mkdirSync(join(rootB, ".claude"), { recursive: true });

const { server: first } = startServer({ port: conflictPort, projectRoot: rootA, handleSignals: false });
await new Promise((r) => setTimeout(r, 250));

const firstMeta = await fetch(`http://127.0.0.1:${conflictPort}/__meta`).then((r) => r.json());
assert(firstMeta.port === conflictPort, "first instance holds the port");

// An explicit port must never be silently moved — it would desync settings.json.
const { server: second, boundPort: secondRequested } = startServer({
  port: conflictPort,
  projectRoot: rootB,
  handleSignals: false,
});
await new Promise((r) => setTimeout(r, 900));
assert(secondRequested === conflictPort, "explicit port is not reassigned");
assert(second.listening === false, "second instance does not bind an occupied explicit port");

const stillA = await fetch(`http://127.0.0.1:${conflictPort}/__meta`).then((r) => r.json());
assert(stillA.projectId === firstMeta.projectId, "occupied port still serves the original project");

second.close();
first.close();

/* init must write the port it was given, and re-point a stale loopback URL
   rather than leaving traffic aimed at another project's instance. */
const wired = join(rootB, ".claude", "settings.json");
writeFileSync(wired, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } }));
const moved = installClaudeProject({ cwd: rootB, port: 8801 });
assert(moved.proxyUrl === "http://127.0.0.1:8801", "init writes the requested port");
assert(moved.baseUrlAction === "repointed", "stale loopback URL is re-pointed");
assert(
  JSON.parse(readFileSync(wired, "utf8")).env.ANTHROPIC_BASE_URL === "http://127.0.0.1:8801",
  "settings.json now points at this project's instance"
);

// A deliberate non-loopback upstream is the user's choice, not Iris's to rewrite.
writeFileSync(wired, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } }));
const external = installClaudeProject({ cwd: rootB, port: 8801 });
assert(external.baseUrlAction === "external", "custom upstream is reported, not rewritten");
assert(
  JSON.parse(readFileSync(wired, "utf8")).env.ANTHROPIC_BASE_URL === "https://gateway.example.com",
  "custom upstream left untouched"
);

/* ── Auto-wire ─────────────────────────────────────────────────────────────
   Starting Iris on a different port must re-point THIS project's settings,
   or its traffic keeps flowing to whichever instance holds the old port. */

const wireRoot = mkdtempSync(join(tmpdir(), "iris-wire-"));
mkdirSync(join(wireRoot, ".claude"), { recursive: true });
const wirePath = join(wireRoot, ".claude", "settings.json");
// This file sets PROXY_SETTINGS_PATH globally; point it at the wire project.
const previousSettingsEnv = process.env.PROXY_SETTINGS_PATH;
process.env.PROXY_SETTINGS_PATH = wirePath;
const initialised = {
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" },
  hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: 'node "/x/bin/iris.mjs" hook' }] }] },
  permissions: { deny: ["NotebookEdit"] },
};

const wirePort = port + 4;
writeFileSync(wirePath, JSON.stringify(initialised, null, 2));
const { server: wireSrv } = startServer({ port: wirePort, projectRoot: wireRoot, handleSignals: false });
await new Promise((r) => setTimeout(r, 400));
const afterWire = JSON.parse(readFileSync(wirePath, "utf8"));
assert(
  afterWire.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${wirePort}`,
  "startup re-points a stale loopback URL to the bound port"
);
assert(afterWire.hooks?.PreToolUse?.length === 1, "auto-wire preserves hooks");
assert(afterWire.permissions?.deny?.[0] === "NotebookEdit", "auto-wire preserves the deny list");
wireSrv.close();

// A deliberate upstream is never rewritten.
writeFileSync(wirePath, JSON.stringify({ ...initialised, env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } }, null, 2));
const { server: ext } = startServer({ port: wirePort + 1, projectRoot: wireRoot, handleSignals: false });
await new Promise((r) => setTimeout(r, 400));
assert(
  JSON.parse(readFileSync(wirePath, "utf8")).env.ANTHROPIC_BASE_URL === "https://gateway.example.com",
  "auto-wire leaves a non-loopback upstream alone"
);
ext.close();

// A project with no Iris hook has not opted in; warn, do not write.
writeFileSync(wirePath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999" } }, null, 2));
const { server: bare } = startServer({ port: wirePort + 2, projectRoot: wireRoot, handleSignals: false });
await new Promise((r) => setTimeout(r, 400));
assert(
  JSON.parse(readFileSync(wirePath, "utf8")).env.ANTHROPIC_BASE_URL === "http://127.0.0.1:9999",
  "auto-wire skips a project with no Iris hook installed"
);
bare.close();

// Opt-out.
process.env.IRIS_AUTOWIRE = "0";
writeFileSync(wirePath, JSON.stringify(initialised, null, 2));
const { server: optOut } = startServer({ port: wirePort + 3, projectRoot: wireRoot, handleSignals: false });
await new Promise((r) => setTimeout(r, 400));
assert(
  JSON.parse(readFileSync(wirePath, "utf8")).env.ANTHROPIC_BASE_URL === "http://127.0.0.1:8787",
  "IRIS_AUTOWIRE=0 leaves settings.json untouched"
);
optOut.close();
delete process.env.IRIS_AUTOWIRE;
process.env.PROXY_SETTINGS_PATH = previousSettingsEnv;

/* ── Action dedupe ─────────────────────────────────────────────────────────
   The same action arrives over SSE and again from /__actions. The dashboard
   must key both the same way or every row renders twice. */
const dash = readFileSync(new URL("../ui/iris.html", import.meta.url), "utf8");
assert(!dash.includes("a.k||actKey(a)"), "dashboard does not trust the server's action key");
assert(dash.includes("const k=actKey(a);"), "dashboard derives one action key for both sources");

console.log(`server: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
