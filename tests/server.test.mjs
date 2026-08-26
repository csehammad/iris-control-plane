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

/* ── Hook paths ────────────────────────────────────────────────────────────
   A hook command is an absolute path into wherever this copy of Iris lives.
   npx caches are pruned, global installs move with the Node version. Re-running
   init has to re-point them, or the hook fails on every tool call with no way
   to repair it short of hand-editing JSON. */

const hookRoot = mkdtempSync(join(tmpdir(), "iris-hook-"));
mkdirSync(join(hookRoot, ".claude"), { recursive: true });
const hookSettings = join(hookRoot, ".claude", "settings.json");
const STALE = 'node "/nonexistent/_npx/OLDHASH/node_modules/@zero-drift/iris/bin/iris.mjs" hook';

const fresh = installClaudeProject({ cwd: hookRoot });
assert(fresh.hookAction === "installed", "first init installs the hook");
assert(installClaudeProject({ cwd: hookRoot }).hookAction === "unchanged", "re-running init is a no-op");

// The path moved: init must re-point it, not treat "some Iris hook exists" as done.
const relocated = JSON.parse(readFileSync(hookSettings, "utf8"));
relocated.hooks.PreToolUse[0].hooks[0].command = STALE;
relocated.hooks.PostToolUse[0].hooks[0].command = STALE;
writeFileSync(hookSettings, JSON.stringify(relocated, null, 2));

const repaired = installClaudeProject({ cwd: hookRoot });
assert(repaired.hookAction === "refreshed", "init reports a re-pointed hook");
const afterRepair = JSON.parse(readFileSync(hookSettings, "utf8"));
assert(
  afterRepair.hooks.PreToolUse[0].hooks[0].command === repaired.hookCommand,
  "stale PreToolUse path is re-pointed at this copy of Iris"
);
assert(
  afterRepair.hooks.PostToolUse[0].hooks[0].command === repaired.hookCommand,
  "stale PostToolUse path is re-pointed too"
);

// Someone else's hook in the same entry must survive, and Iris must not double up.
const shared = JSON.parse(readFileSync(hookSettings, "utf8"));
shared.hooks.PreToolUse[0].hooks.push({ type: "command", command: "./scripts/mine.sh" });
shared.hooks.PreToolUse[0].hooks.unshift({ type: "command", command: STALE });
writeFileSync(hookSettings, JSON.stringify(shared, null, 2));

installClaudeProject({ cwd: hookRoot });
const merged = JSON.parse(readFileSync(hookSettings, "utf8")).hooks.PreToolUse.flatMap((e) => e.hooks);
assert(
  merged.filter((h) => h.command.includes("iris.mjs")).length === 1,
  "a duplicate Iris hook is dropped, not rewritten twice"
);
assert(
  merged.some((h) => h.command === "./scripts/mine.sh"),
  "a non-Iris hook sharing the entry survives"
);

/* ── Action dedupe ─────────────────────────────────────────────────────────
   The same action arrives over SSE and again from /__actions. The dashboard
   must key both the same way or every row renders twice. */
const dash = readFileSync(new URL("../ui/iris.html", import.meta.url), "utf8");
assert(!dash.includes("a.k||actKey(a)"), "dashboard does not trust the server's action key");
assert(dash.includes("const k=actKey(a);"), "dashboard derives one action key for both sources");

/* ── Billing mode, end to end ──────────────────────────────────────────────
   The classifier is unit-tested in plan.test.mjs. What this checks is the wiring:
   a real request through the real proxy must move the classification onto /__meta,
   because that is the only path the dashboard reads it from. The upstream is
   unreachable here — a 502 is fine, since detection happens before forwarding. */
const planPort = wirePort + 4;
const { server: planSrv } = startServer({ port: planPort, projectRoot: wireRoot, handleSignals: false });
await new Promise((r) => setTimeout(r, 200));

assert((await fetch(`http://127.0.0.1:${planPort}/__meta`).then((r) => r.json())).plan.mode === null,
  "no billing mode claimed before any proxied traffic");

const SEAT_TOKEN = "sk-ant-oat01-E2E-SECRET-VALUE";
await fetch(`http://127.0.0.1:${planPort}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${SEAT_TOKEN}` },
  body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
}).catch(() => {});

