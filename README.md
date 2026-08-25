# Iris for Claude Code

**See what Claude carries. Kill what you don't need. Control what it can do.**

[![npm](https://img.shields.io/npm/v/@zero-drift/iris.svg)](https://www.npmjs.com/package/@zero-drift/iris)
[![node](https://img.shields.io/node/v/@zero-drift/iris.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@zero-drift/iris.svg)](./LICENSE)

Iris is a local observability and guardrail layer for [Claude Code](https://code.claude.com). It runs on `127.0.0.1`,
sits between Claude Code and Anthropic, and answers four questions you otherwise cannot answer from the chat window:

1. **What is Claude actually sending?** — the full system prompt, every tool schema, the whole conversation, sized in tokens and priced in dollars.
2. **Does it need all of that?** — which schemas ship on every turn and were never once called.
3. **Is this action inside the task's authority?** — evaluated before the tool runs, not after.
4. **What actually happened?** — a local ledger of every call and every decision.

```text
Claude Code  →  Iris :8787  →  Anthropic
                    │
                    ├── Inspect context      what the request carried
                    ├── Remove unused tools  shrink the fixed prefix
                    ├── Apply Guard rules    Allow / Ask / Deny before execution
                    └── Record what ran      spend ledger + flight recorder
```

Everything stays on your machine. Iris adds **no extra model call** — Guard is deterministic code, not an LLM.

---

## Install

Requires **Node 18+**, Claude Code, and an Anthropic account Claude Code can already use.

```bash
# terminal 1 — leave this running
npx @zero-drift/iris

# terminal 2 — from the repo that has .claude/
npx @zero-drift/iris init
```

Restart Claude Code, then open **http://127.0.0.1:8787**. The in-app guide is at `/__guide`.

If Iris is not running, Claude Code cannot reach the API — `ANTHROPIC_BASE_URL` still points at localhost. That is the
trade for seeing the traffic.

### More than one project

One Iris instance serves **one** project — it resolves the project from the directory you start it in. For a second
project, just start a second instance there. There is nothing else to do:

```console
$ npx @zero-drift/iris
Port 8787 is in use by another Iris instance (project "checkout-api") — starting on 8788 instead.

Iris for Claude Code
  Project       covenant-layer
  Proxy         http://127.0.0.1:8788
  …
  Settings      re-pointed 8787 -> 8788 in .claude/settings.json
                restart Claude Code to pick it up
```

Iris finds a free port, then re-points **this project's** `.claude/settings.json` at the port it actually bound. You do
not pass `--port` and you do not re-run `init`; you only restart Claude Code, which reads settings at session start.

The rules behind that, in case you need to reason about them:

| Situation | What Iris does |
|---|---|
| Default port busy, occupant is Iris **on this project** | Prints "already running" with the URLs, exits `0` |
| Default port busy, occupant is anything else | Moves to the next free port and re-points this project's settings |
| `--port` / `PROXY_PORT` given and busy | **Refuses** — an explicit port is never silently moved |
| Settings point elsewhere, project **is** initialised | Re-points them to the bound port |
| Settings point elsewhere, project has **no Iris hook** | Warns with the `init` command — it will not wire a project you never opted in |
| `ANTHROPIC_BASE_URL` is not a loopback URL | Reported and left exactly as you set it |

Row four is the one that matters. A project pointed at another project's port does not fail visibly: its traffic is
recorded under the wrong project, and Guard evaluates its tool calls against the wrong envelope and the wrong project
root. Iris treats a port mismatch as a correctness problem, not a cosmetic one — which is why it fixes it rather than
printing advice.

Set `IRIS_AUTOWIRE=0` if you manage `.claude/settings.json` by hand; Iris will then only report the mismatch.

---

## How it works

Iris hooks Claude Code at **two** points. They are independent, and each one uses a feature Claude Code already has.

### 1. The proxy hop — everything the model receives

`init` writes `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` into `.claude/settings.json`. Every `POST /v1/messages`
now lands in Iris first. For each request Iris:

| Step | What happens | Code |
|---|---|---|
| Parse | JSON body → system blocks, `tools[]`, `messages[]` | [analyzer.mjs](src/context/analyzer.mjs) |
| Size | `estTokens = chars / 4` per tool schema, ranked descending | [schemas.mjs](src/context/schemas.mjs) |
| Preview | System prompt captured **in full** (not truncated), messages summarised per block | [analyzer.mjs:37](src/context/analyzer.mjs#L37) |
| Log | Request and response written to `.claude/proxy-logs/`, secrets scrubbed | [redact.mjs](src/security/redact.mjs) |
| Forward | Byte-identical to `api.anthropic.com` unless wire redaction is on | [proxy.mjs](src/runtime/proxy.mjs) |
| Price | `usage` extracted from the response, costed at list rates | [pricing.mjs](src/billing/pricing.mjs) |
| Calibrate | `chars/4` undercounts modern tokenizers, so the measured input total corrects the estimate | [calibration.mjs](src/context/calibration.mjs) |

That last row matters. Iris does not price a raw `chars/4` guess — it divides the *measured* input total by its own
estimate and scales every figure by that ratio, so the dollar numbers track what you were actually billed.

### 2. The hook hop — everything the agent does

`init` also installs `node "<pkg>/bin/iris.mjs" hook` as both a **PreToolUse** and a **PostToolUse** hook. PreToolUse
runs *before* the tool executes and returns a permission decision; PostToolUse records the outcome.

```text
Claude wants to run  Bash("rm -rf /etc")
        │
        ▼
  PreToolUse hook ──► normalizeEffect()   what does this actually DO?
        │                  │
        │                  ▼
        │             evaluate()          is that inside the envelope?
        │                  │
        ▼                  ▼
  { permissionDecision: "deny", reason: "…" }  ──►  Claude Code blocks it
```

The hook never asks a model. It is a pure function of the tool call, the project root, and the authority envelope on
disk. If the envelope is missing or unreadable, it **fails closed to ASK** — never a silent allow.

---

## What Claude is actually sending

Press `4` for **Context**. This is the newest turn on the wire, drawn to scale.

![Context budget](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/context.png)

Read this top band carefully — it is the whole argument for the rest of the tool:

- **7,225 tokens** went out on this turn.
- **5,149 of them are the fixed prefix** — the system prompt plus every tool schema. That block is **re-sent on every
  single turn** of the session. Your actual question is the small purple sliver on the right.
- **2 cache breakpoints** — the dashed lines. Cached blocks are billed at write price once, then read back at roughly
  10% of input price until the TTL expires.

The breakdown underneath splits it three ways: **system prompt 21.1%**, **tool schemas 50.2%**, **conversation 28.7%**.
In this capture, half the payload was tool definitions, and the model called almost none of them.

### The system prompt, block by block

Click **System prompt**. Iris shows every block it saw, full text, with its size and whether it carries `cache_control`.
Message blocks are previewed at 300 characters; the system prompt deliberately is not, because you cannot audit a token
tax you are only shown the first paragraph of. The only cap is a 200k-character guard against a pathological payload.

![System prompt blocks](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/context-system.png)

Walking the capture above:

| Block | Size | Cached | What it is |
|---|---|---|---|
| **Block 1** | 2,656 chars | ✅ | The agent's own operating instructions — identity, tone and style, code conventions, task management, doing-tasks guidance. This is Claude Code's own prompt, and you are paying for it every turn. |
| **Block 2** | 1,268 chars | ✅ | Environment + your project's rules: working directory, platform, date, and your `CLAUDE.md`. This is the block **you** control. |

What to look for as you read your own:

- **Block count and cache flags.** Uncached system blocks are re-billed at full input price every turn. Two cached
  blocks with a stable prefix is the cheap shape.
- **How much of block 2 is yours.** A `CLAUDE.md` that grew to a few thousand characters is a permanent per-turn tax.
  Iris shows you exactly what it costs before you decide whether the rule is worth it.
- **Order.** Anything appended *before* a cache breakpoint invalidates the cache below it. If your project instructions
  change every session, the whole prefix underneath them is rewritten at write price.

The sibling tabs finish the picture: **Tool schemas** lists each definition with its token weight and call count,
**Conversation** shows every message block including `tool_use` / `tool_result` payloads, and **Changes** diffs the
prefix between two live turns and attributes growth to a source.

---

## Saving tokens

Press `5` for **Optimize**. Tool schemas are the biggest controllable line item, because a schema ships whether or not
the tool is ever called — Claude needs the definition in context *before* it can decide to use it.

![Optimize](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/optimize.png)

From the capture above:

```text
Shipping today                 3.6k tok/turn   $0.0035/turn   $14.01/month
Enabled but never called (9)   2.5k tok/turn   $0.0024/turn    $9.53/month   ← pure waste
After trimming every unused    1.2k tok/turn   $0.0011/turn    $4.48/month
```

Nine of thirteen schemas shipped on all eight turns and the agent never reached for one of them. That is **68% of the
tool budget** spent on definitions nobody used. The monthly figures are your own measured `$/Mtok` multiplied by an
assumed turn rate you can edit in the panel — not a vendor's marketing number.

### How the trim actually works

Toggling a tool off stages a change; nothing is written until you press **Publish changes**. Publishing writes a **bare
tool name** into Claude Code's `permissions.deny`:

```json
{ "permissions": { "deny": ["NotebookEdit", "mcp__canva__export_design"] } }
```

The distinction Iris cares about ([permissions.mjs](src/adapters/claude/permissions.mjs)):

| Deny rule | Removes schema from context | Blocks execution |
|---|---|---|
| `"NotebookEdit"` (bare name) | **yes** — the schema stops shipping | yes |
| `{ "tool": "Bash", "path": "…" }` (scoped) | no — still in context | yes |

Only bare names shrink the payload, so Optimize only ever writes bare names. Two caveats it states rather than hides:

- Claude Code applies the deny list on the **next session**, not the next turn.
- A prefix already resident in cache **keeps billing until its TTL expires**.

The **Trim simulator** under Context → Tool schemas models a change before you commit to it, and Optimize protects
tools tagged Core behind an explicit unlock — an agent without `Read`, `Edit` and `Bash` cannot do the job, and
"deny Bash for safety" is the wrong tool for that problem. Use Guard for that instead.

![Trim simulator](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/context-tools.png)

---

## Preventing harmful commands

Press `6` for **Guard**. Optimize decides *what Claude can see*; Guard decides *what Claude can do*.

![Guard](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/guard.png)

### Step 1 — normalize the effect, not the string

Matching on command text is how you end up denying `echo "the word production appears in this string"`. Iris instead
compiles the tool call into a structured **effect** ([effects.mjs](src/guard/effects.mjs)):

```js
{ effect: "delete", resourceType: "cloud", service: "aws",
  environment: "production", external: true, destructive: true,
  reversible: false, credential: "production", unknown: false }
```

Before classifying, it strips the parts of a command that are *data* rather than *targets* — heredoc bodies, comments,
and prose inside quotes — so a deployment keyword in a log line is not read as a deployment target.

Dedicated recognizers cover filesystem tools, Railway, AWS, git, npm/yarn/pnpm publish + install, databases
(`psql`/`mysql`/`mongosh`/`redis-cli`), `curl`/`wget`, and `rm`. Anything else falls to a **read-only allowlist** of
58 inspection commands (`ls`, `grep`, `cat`, `head`, `find`, `jq`, `awk`, `stat` …). The allowlist is deliberate:

> A denylist can only catch the shapes it has been taught, and silently allows the rest.

So `npx some-unknown-cli` is not "probably fine" — it is `unknown: true`, and unknown means **ASK**. The allowlist also
revokes itself when a reader is turned into a writer: `sed -i`, `find -delete`, any `>` redirect, or any `$(…)`
command substitution drops the command out of read-only.

### Step 2 — evaluate against the authority envelope

The envelope is the task's authority, stored **outside the conversation** at
`~/.iris/projects/<id>/sessions/authority.json`. The model can propose one; it cannot widen one. Defaults
([authority.mjs](src/guard/authority.mjs)):

```json
{
  "scope": {
    "filesystem":     ["$PROJECT/**"],
    "environments":   ["staging"],
    "network":        [],
    "destructive":    "ask",
    "production":     "deny",
    "credentials":    ["staging"],
    "externalWrites": "ask"
  }
}
```

`evaluate()` walks a fixed ladder and returns the first match ([policy.mjs](src/guard/policy.mjs)):

```text
1. Hard deny          production env · production credentials · denied destructive · denied external writes
2. Scope violation    path outside $PROJECT · env not in scope · host not in allowlist
3. Authority expand   staging-scoped session reaching for production · credential discovery beyond envelope
4. High consequence   unknown effect · destructive · external write · credential use          → ASK
5. Explicit allow     in-project non-destructive file ops · known-safe local commands
6. Default            ASK
```

### Step 3 — what that produces

Every row below is **real output** from the capture that produced these screenshots, against the default envelope:

| Tool call | Decision | Rule |
|---|---|---|
| `Read src/guard/policy.mjs` | 🟢 **ALLOW** | `explicit-allow.in-scope` |
| `Edit src/guard/effects.mjs` | 🟢 **ALLOW** | `explicit-allow.in-scope` |
| `npm test` | 🟢 **ALLOW** | `explicit-allow.in-scope` |
| `git status --short` | 🟢 **ALLOW** | `explicit-allow.in-scope` |
| `grep -rn TODO src` | 🟢 **ALLOW** | `explicit-allow.in-scope` |
| `rm -rf ./build` | 🟡 **ASK** | `high-consequence.destructive` |
| `npx unknown-cli --wipe` | 🟡 **ASK** | `high-consequence.unknown` |
| `git push origin main` | 🟡 **ASK** | `high-consequence.external-writes` |
| `Write /Users/dev/.ssh/config` | 🔴 **DENY** | `scope.filesystem` |
| `npm publish --access public` | 🔴 **DENY** | `hard-deny.production` |
| `aws s3 rm s3://acme-prod-assets --recursive` | 🔴 **DENY** | `hard-deny.production` |
| `psql postgres://prod-db.internal/app -c "DROP TABLE users"` | 🔴 **DENY** | `hard-deny.production` |
| `curl -X DELETE https://api.production.acme.com/v1/volumes/42` | 🔴 **DENY** | `hard-deny.production` |

Note what is *not* denied. `git push origin main` asks rather than blocks — a branch name is not an environment, and
treating it as one made every ordinary push a "production deploy". `npm test` allows — classifying it as an install
made it prompt on every run. A guardrail that cries wolf gets switched off.

### Step 4 — trajectory signals

Single calls are not the whole risk. A session that reads, fails, retries, then reaches for a production credential is
a pattern, and [trajectory.mjs](src/guard/trajectory.mjs) tracks it across the session:

| Signal | Fires when |
|---|---|
| `AUTHORITY_EXPANSION` | environment escalates (staging → production) |
| `CONSEQUENCE_ESCALATION` | read/write turns into destructive |
| `CREDENTIAL_SCOPE_CHANGE` | credential scope widens, or a secret is discovered after a failure |
| `RECOVERY_ESCALATION` | recovery depth ≥ 2 while effects keep escalating |
| `PRODUCTION_DESTRUCTIVE` | destructive effect aimed at production |

### Where Guard is strong, and where it is not

**Strong**, because these follow from structure rather than judgement:

- **Path containment** — paths are resolved against the project root; outside means denied.
- **Authority cannot expand itself** — the model does not own the envelope file, and a proposal that grants more than
  the current envelope is rejected.
- **Fails closed** — missing envelope, unreadable envelope, or unclassifiable command all resolve to ASK or stricter,
  and every decision is written to the ledger.

**Honest limits:**

- Arbitrary shell is not perfectly classifiable. Recognizers catch known dangerous shapes; a deliberately unusual
  command may still slip past one into ASK rather than DENY.
- The prose-stripping heuristic narrows a known false-positive class. It is a heuristic, not a shell parser.
- Guard is *another* boundary around the agent — strongest on filesystem scope and production access. It should not be
  the only protection standing between an agent and irreversible infrastructure.

---

## Day-to-day guide

![Overview](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/overview.png)

Keys `1`–`7` switch views; `⌘K` / `Ctrl-K` opens the command palette; in the call drawer `j` / `k` step through calls
and `Esc` closes. The header time range (Last hour / Today / This week / This month / All) filters every view except
Optimize, which deliberately stays on the live inventory — what would ship on the *next* turn.

| Key | View | Use it to |
|---|---|---|
| `1` | **Overview** | Session cost, context shipped, unused-schema tax, Guard tallies, flagged anomalies |
| `2` | **Spend** | Daily cost, cache savings vs writing the same tokens, models used, cache expiries |
| `3` | **Traffic** | Every `/v1/messages` call: tokens, latency, cache hit, cost. Filter Slow / Cache miss / Failed |
| `4` | **Context** | The newest turn broken into system / tools / conversation, plus diffs and attribution |
| `5` | **Optimize** | Tool inventory with call counts; stage and publish trims |
| `6` | **Guard** | Write the task, accept the envelope, read the decision ledger and signals |
| `7` | **Flight Recorder** | What actually ran, in order, with the Guard decision on each |

![Flight Recorder](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/trace.png)

A normal first session:

1. Start Iris, run `init`, restart Claude Code, then work normally for a while.
2. Open **Context** (`4`) and read your fixed prefix. Note the system-block sizes and the tools share.
3. Open **Optimize** (`5`). Sort by never-called. Toggle off the large optional and MCP schemas you do not need for
   this project — leave Core tools alone. **Publish changes**, then start a new Claude Code session.
4. Open **Guard** (`6`). Write one line describing the task, press **Accept envelope**. Guard now enforces it.
5. Come back to **Spend** (`2`) and **Flight Recorder** (`7`) at the end of the day.

---

## Commands

| Command | What it does |
|---|---|
| `iris [--port N]` | Start proxy + UI (`start` / `run` are aliases) |
| `iris init [--port N]` | Configure this project for Claude Code; without `--port` it discovers a running instance for this directory. Only needed once — after that the server keeps the port in sync |
| `iris hook` | Pre/PostToolUse hook body — Claude Code invokes this, not you |
| `iris version` | Print version |
| `iris help` | Usage |

What `init` writes, all idempotent — re-running never wipes your `permissions.deny`:

- `.claude/settings.json` → `ANTHROPIC_BASE_URL`, `IRIS_HOME`, `IRIS_ENVELOPE_PATH`, PreToolUse + PostToolUse hooks
- `.claude/iris-project.json` → project id and metadata
- `~/.iris/projects/<id>/sessions/authority.json` → a first envelope draft, if none exists
- `.gitignore` → the four capture paths

From a git checkout: `npm start`.

---

## Configure

| Variable | Default | What it does |
|---|---|---|
| `PROXY_PORT` | `8787` | Bind `127.0.0.1`. Set explicitly, it is never auto-moved on a conflict |
| `ANTHROPIC_PROXY_TARGET` | `https://api.anthropic.com` | Upstream |
| `IRIS_HOME` | `~/.iris` | Per-project store |
| `IRIS_ENVELOPE_PATH` | `~/.iris/projects/<id>/sessions/authority.json` | Guard file (hook = UI = server) |
| `IRIS_UI_TOKEN` | unset | Require `X-Iris-Token` on mutating UI routes |
| `IRIS_ADAPTER` | `claude-code` | Host adapter |
| `IRIS_AUTOWIRE` | on | Keep `ANTHROPIC_BASE_URL` pointed at the bound port (`=0` to manage it yourself) |
| `PROXY_REDACT` | on | Scrub secrets in logs (`=0` off) |
| `PROXY_REDACT_EMAILS` | on | Scrub emails (`=0` keep) |
| `PROXY_REDACT_WIRE` | off | Redact on the wire, rehydrate the response (`=1` on) |

If `IRIS_UI_TOKEN` is set, open `/__monitor?iris_token=…` once. Query `?token=` on POST URLs is not accepted. The gate
covers `POST` on `/__config`, `/__authority`, `/__correlate`, `/__guard/evaluate`, `/__export`, and `/__reset`.

Path overrides used mainly by the test suite: `PROXY_LOG_DIR`, `PROXY_HISTORY_PATH`, `PROXY_ACTIONS_PATH`,
`PROXY_SETTINGS_PATH`, `PROXY_IRIS_PATH`, `IRIS_DECISIONS_PATH`, `IRIS_LEDGER_PATH`.

---

## Privacy and redaction

Iris binds to `127.0.0.1` and keeps everything local. Requests are forwarded **byte-for-byte** unless you explicitly
turn on wire redaction.

- **At rest (default on).** Before anything is written to `proxy-logs/`, 14 credential patterns are scrubbed —
  Anthropic keys, private keys, AWS ids and secrets, GitHub / GitLab / Slack / Stripe / Google / OpenAI keys, JWTs,
  bearer tokens, npm tokens, and generic `api_key = …` assignments. Emails too, unless `PROXY_REDACT_EMAILS=0`.
  Each match becomes `{{kind:hash}}` — stable enough to correlate, useless if leaked.
- **On the wire (opt-in).** `PROXY_REDACT_WIRE=1` swaps secrets for placeholders in the *outbound* request and
  rehydrates them in the streamed response, so the model never sees the real value but your terminal still does. The
  placeholder→value vault is memory-only and per-run — a vault on disk is just a smaller file containing all your
  secrets. `thinking` blocks are passed through untouched, because editing them invalidates their signature.

## Where data lands

| Path | Contents |
|---|---|
| `.claude/proxy-logs/` | Captured request / response payloads |
| `.claude/history-index.json` | Call index behind Spend and Traffic |
| `.claude/action-log.json` | Tool action ledger |
| `~/.iris/projects/<id>/sessions/` | `authority.json`, `decisions.json` |
| `~/.iris/projects/<id>/exports/` | JSON / CSV exports |

Export from the UI writes history, actions, or decisions to the exports directory. **Clear captured data** removes only
files this proxy wrote (`POST /__reset` requires `{"confirm":"clear"}`). `/__classic` is a lighter UI over the same
data; `/__health` and `/__meta` report status.

## Tests

```bash
npm test
```

## Notes on the numbers

- Dollars are **list rates** for known models. Promos and contracts are not modelled — Claude Console is the invoice.
- An unknown model stays unpriced rather than being printed as `$0.00`.
- Token counts start as `chars/4` and are then calibrated against measured usage; they are close, not exact.
- Screenshots on this page are a real capture against a local stub upstream, so the traffic is synthetic but every
  number, decision and layout is what the tool actually produced.

## License

MIT

Iris is an independent open-source project and is not affiliated with or endorsed by Anthropic.
