import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAdapter, ADAPTER_METHODS } from "../src/adapters/contract.mjs";
import { resolveAdapter, createClaudeAdapter } from "../src/adapters/index.mjs";
import { installClaudeProject } from "../src/adapters/claude/install.mjs";
import { resolveEnvelopePath, handlePreToolUse } from "../src/adapters/claude/hooks.mjs";
import { resolveRuntimePaths } from "../src/runtime/paths.mjs";
import { acceptEnvelope, loadEnvelope, saveEnvelope } from "../src/guard/authority.mjs";
import { authorityPath, legacyAuthorityPath, migrateLegacyAuthority, projectIdFromPath } from "../src/config/projects.mjs";

let n = 0,
  fail = 0;
function assert(cond, msg) {
  n++;
  if (!cond) {
    fail++;
    console.error("  FAIL", msg);
  }
}

assert(ADAPTER_METHODS.includes("disableTool"), "contract lists disableTool");

const root = mkdtempSync(join(tmpdir(), "iris-ad-"));
mkdirSync(join(root, ".claude"), { recursive: true });
const settingsPath = join(root, ".claude", "settings.json");
writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: [] } }, null, 2));

const adapter = createClaudeAdapter({ settingsPath, port: 1 });
assert(adapter.id === "claude-code", "id");
assert(adapter.capabilities.bareDenyRemovesContext === true, "bare deny capability");
assert(adapter.capabilities.cursorParity === false, "no cursor parity promise");

const off = adapter.disableTool("Agent");
assert(off.ok && off.deny.includes("Agent"), "disableTool bare deny");
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
assert(settings.permissions.deny.includes("Agent"), "written to settings");

const on = adapter.enableTool("Agent");
assert(on.ok && !on.deny.includes("Agent"), "enableTool");

const rule = adapter.host.classifyRule("Bash");
assert(rule.removesFromContext === true, "bare removes context");
assert(adapter.host.classifyRule({ tool: "Bash", path: "/tmp" }).removesFromContext === false, "scoped keeps context");

adapter.observeModelRequest({ tools: [{ name: "Read", tokens: 10 }] });
assert(adapter.listTools().some((t) => t.name === "Read"), "listTools from observe");

const meta = adapter.getSessionMetadata();
assert(meta.host === "claude-code", "session host");

let threw = false;
try {
  resolveAdapter("cursor");
} catch {
  threw = true;
}
assert(threw, "unknown adapter throws");

process.env.IRIS_HOME = join(root, ".iris-home");
delete process.env.IRIS_ENVELOPE_PATH;
const installed = installClaudeProject({ cwd: root, proxyUrl: "http://127.0.0.1:8787" });
assert(installed.ok && installed.host === "claude-code", "install");
const wired = JSON.parse(readFileSync(settingsPath, "utf8"));
assert(wired.env.ANTHROPIC_BASE_URL.includes("8787"), "proxy url");
assert(wired.env.IRIS_ENVELOPE_PATH === installed.envelopePath, "IRIS_ENVELOPE_PATH written");
assert(wired.env.IRIS_HOME, "IRIS_HOME written");
assert(Array.isArray(wired.hooks?.PreToolUse) && wired.hooks.PreToolUse.length, "PreToolUse installed");
const hookCmd = JSON.stringify(wired.hooks.PreToolUse);
assert(hookCmd.includes("bin/iris.mjs") && hookCmd.includes("hook"), "hook via CLI");
assert(!hookCmd.includes("adapters/claude/hooks.mjs"), "not a deep hooks.mjs path");

const hookEnvPath = resolveEnvelopePath({ cwd: root });
const serverEnvPath = resolveRuntimePaths({ projectRoot: root }).envelopePath;
assert(hookEnvPath === serverEnvPath, "hook and server share envelope path");
assert(hookEnvPath === installed.envelopePath, "init envelope is that path");
assert(existsSync(hookEnvPath), "envelope file exists at shared path");

const again = installClaudeProject({ cwd: root, proxyUrl: "http://127.0.0.1:8787" });
assert(again.ok, "init is idempotent");
const rewired = JSON.parse(readFileSync(settingsPath, "utf8"));
assert(rewired.hooks.PreToolUse.length === 1, "one PreToolUse after re-init");

let env = loadEnvelope(serverEnvPath);
env.scope.filesystem = ["$PROJECT/src/**"];
env = acceptEnvelope(env);
saveEnvelope(serverEnvPath, env);
const blocked = handlePreToolUse(
  {
    tool_name: "Write",
    tool_input: { file_path: join(root, "README.md"), content: "x" },
    cwd: root,
  },
  { envelopePath: serverEnvPath, projectRoot: root }
);
assert(["deny", "ask"].includes(blocked.permissionDecision), "tightened scope blocks README: " + blocked.permissionDecision);
assert(blocked.envelope?.task !== "(no envelope)", "hook loaded accepted envelope");

const migRoot = mkdtempSync(join(tmpdir(), "iris-mig-"));
process.env.IRIS_HOME = join(migRoot, ".iris-home");
delete process.env.IRIS_ENVELOPE_PATH;
const migId = projectIdFromPath(migRoot);
mkdirSync(join(process.env.IRIS_HOME, "projects", migId), { recursive: true });
writeFileSync(legacyAuthorityPath(migId), readFileSync(serverEnvPath, "utf8"));
const migrated = migrateLegacyAuthority(migId);
assert(migrated.migrated === true, "legacy envelope copied");
assert(existsSync(authorityPath(migId)), "canonical path after migrate");

const norm = normalizeAdapter({
  id: "t",
  disableTool: () => ({}),
  enableTool: () => ({}),
  beforeToolExecution: () => ({}),
  afterToolExecution: () => ({}),
  getSessionMetadata: () => ({}),
});
assert(typeof norm.observeModelRequest === "function", "normalize fills no-ops");

console.log(`adapter: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
