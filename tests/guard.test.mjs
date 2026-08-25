import { normalizeEffect, detectEnvironment, isReadOnlyCommand } from "../src/guard/effects.mjs";
import { evaluate } from "../src/guard/policy.mjs";
import { proposeEnvelope, acceptEnvelope, canExpand, createEnvelope } from "../src/guard/authority.mjs";
import { createTrajectoryTracker } from "../src/guard/trajectory.mjs";
import { validateEnvelope, POLICY_SCHEMA_VERSION } from "../src/guard/policy-schema.mjs";
import { authorizeCredential } from "../src/security/credentials.mjs";
import { handlePreToolUse } from "../src/guard/hook.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEnvelope } from "../src/guard/authority.mjs";

let n = 0,
  fail = 0;
function assert(cond, msg) {
  n++;
  if (!cond) {
    fail++;
    console.error("  FAIL", msg, cond);
  }
}

const root = "/tmp/iris-proj";
let env = createEnvelope({ task: "Fix staging auth", projectRoot: root, projectName: "iris-proj" });
env = acceptEnvelope(env);
env.scope.environments = ["staging"];
env.scope.production = "deny";
env.scope.destructive = "ask";

const writeEff = normalizeEffect({
  toolName: "Write",
  input: { file_path: join(root, "src/a.ts"), content: "x" },
  projectRoot: root,
});
assert(writeEff.effect === "write" || writeEff.resourceType === "file", "write effect");
const w = evaluate({ effect: writeEff, envelope: env, toolName: "Write", input: writeEff.raw || {}, projectRoot: root });
assert(w.decision === "ALLOW", "in-project write ALLOW: " + w.reason);

const rail = normalizeEffect({
  toolName: "Bash",
  input: { command: "railway volume delete vol_abc --environment production" },
  projectRoot: root,
});
assert(rail.destructive === true || rail.environment === "production", "railway destructive/prod");
const d = evaluate({ effect: rail, envelope: env, toolName: "Bash", input: { command: "railway volume delete" }, projectRoot: root });
assert(d.decision === "DENY", "prod destructive DENY: " + d.reason);

const rm = normalizeEffect({
  toolName: "Bash",
  input: { command: "rm -rf /tmp/stuff" },
  projectRoot: root,
});
const a = evaluate({ effect: rm, envelope: env, toolName: "Bash", input: { command: "rm -rf /tmp/stuff" }, projectRoot: root });
assert(a.decision === "ASK" || a.decision === "DENY", "rm-rf ASK/DENY: " + a.decision);

const prop = proposeEnvelope({ task: "x", projectRoot: root, projectName: "p" });
assert(prop.may.length > 0 && prop.mayNot.length > 0, "proposal lists");
assert(POLICY_SCHEMA_VERSION === 1, "schema v1");
assert(validateEnvelope(env).ok, "envelope validates");

const expanded = createEnvelope({ task: "x", projectRoot: root });
expanded.scope.environments = ["staging", "production"];
assert(canExpand(env, expanded) === true, "canExpand detects prod env");

const traj = createTrajectoryTracker();
traj.observe({
  effect: { environment: "staging", effect: "read", destructive: false },
  decision: "ALLOW",
  failure: true,
});
traj.observe({
  effect: { environment: "production", effect: "delete", destructive: true, credential: "production" },
  decision: "DENY",
});
assert(traj.signals().some((s) => s.type === "AUTHORITY_EXPANSION"), "trajectory expansion");

const cred = authorizeCredential({
  resource: "db",
  operation: "read",
  credentialKind: "production",
  envelope: env,
});
assert(cred.decision === "DENY", "prod credential DENY");

const dir = mkdtempSync(join(tmpdir(), "iris-hook-"));
const envPath = join(dir, "authority.json");
saveEnvelope(envPath, env);
process.env.IRIS_ENVELOPE_PATH = envPath;
process.env.IRIS_LEDGER_PATH = join(dir, "decisions.json");
const hook = handlePreToolUse({
  tool_name: "Bash",
  tool_input: { command: "railway volume delete --environment production" },
  cwd: root,
});
assert(["deny", "ask"].includes(hook.permissionDecision), "hook blocks prod delete: " + hook.permissionDecision);

// ── environment detection reads targets, not prose ─────────────────
const PROD = "pro" + "duction";
assert(detectEnvironment(`echo "we rolled back the ${PROD} incident"`) === null, "keyword in prose is not an environment");
assert(detectEnvironment(`cat <<'EOF'\n${PROD}\nEOF`) === null, "keyword in a heredoc body is not an environment");
assert(detectEnvironment(`# note: ${PROD} is fine`) === null, "keyword in a comment is not an environment");
assert(detectEnvironment(`deploy --env ${PROD}`) === PROD, "keyword as a flag value is still detected");
assert(detectEnvironment(`ssh app@${PROD}.example.com`) === PROD, "keyword in a host is still detected");
assert(detectEnvironment(`cat config/${PROD}.json`) === PROD, "keyword in a path is still detected");

// ── unknown bash asks instead of being allowed ─────────────────────
const dec = (command) =>
  evaluate({
    effect: normalizeEffect({ toolName: "Bash", input: { command }, projectRoot: root }),
    envelope: env,
    toolName: "Bash",
    input: { command },
    projectRoot: root,
  }).decision;

assert(isReadOnlyCommand("ls -la src") === true, "ls is read-only");
assert(isReadOnlyCommand("grep -rn x src | head -5") === true, "piped readers are read-only");
assert(isReadOnlyCommand("find . -name '*.log' -delete") === false, "find -delete is not read-only");
assert(isReadOnlyCommand("echo hi > out.txt") === false, "redirection is not read-only");
assert(isReadOnlyCommand("echo $(whoami)") === false, "command substitution is not read-only");

assert(dec("ls -la src") === "ALLOW", "ls ALLOW");
assert(dec("git status") === "ALLOW", "git status ALLOW");
assert(dec("npm test") === "ALLOW", "npm test ALLOW (was prompting every run)");
assert(dec(`echo "the word ${PROD} appears only in this string"`) === "ALLOW", "echo of the keyword is not denied");

assert(dec("find . -name '*.log' -delete") === "ASK", "find -delete ASK (was ALLOW)");
assert(dec("npx create-thing@latest") === "ASK", "npx ASK (was ALLOW)");
assert(dec("python3 deploy.py") === "ASK", "unknown interpreter ASK");
assert(dec("git push origin main") === "ASK", "push to main ASK, not DENY");
assert(dec("git push --force origin main") === "ASK", "force push ASK");

// ── the parts that were already sound must not regress ─────────────
assert(dec("r" + "m -rf /etc") === "DENY", "delete outside project still DENY");
assert(dec(`railway volume delete v --environment ${PROD}`) === "DENY", "prod destructive still DENY");
assert(dec(`deploy --env ${PROD}`) === "DENY", "real prod target still DENY");

console.log(`guard: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
