/**
 * Effect Normalizer — evaluate effects, not command strings.
 * Deterministic recognizers for filesystem, Bash, network, cloud CLIs, MCP.
 */

import { isAbsolute, relative, resolve } from "node:path";

/**
 * @typedef {object} NormalizedEffect
 * @property {string|null} effect
 * @property {string|null} resourceType
 * @property {string|null} service
 * @property {string|null} environment
 * @property {string|null} scope
 * @property {boolean|null} external
 * @property {boolean|null} destructive
 * @property {boolean|null} reversible
 * @property {string|null} credential
 * @property {boolean} [unknown]
 * @property {Record<string, unknown>} raw
 */

function emptyEffect(raw = {}) {
  return {
    effect: null,
    resourceType: null,
    service: null,
    environment: null,
    scope: null,
    external: null,
    destructive: null,
    reversible: null,
    credential: null,
    unknown: false,
    raw,
  };
}

function lower(s) {
  return String(s ?? "").toLowerCase();
}

/**
 * Remove the parts of a command that are *data* rather than *targets*: heredoc
 * bodies, comments, and prose-like quoted strings.
 *
 * A deployment keyword inside a test fixture, a log line or an echo argument is
 * not a deployment target. Scanning the whole raw command string for one
 * produced denials for commands that never touched anything — the reproducible
 * example being `echo "the word production appears only in this string"`, which
 * was hard-denied.
 *
 * Quoted text is kept when it still looks like a target (a path, a host, or a
 * single bare token such as `--env "production"`) and dropped when it reads as
 * prose. This narrows a known false-positive class; it is a heuristic, not a
 * parser, and it does not make the classifier sound.
 *
 * @param {string} text
 */
export function stripNonTargetText(text) {
  let t = String(text ?? "");
  // Complete heredoc bodies: <<EOF ... EOF, <<-'EOF' ... EOF
  t = t.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, " ");
  // Heredoc opened but never closed within this string
  t = t.replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1[\s\S]*$/, " ");
  // Shell comments
  t = t.replace(/(^|\s)#[^\n]*/g, " ");
  // Prose inside quotes
  t = t.replace(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g, (m, _q, body) => {
    const looksLikeTarget = /[/@:]/.test(body) || !/\s/.test(body);
    return looksLikeTarget ? m : " ";
  });
  return t;
}

/**
 * Detect environment tokens in a command or path.
 * @param {string} text
 */
export function detectEnvironment(text) {
  const t = lower(stripNonTargetText(text));
  if (/\bprod(uction)?\b/.test(t) || /\bprd\b/.test(t) || /[._-]prod(?:uction)?(?:[._/-]|$)/.test(t)) {
    return "production";
  }
  if (/\bstag(e|ing)?\b/.test(t) || /[._-]stag(?:ing|e)?(?:[._/-]|$)/.test(t)) {
    return "staging";
  }
  if (/\bdev(elopment)?\b/.test(t) || /\blocal\b/.test(t)) {
    return "development";
  }
  return null;
}

/**
 * @param {string} filePath
 * @param {string} projectRoot
 */
export function classifyPathScope(filePath, projectRoot) {
  if (!filePath || typeof filePath !== "string") {
    return { scope: null, external: null, abs: null };
  }
  const root = projectRoot ? resolve(projectRoot) : null;
  let abs;
  try {
    abs = root && !isAbsolute(filePath) ? resolve(root, filePath) : resolve(filePath);
  } catch {
    return { scope: "unknown", external: true, abs: filePath };
  }

  if (!root) {
    return { scope: "unknown", external: null, abs };
  }

  const rel = relative(root, abs);
  const outside = rel.startsWith("..") || isAbsolute(rel);
  if (outside) {
    return { scope: "outside-project", external: true, abs };
  }
  return { scope: "project", external: false, abs };
}