const metaPlan = (await fetch(`http://127.0.0.1:${planPort}/__meta`).then((r) => r.json())).plan;
assert(metaPlan.mode === "subscription", "a bearer token on the wire reaches /__meta as a seat");
assert(metaPlan.observed === 1, "/__meta counts the classified request");
assert(metaPlan.confident === false, "a seat is reported without confidence");
assert(!JSON.stringify(metaPlan).includes(SEAT_TOKEN), "/__meta never carries the credential");
assert(!JSON.stringify(metaPlan).includes("E2E-SECRET"), "/__meta never carries a fragment of it");

/* The module the dashboard labels its figures from is the one this process
   classifies with — same rule as the price book, so the two cannot drift. */
const planSrc = await fetch(`http://127.0.0.1:${planPort}/__plan.mjs`);
assert(planSrc.status === 200, "/__plan.mjs is served");
assert((planSrc.headers.get("content-type") || "").includes("javascript"), "/__plan.mjs is served as a module");
assert((await planSrc.text()).includes("export const PLAN_MODES"), "/__plan.mjs is the real module");
planSrv.close();

/* ── Wiring status ─────────────────────────────────────────────────────────
   An empty capture has two causes that look identical on screen: an idle agent,
   and an agent pointed somewhere else. The server can tell them apart, so it must
   report which — checked live on each /__meta, because autoWireSettings() runs once
   at startup and does not run at all under IRIS_AUTOWIRE=0. */
const wireRoot2 = mkdtempSync(join(tmpdir(), "iris-wire2-"));
mkdirSync(join(wireRoot2, ".claude"), { recursive: true });
const wireSettings2 = join(wireRoot2, ".claude", "settings.json");
const wirePort2 = wirePort + 5;
const writeBase = (v) =>
  writeFileSync(wireSettings2, JSON.stringify(v === undefined ? { env: {} } : { env: { ANTHROPIC_BASE_URL: v } }, null, 2));

// This file sets PROXY_SETTINGS_PATH globally; point it at this project.
const prevSettingsEnv2 = process.env.PROXY_SETTINGS_PATH;
process.env.PROXY_SETTINGS_PATH = wireSettings2;
process.env.IRIS_AUTOWIRE = "0";
writeBase(`http://127.0.0.1:${wirePort2}`);
/* Iris moves to the next free port when the requested one is taken, so the bound
   port — not the requested one — is what settings.json has to match. */
const { server: wireSrv2, boundPort: wireBound2 } = startServer({
  port: wirePort2, projectRoot: wireRoot2, handleSignals: false,
});
await new Promise((r) => setTimeout(r, 200));
const wiring = () => fetch(`http://127.0.0.1:${wireBound2}/__meta`).then((r) => r.json()).then((d) => d.wiring);
writeBase(`http://127.0.0.1:${wireBound2}`);

let w = await wiring();
assert(w.state === "ok", "wiring: a matching port reports ok");
assert(w.boundPort === wireBound2, "wiring: reports the port Iris bound");
assert(w.autowire === false, "wiring: reports that autowire is off");

/* The state this whole check exists for. */
writeBase("http://127.0.0.1:9999");
w = await wiring();
assert(w.state === "elsewhere", "wiring: a different loopback port is reported, not silently ignored");
assert(w.agentPort === 9999, "wiring: names the port the agent is actually using");
assert(w.url === "http://127.0.0.1:9999", "wiring: quotes the configured URL back");

/* Re-read on every request, so fixing the file is reflected without a restart. */
writeBase(`http://127.0.0.1:${wireBound2}`);
assert((await wiring()).state === "ok", "wiring: recovers as soon as the file is corrected");

writeBase(undefined);
assert((await wiring()).state === "unset", "wiring: no base URL at all is its own state");

writeBase("https://gateway.example.com");
w = await wiring();
assert(w.state === "external", "wiring: a non-loopback URL is reported as external");
assert(w.agentPort === 443, "wiring: an https URL with no port implies 443");

writeBase("not a url");
assert((await wiring()).state === "unparseable", "wiring: an unparseable value is reported, not repaired");

writeFileSync(wireSettings2, "{ broken json");
assert((await wiring()).state === "no-settings", "wiring: an unreadable settings file is reported, not fatal");

/* Read-only: reporting a mismatch must never rewrite the user's file. */
writeBase("http://127.0.0.1:9999");
const before = readFileSync(wireSettings2, "utf8");
await wiring();
assert(readFileSync(wireSettings2, "utf8") === before, "wiring: the check never edits settings.json");
wireSrv2.close();
delete process.env.IRIS_AUTOWIRE;
process.env.PROXY_SETTINGS_PATH = prevSettingsEnv2;

console.log(`server: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
