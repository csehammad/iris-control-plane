# Iris for Claude Code

**Inspect Claude Code context, remove unused tool schemas, and control tool execution before it happens.**

[![npm](https://img.shields.io/npm/v/@zero-drift/iris.svg)](https://www.npmjs.com/package/@zero-drift/iris)
[![node](https://img.shields.io/node/v/@zero-drift/iris.svg)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-176%20passing-brightgreen.svg)](#running-from-a-checkout)
[![license](https://img.shields.io/npm/l/@zero-drift/iris.svg)](./LICENSE)

Iris is a local proxy and policy layer for [Claude Code](https://code.claude.com). It binds to `127.0.0.1` and sits between Claude Code and Anthropic.

For each request, Iris shows what Claude Code sent: the system prompt, tool schemas, conversation history, estimated token usage, and list-price cost. It also evaluates tool calls before execution and records the decision.

Iris makes no model calls of its own. Guard decisions are deterministic, and the runtime uses Node's standard library.

```text
Claude Code  →  Iris :8787  →  api.anthropic.com
                    │
                    ├── Context     inspect what each request carries
                    ├── Optimize    find tool schemas consuming unused context
                    ├── Guard       allow, ask, or deny before execution
                    └── Recorder    record actions and policy decisions
```

---

## Context cost

Claude Code sends tool definitions with each request so the model has the schemas available when deciding which tools to call.

That means an enabled tool can consume context even when the conversation never uses it.

On one setup, measured with Claude Code's `/context` command:

```text
BEFORE                          AFTER

System prompt    2.4k           System prompt    2.4k
System tools    25.6k           System tools     3.2k
────────────────────            ────────────────────
Baseline        28.0k           Baseline         5.6k

                    ↓ 22.4k tokens per turn
```

Both captures used the same project and the same eight-message conversation. The available tool schemas were the only change.

The 22.4k reduction came from that environment. Your numbers depend on the tools and MCP servers you have enabled and how many of them are useful to your workflow.

Iris measures the request you are actually sending so you can make that decision from your own data.

![Context](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/context.png)

The band at the top represents a live turn to scale. The system prompt and tool schemas make up the fixed prefix that Claude Code sends again with each message.

---

## Install

Requires Node 18+, Claude Code, and an Anthropic account that Claude Code can already use.

```bash
npx @zero-drift/iris          # terminal 1: keep Iris running
npx @zero-drift/iris init     # terminal 2: run from a project with .claude/
```

Restart Claude Code, then open:

```text
http://127.0.0.1:8787
```

`iris init` configures the project to send Anthropic traffic through the local Iris instance by setting `ANTHROPIC_BASE_URL`.

Keep Iris running while using Claude Code in that project.

One Iris instance serves one project. Starting Iris from another project selects an available port and updates that project's configuration.

---

## How it works

Iris uses two integration points already provided by Claude Code.

### Request proxy

Every `POST /v1/messages` reaches Iris before being forwarded upstream.

Iris separates the request into system blocks, `tools[]`, and `messages[]` using [analyzer.mjs](src/context/analyzer.mjs). Tool definitions are measured in [schemas.mjs](src/context/schemas.mjs), and stored captures pass through [redact.mjs](src/security/redact.mjs) before being written to disk.

The request is forwarded through [proxy.mjs](src/runtime/proxy.mjs).

Initial token estimates use `chars/4`. Once Anthropic returns measured input usage, [calibration.mjs](src/context/calibration.mjs) uses that value to correct the estimate. Cost calculations then follow measured usage more closely.

### Tool hooks

`iris init` installs `iris hook` as Claude Code PreToolUse and PostToolUse hooks.

PreToolUse runs before execution and returns the permission decision.

```text
Claude wants to run:

Bash("aws s3 rm s3://acme-prod-assets --recursive")

        │
        ▼

normalizeEffect()

        │
        │  {
        │    effect: "delete",
        │    service: "aws",
        │    environment: "production",
        │    reversible: false
        │  }
        ▼

evaluate()

        │
        ▼

{
  permissionDecision: "deny",
  reason: "hard-deny.production"
}
```

The result is computed from the tool call, the project root, and the authority envelope stored on disk.

If the envelope is missing or unreadable, Guard falls back to ASK.

---

## Optimize

Tool schemas are often the largest part of the request that can be reduced directly.

Optimize lists the definitions currently being sent along with their token weight and observed call count. Changes are staged for review before they are published.

![Optimize](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/optimize.png)

Publishing adds a **bare tool name** to Claude Code's `permissions.deny` through [permissions.mjs](src/adapters/claude/permissions.mjs).

| Deny rule                         | Removes schema from context | Blocks execution |
| --------------------------------- | --------------------------- | ---------------- |
| `"NotebookEdit"`                  | yes                         | yes              |
| `{ "tool": "Bash", "path": "…" }` | no                          | yes              |

Claude Code removes a tool schema from the request when the deny entry uses the bare tool name. Optimize therefore publishes bare names when trimming context.

There are two timing details to keep in mind.

Claude Code applies the updated deny list when a new session starts. An existing cached prefix can also continue affecting billing until its cache entry expires.

Core tools require an explicit unlock before Optimize can disable them. Removing tools such as `Read`, `Edit`, or `Bash` can prevent an agent from doing normal project work. Use Guard when the goal is to restrict what those tools may do.

---

## Guard

Guard converts each tool call into a structured effect using [effects.mjs](src/guard/effects.mjs), then evaluates that effect against an authority envelope stored at:

```text
~/.iris/projects/<id>/sessions/authority.json
```

The classifier looks at the operation represented by the call instead of treating individual words as policy signals.

For example, the word `production` appearing inside harmless text does not automatically turn the call into a production operation.

The model may propose an authority envelope. Changes that widen an existing envelope are rejected.

![Guard](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/guard.png)

Default-envelope examples:

| Tool call                                     | Decision | Rule                               |
| --------------------------------------------- | -------- | ---------------------------------- |
| `Read src/guard/policy.mjs`                   | ALLOW    | `explicit-allow.in-scope`          |
| `npm test`                                    | ALLOW    | `explicit-allow.in-scope`          |
| `rm -rf ./build`                              | ASK      | `high-consequence.destructive`     |
| `npx unknown-cli --wipe`                      | ASK      | `high-consequence.unknown`         |
| `git push origin main`                        | ASK      | `high-consequence.external-writes` |
| `Write ~/.ssh/config`                         | DENY     | `scope.filesystem`                 |
| `aws s3 rm s3://acme-prod-assets --recursive` | DENY     | `hard-deny.production`             |

`git push` resolves to ASK because the command represents an external write that requires approval.

`npm test` is allowed as normal in-scope execution. Treating every npm command as package installation would add approval prompts to ordinary test runs.

Path containment is resolved against the project root. Calls that cannot be classified safely resolve to ASK or a stricter decision. Every decision is written to the action history.

### Execution boundary

Guard evaluates intent before a tool runs. It does not isolate the process that executes an allowed command.

Shell behavior can be difficult to classify completely from the command alone, and Guard's prose-stripping logic is a heuristic rather than a full shell parser.

For projects where Claude Code can run arbitrary commands, consider running Claude Code and Iris inside a Dev Container. This keeps execution inside a container and limits access to host files and processes outside the mounted workspace.

The repository remains writable from inside the container. Explicit mounts, credentials placed inside the environment, Docker socket access, and available network connections remain part of the security boundary.

See the [Dev Containers guide](https://hammadabbasi.com/iris/docs/dev-containers) for the threat model, recommended setup, persistent Claude and Iris state, credential handling, and network restrictions.

---

## Running from a checkout

```bash
git clone https://github.com/csehammad/iris-control-plane.git
cd iris-control-plane

npm start      # proxy + UI on 127.0.0.1:8787
npm test       # 176 assertions across 6 suites
```

Iris has no runtime or development package dependencies, so there is no install step after cloning.

The test suite uses a local stub upstream. It requires no API key and makes no outbound calls.

### Project layout

```text
bin/iris.mjs          CLI: start, init, hook

src/runtime/          proxy, HTTP server, sessions, SSE events
src/context/          request analysis, schema sizing, calibration, trim modelling
src/guard/            effect normalization, policy ladder, authority, trajectory
src/adapters/claude/  Claude Code settings, hooks, permissions
src/billing/          usage extraction, list pricing, cache accounting
src/security/         secret redaction, credential patterns
src/forensic/         action ledger, correlation, timeline, export

ui/                   dashboard, classic UI, in-app guide
tests/                6 suites, run with `node tests/run.mjs`
```

The adapter boundary lives in [contract.mjs](src/adapters/contract.mjs).

Claude Code is currently the implemented host. `IRIS_ADAPTER` selects the adapter.

---

## Configuration

These are the main settings. The documentation covers the rest.

| Variable            | Default   | Effect                                                                                     |
| ------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `PROXY_PORT`        | `8787`    | Bind port. An explicitly configured port stays fixed on conflict                           |
| `IRIS_HOME`         | `~/.iris` | Storage for envelopes, decisions, and exports                                              |
| `IRIS_AUTOWIRE`     | on        | Keeps `ANTHROPIC_BASE_URL` pointed at the active Iris port. Set `=0` to manage it yourself |
| `PROXY_REDACT`      | on        | Scrubs detected secrets before captures are written to disk                                |
| `PROXY_REDACT_WIRE` | off       | Redacts outbound traffic as well and rehydrates the streamed response                      |
| `IRIS_UI_TOKEN`     | unset     | Requires `X-Iris-Token` on mutating UI routes                                              |

Project-local captures are stored in:

```text
.claude/proxy-logs/
.claude/history-index.json
.claude/action-log.json
```

Authority envelopes and decisions are stored under:

```text
~/.iris/projects/<id>/
```

`iris init` adds the project-local Iris data paths to `.gitignore`.

---

## Documentation

| Guide                                                                 | Covers                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Quickstart](https://hammadabbasi.com/iris/docs/quickstart)           | Installation, first session, and first trim                             |
| [Context](https://hammadabbasi.com/iris/docs/context)                 | Request composition, token measurement, and calibration                 |
| [Optimize](https://hammadabbasi.com/iris/docs/optimize)               | Reviewing tool schemas and publishing trims                             |
| [Guard](https://hammadabbasi.com/iris/docs/guard)                     | Authority envelopes, effect classification, and policy decisions        |
| [Security](https://hammadabbasi.com/iris/docs/security)               | Threat model, redaction, credentials, and storage                       |
| [Troubleshooting](https://hammadabbasi.com/iris/docs/troubleshooting) | Ports, hooks, configuration, and recovering disabled tools              |
| [The Token Tax](https://hammadabbasi.com/iris/token-tax)              | Method behind the 28.0k → 5.6k context measurement                      |

---

## Contributing

Issues and pull requests are welcome.

[Open an issue](https://github.com/csehammad/iris-control-plane/issues) for bugs, proposals, or implementation questions.

Guard recognizers and adapters for additional agent hosts are useful areas for contributions.

Before opening a pull request:

```bash
npm test
```

Changes to Guard behavior should include a corresponding case in `tests/guard.test.mjs`.

Cost figures use published list rates for models Iris recognizes. Models without a known price are left unpriced instead of being displayed as `$0.00`.

Token counts are calibrated estimates and can differ from final billing totals. Use Claude Console for invoice values.

---

## License

MIT.

Iris is an independent open-source project with no affiliation or endorsement from Anthropic.