function filesystemEffect(toolName, input, projectRoot) {
  const name = lower(toolName);
  const path =
    input?.file_path ||
    input?.path ||
    input?.filePath ||
    input?.target ||
    (Array.isArray(input?.paths) ? input.paths[0] : null) ||
    null;

  const { scope, external, abs } = classifyPathScope(String(path || ""), projectRoot);
  const env = detectEnvironment(String(path || ""));

  let effect = "read";
  let destructive = false;
  let reversible = true;

  if (name === "write" || name === "create" || name === "createtool") {
    effect = "write";
  } else if (name === "edit" || name === "multiedit" || name === "notebookedit") {
    effect = "edit";
  } else if (name === "read" || name === "notebookread") {
    effect = "read";
  } else if (name === "delete" || name === "remove") {
    effect = "delete";
    destructive = true;
    reversible = false;
  }

  // Credential-ish paths
  let credential = null;
  const p = lower(abs || path || "");
  if (
    /\/\.ssh\b/.test(p) ||
    /\/\.aws\b/.test(p) ||
    /\/\.config\/railway\b/.test(p) ||
    /credentials?\.(json|yml|yaml|env)\b/.test(p) ||
    /\.env(\.|$)/.test(p) ||
    /id_rsa|id_ed25519|\.pem$|\.key$/.test(p) ||
    /tokens?(?:\.[a-z]+)?$/.test(p)
  ) {
    credential = env === "production" ? "production" : env === "staging" ? "staging" : "secret";
  }

  return {
    ...emptyEffect({ toolName, input, path: abs || path }),
    effect,
    resourceType: "file",
    service: "filesystem",
    environment: env,
    scope,
    external: external === true,
    destructive,
    reversible,
    credential,
  };
}

/**
 * Parse host from URL-ish string.
 * @param {string} s
 */
export function extractHost(s) {
  const m = String(s || "").match(/https?:\/\/([^/\s"'`]+)/i);
  if (!m) return null;
  return m[1].replace(/:\d+$/, "").toLowerCase();
}

/**
 * Railway GraphQL / CLI destructive volume patterns from the vision.
 * @param {string} cmd
 */
function recognizeRailway(cmd) {
  const c = String(cmd);
  const cl = c.toLowerCase();

  const isRailwayCli = /\brailway\b/.test(cl);
  const isRailwayGraphql =
    /backboard\.railway\.app\/graphql/i.test(c) ||
    (/railway\.app/i.test(c) && /graphql/i.test(c));

  if (!isRailwayCli && !isRailwayGraphql) return null;

  const env = detectEnvironment(c) || (/\b--environment\s+prod/i.test(c) ? "production" : null);

  // volume delete via CLI or GraphQL mutation names
  const volumeDelete =
    /\bvolume\s+delete\b/i.test(c) ||
    /\bvolumeDelete\b/i.test(c) ||
    /\bvolume_delete\b/i.test(c) ||
    /mutation[^{]*\{[^}]*volumeDelete/i.test(c) ||
    /"query"\s*:\s*"[^"]*volumeDelete/i.test(c);

  if (volumeDelete) {
    return {
      effect: "delete",
      resourceType: "volume",
      service: "railway",
      environment: env || "production", // volume delete without env → treat as high-risk
      external: true,
      destructive: true,
      reversible: false,
      credential: env === "staging" ? "staging" : "production",
      unknown: false,
    };
  }

  if (/\b(delete|destroy|remove)\b/i.test(cl) && /\b(service|project|deployment|database|db|volume)\b/i.test(cl)) {
    return {
      effect: "delete",
      resourceType: /\bvolume\b/i.test(cl) ? "volume" : "resource",
      service: "railway",
      environment: env,
      external: true,
      destructive: true,
      reversible: false,
      credential: env === "production" ? "production" : env === "staging" ? "staging" : null,
      unknown: false,
    };
  }

  if (/\b(deploy|up)\b/i.test(cl)) {
    return {
      effect: "deploy",
      resourceType: "service",
      service: "railway",
      environment: env,
      external: true,
      destructive: env === "production" ? true : false,
      reversible: false,
      credential: env === "production" ? "production" : env === "staging" ? "staging" : null,
      unknown: false,
    };
  }

  // status / logs / variables get — usually non-destructive
  if (/\b(status|logs|whoami|list|variables?\s+get|open)\b/i.test(cl)) {
    return {
      effect: "read",
      resourceType: "service",
      service: "railway",
      environment: env,
      external: true,
      destructive: false,
      reversible: true,
      credential: env === "production" ? "production" : env === "staging" ? "staging" : null,
      unknown: false,
    };
  }

  return {
    effect: "invoke",
    resourceType: "service",
    service: "railway",
    environment: env,
    external: true,
    destructive: null,
    reversible: null,
    credential: env === "production" ? "production" : null,
    unknown: true,
  };
}

/**
 * @param {string} cmd
 */
function recognizeAws(cmd) {
  if (!/\baws\b/i.test(cmd)) return null;
  const cl = cmd.toLowerCase();
  const env = detectEnvironment(cmd);
  const destructive =
    /\b(delete-|terminate-|remove-|purge-|drop-)/i.test(cl) ||
    /\brm\b/.test(cl);
  return {
    effect: destructive ? "delete" : /\b(put|create|update|deploy)/i.test(cl) ? "write" : "invoke",
    resourceType: "cloud",
    service: "aws",
    environment: env,
    external: true,
    destructive: destructive || null,
    reversible: destructive ? false : null,
    credential: env === "production" ? "production" : env === "staging" ? "staging" : "aws",
    unknown: !destructive && !/\b(s3|ec2|lambda|sts|iam)\b/i.test(cl),
  };
}

/**
 * @param {string} cmd
 */
function recognizeGit(cmd) {
  if (!/\bgit\b/i.test(cmd)) return null;
  const cl = cmd.toLowerCase();
  if (/\bpush\b/.test(cl)) {
    const force = /\s--force\b|\s-f\b/.test(cl);
    const env = detectEnvironment(cmd);
    return {
      effect: "push",
      resourceType: "repository",
      service: "git",
      // A branch name is not an environment. Inferring one here meant every
      // `git push origin main` was hard-denied as a production deploy. A push
      // is still external and hard to reverse, so it is gated as an external
      // write further down rather than blocked outright.
      environment: env,
      external: true,
      destructive: force,
      reversible: !force,
      credential: null,
      unknown: false,
    };
  }
  if (/\b(reset\s+--hard|clean\s+-fdx|branch\s+-D|push\s+.*--delete)\b/i.test(cmd)) {
    return {
      effect: "delete",
      resourceType: "repository",
      service: "git",
      environment: detectEnvironment(cmd),
      external: false,
      destructive: true,
      reversible: false,
      credential: null,
      unknown: false,
    };
  }
  return {
    effect: "invoke",
    resourceType: "repository",
    service: "git",
    environment: detectEnvironment(cmd),
    external: false,
    destructive: false,
    reversible: true,
    credential: null,
    unknown: false,
  };
}

/**
 * @param {string} cmd
 */
function recognizePackagePublish(cmd) {
  if (!/\b(npm|pnpm|yarn|bun)\b/i.test(cmd)) return null;
  if (!/\bpublish\b/i.test(cmd)) {
    // Fetching and installing packages runs arbitrary lifecycle scripts, so it
    // stays external and lands on ASK.
    if (/\b(install|ci|add)\b/i.test(cmd)) {
      return {
        effect: "install",
        resourceType: "package",
        service: "npm",
        environment: null,
        external: true,
        destructive: false,
        reversible: true,
        credential: null,
        unknown: false,
      };
    }
    // Running an already-installed local script is an ordinary local command.
    // Classifying `npm test` as an install made it prompt on every run.
    if (/\b(test|run|build|start|lint|format|typecheck)\b/i.test(cmd)) {
      return {
        effect: "invoke",
        resourceType: "shell",
        service: "npm",
        environment: detectEnvironment(cmd),
        scope: "project",
        external: false,
        destructive: false,
        reversible: true,
        credential: null,
        unknown: false,
      };
    }
    return null;
  }
  return {
    effect: "publish",
    resourceType: "package",
    service: "npm",
    environment: "production",
    external: true,
    destructive: true,
    reversible: false,
    credential: "npm",
    unknown: false,
  };
}

/**
 * @param {string} cmd
 */
function recognizeDb(cmd) {
  if (!/\b(psql|mysql|mongosh|mongo|redis-cli|sqlite3)\b/i.test(cmd)) return null;
  const cl = cmd.toLowerCase();
  const env = detectEnvironment(cmd);
  const destructive =
    /\b(drop|truncate|delete\s+from|alter\s+table|destroy)\b/i.test(cl) ||
    /;\s*drop\b/i.test(cl);
  return {
    effect: destructive ? "delete" : "query",
    resourceType: "database",
    service: /\bpsql\b/.test(cl) ? "postgres" : /\bmysql\b/.test(cl) ? "mysql" : "database",
    environment: env,
    external: true,
    destructive: destructive || null,
    reversible: destructive ? false : null,
    credential: env === "production" ? "production" : env === "staging" ? "staging" : "database",
    unknown: !destructive,
  };
}

/**
 * @param {string} cmd
 */
function recognizeCurl(cmd) {
  if (!/\bcurl\b/i.test(cmd) && !/\bwget\b/i.test(cmd)) return null;

  // Prefer Railway GraphQL recognizer when applicable
  const railway = recognizeRailway(cmd);
  if (railway) return railway;

  const host = extractHost(cmd);
  const env = detectEnvironment(cmd) || (host && detectEnvironment(host));
  const method = (cmd.match(/-X\s*([A-Z]+)/i) || [])[1]?.toUpperCase() ||
    (/\b-d\b|--data\b|--json\b/i.test(cmd) ? "POST" : "GET");
  const destructiveMethod = ["DELETE", "PUT", "PATCH", "POST"].includes(method);
  const looksDelete =
    method === "DELETE" ||
    /\b(delete|destroy|drop|purge|remove)\b/i.test(cmd);

  return {
    effect: looksDelete ? "delete" : destructiveMethod ? "write" : "fetch",
    resourceType: "http",
    service: host || "http",
    environment: env,
    external: true,
    destructive: looksDelete ? true : destructiveMethod ? null : false,
    reversible: looksDelete ? false : null,
    credential: env === "production" ? "production" : null,
    unknown: !looksDelete && destructiveMethod,
  };
}

/**
 * @param {string} cmd
 */
function recognizeRm(cmd) {
  if (!/\brm\b/i.test(cmd)) return null;
  const recursiveForce = /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\b/i.test(cmd) || /\brm\s+-r\b/i.test(cmd);
  return {
    effect: "delete",
    resourceType: "file",
    service: "filesystem",
    environment: detectEnvironment(cmd),
    external: false,
    destructive: true,
    reversible: false,
    credential: null,
    unknown: !recursiveForce, // plain rm still destructive; flag unknown only when ambiguous? keep false
  };
}

/**
 * Executables that only inspect state. Everything else is treated as unknown
 * and routed to ASK.
 *
 * This is an allowlist on purpose. The previous denylist could only catch the
 * handful of shapes it had been taught, and silently allowed the rest.
 */
const READ_ONLY_COMMANDS = new Set([
  "ls", "pwd", "echo", "printf", "cat", "bat", "head", "tail", "wc", "file", "stat", "du", "df",
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "tree", "basename", "dirname", "realpath",
  "sort", "uniq", "cut", "tr", "column", "awk", "sed", "jq", "yq", "diff", "cmp",
  "md5", "md5sum", "shasum", "sha256sum", "cksum",
  "date", "whoami", "hostname", "uname", "which", "type", "env", "printenv",
  "true", "false", "test", "id", "groups", "uptime", "ps", "sleep", "seq",
]);

/**
 * Split a command line into the segments a shell would run separately.
 * @param {string} cmd
 */
function commandSegments(cmd) {
  return String(cmd)
    .split(/\|\||&&|[|;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * True only when every segment is a known read-only command with no flag that
 * turns it into a write. Anything uncertain returns false and becomes ASK.
 *
 * @param {string} cmd
 */
export function isReadOnlyCommand(cmd) {
  const c = String(cmd || "");
  if (!c.trim()) return false;

  // Any redirection writes to a path we cannot resolve here.
  if (/(^|[^0-9<>&])>>?(?![>&])/.test(c)) return false;
  // Command substitution can run anything.
  if (/\$\(|`/.test(c)) return false;

  const segs = commandSegments(c);
  if (!segs.length) return false;

  for (const seg of segs) {
    const m = seg.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\b/);
    if (!m) return false;
    const bin = m[1].toLowerCase();
    if (!READ_ONLY_COMMANDS.has(bin)) return false;

    // Flags that turn a reader into a writer or an arbitrary executor.
    if ((bin === "find" || bin === "fd") && /\s-(delete|exec|execdir|ok|okdir)\b/.test(seg)) return false;
    if (bin === "sed" && /\s-[a-zA-Z]*i\b/.test(seg)) return false;
  }
  return true;
}

/**
 * @param {string} cmd
 * @param {string} projectRoot
 */
function normalizeBash(cmd, projectRoot) {
  const raw = { toolName: "Bash", command: cmd };
  const c = String(cmd || "");

  const recognizers = [
    recognizeRailway,
    recognizeCurl,
    recognizeAws,
    recognizeGit,
    recognizePackagePublish,
    recognizeDb,
    recognizeRm,
  ];

  for (const fn of recognizers) {
    const hit = fn(c);
    if (hit) {
      // Path scope for rm targets when possible
      if (hit.service === "filesystem" && hit.effect === "delete") {
        const pathMatch = c.match(/\brm\b(?:\s+-[a-zA-Z]+)*\s+(\S+)/);
        if (pathMatch) {
          const { scope, external } = classifyPathScope(pathMatch[1], projectRoot);
          hit.scope = scope;
          if (external != null) hit.external = external;
        }
      }
      return { ...emptyEffect(raw), ...hit, raw };
    }
  }

  // sudo, chmod 777, mkfs, dd — high consequence
  if (/\b(sudo|chmod\s+777|mkfs|dd\s+if=)\b/i.test(c) || /\btruncate\b/i.test(c)) {
    return {
      ...emptyEffect(raw),
      effect: "invoke",
      resourceType: "shell",
      service: "bash",
      environment: detectEnvironment(c),
      scope: "project",
      external: false,
      destructive: true,
      reversible: false,
      credential: null,
      unknown: false,
    };
  }

  if (isReadOnlyCommand(c)) {
    return {
      ...emptyEffect(raw),
      effect: "invoke",
      resourceType: "shell",
      service: "bash",
      environment: detectEnvironment(c),
      scope: "project",
      external: false,
      destructive: false,
      reversible: true,
      credential: null,
      unknown: false,
    };
  }

  // Not on the read-only allowlist: we genuinely do not know what this does.
  // This used to fall through to "benign", which allowed anything the
  // recognizers above happened not to match — `find -delete` and `npx <pkg>`
  // both sailed through. Unknown now means ASK.
  return {
    ...emptyEffect(raw),
    effect: "invoke",
    resourceType: "shell",
    service: "bash",
    environment: detectEnvironment(c),
    scope: null,
    external: null,
    destructive: null,
    reversible: null,
    credential: null,
    unknown: true,
  };
}

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 */
function normalizeNetworkTool(toolName, input) {
  const url = String(input?.url || input?.uri || "");
  const host = extractHost(url) || (input?.domain ? String(input.domain) : null);
  const env = detectEnvironment(url) || (host ? detectEnvironment(host) : null);
  return {
    ...emptyEffect({ toolName, input }),
    effect: lower(toolName).includes("search") ? "search" : "fetch",
    resourceType: "http",
    service: host || "web",
    environment: env,
    scope: "external",
    external: true,
    destructive: false,
    reversible: true,
    credential: null,
    unknown: false,
  };
}

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 */
function normalizeMcp(toolName, input) {
  const n = lower(toolName);
  const blob = `${n} ${JSON.stringify(input || {})}`;
  const env = detectEnvironment(blob);

  const isDeploy = /\bdeploy/.test(n) || /\bdeploy/.test(blob);
  const isDelete = /\bdelete|\bdestroy|\bremove|\bdrop/.test(n) || /\bdelete|\bdestroy/.test(blob);
  const isProd = /\bproduction\b|\bprod\b/.test(n) || env === "production";

  return {
    ...emptyEffect({ toolName, input }),
    effect: isDelete ? "delete" : isDeploy ? "deploy" : "invoke",
    resourceType: "mcp",
    service: n.split("__")[0] || "mcp",
    environment: isProd ? "production" : env,
    scope: "external",
    external: true,
    destructive: isDelete || (isDeploy && isProd) || null,
    reversible: isDelete ? false : null,
    credential: isProd ? "production" : env === "staging" ? "staging" : null,
    unknown: !isDelete && !isDeploy,
  };
}

/**
 * Normalize a tool invocation into a common effect model.
 *
 * @param {{ toolName?: string, input?: Record<string, unknown>, projectRoot?: string }} args
 * @returns {NormalizedEffect}
 */
export function normalizeEffect({ toolName = "", input = {}, projectRoot = "" } = {}) {
  const name = String(toolName || "");
  const nl = lower(name);
  const root = projectRoot ? resolve(projectRoot) : "";

  if (["read", "write", "edit", "multiedit", "notebookedit", "notebookread", "delete"].includes(nl)) {
    return filesystemEffect(name, input || {}, root);
  }

  if (nl === "bash" || nl === "shell" || nl === "terminal") {
    const cmd = String(input?.command ?? input?.cmd ?? "");
    return normalizeBash(cmd, root);
  }

  if (nl === "webfetch" || nl === "web_fetch" || nl === "websearch" || nl === "web_search") {
    return normalizeNetworkTool(name, input || {});
  }

  if (nl.startsWith("mcp__") || nl.includes("__") || /\b(deploy|delete|production)\b/.test(nl)) {
    // MCP tools and any tool whose name advertises deploy/delete/production
    if (nl.startsWith("mcp__") || /\b(deploy|delete|production)\b/.test(nl)) {
      return normalizeMcp(name, input || {});
    }
  }

  // Glob / Grep / LS — project read
  if (["glob", "grep", "ls", "search", "semanticsearch", "task"].includes(nl)) {
    const path = String(input?.path || input?.glob || input?.pattern || "");
    const { scope, external } = classifyPathScope(path || root || ".", root || process.cwd());
    return {
      ...emptyEffect({ toolName: name, input }),
      effect: "read",
      resourceType: "file",
      service: "filesystem",
      environment: detectEnvironment(path),
      scope: scope || "project",
      external: external === true,
      destructive: false,
      reversible: true,
      credential: null,
      unknown: false,
    };
  }

  // Unknown tool — conservative
  return {
    ...emptyEffect({ toolName: name, input }),
    effect: "invoke",
    resourceType: "unknown",
    service: null,
    environment: detectEnvironment(JSON.stringify(input || {})),
    scope: null,
    external: null,
    destructive: null,
    reversible: null,
    credential: null,
    unknown: true,
  };
}
