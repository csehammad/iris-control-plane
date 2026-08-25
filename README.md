# Iris for Claude Code

**See what Claude carries. Kill what you don't need. Control what it can do.**

[![npm](https://img.shields.io/npm/v/@zero-drift/iris.svg)](https://www.npmjs.com/package/@zero-drift/iris)
[![node](https://img.shields.io/node/v/@zero-drift/iris.svg)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-169%20passing-brightgreen.svg)](#running-from-a-checkout)
[![license](https://img.shields.io/npm/l/@zero-drift/iris.svg)](./LICENSE)

Iris is a local proxy and policy layer for [Claude Code](https://code.claude.com). It binds to
`127.0.0.1`, sits between Claude Code and Anthropic, and shows you the payload of every request —
the system prompt, each tool schema, the whole conversation — sized in tokens and priced at list
rates. It also decides whether a tool call is allowed to run, before it runs.

Nothing leaves your machine, and Iris makes no model calls of its own. Guard is deterministic
code. No runtime dependencies — the whole thing is Node's standard library.

```text
Claude Code  →  Iris :8787  →  api.anthropic.com
                    │
                    ├── Context     what the request carried
                    ├── Optimize    which schemas ship without ever being called
                    ├── Guard       allow / ask / deny, evaluated before execution
                    └── Recorder    what ran, and under which decision
```

---

## The measurement behind it

Claude Code sends every tool definition on every turn, because the model needs the schema in
context before it can decide to call the tool. Tools you never touch are still paid for, every
message. Measured with Claude Code's own `/context` on one setup:

```text
BEFORE                          AFTER
System prompt    2.4k           System prompt    2.4k
System tools    25.6k           System tools     3.2k
────────────────────            ────────────────────
Baseline        28.0k           Baseline         5.6k

                    ↓ 22.4k tokens per turn
```

Same project, same eight-message conversation; only the tool schemas changed between captures.
This is one measured setup, not a promised saving — what you can recover depends on which tools
and MCP servers you have enabled and how many you actually use. Iris exists to measure yours.

![Context](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/context.png)

The band at the top is one live turn drawn to scale. The fixed prefix — system prompt plus tool
schemas — is re-sent on every message of the session; your question is the sliver on the right.

---

## Install

Requires Node 18+, Claude Code, and an Anthropic account Claude Code can already use.

```bash
npx @zero-drift/iris          # terminal 1 — leave running
npx @zero-drift/iris init     # terminal 2 — from a project with .claude/
```

Restart Claude Code, then open <http://127.0.0.1:8787>.

`init` points `ANTHROPIC_BASE_URL` at localhost, so Iris needs to be running for Claude Code to
reach the API. One instance serves one project; start another in a second project and it finds a
free port and re-points that project's settings itself.

---

## How it works

Two independent integration points, each using a feature Claude Code already has.

**The proxy hop** sees everything the model receives. Every `POST /v1/messages` lands in Iris
first, which parses the body into system blocks, `tools[]` and `messages[]`
([analyzer.mjs](src/context/analyzer.mjs)), sizes each schema
([schemas.mjs](src/context/schemas.mjs)), logs the exchange with secrets scrubbed
([redact.mjs](src/security/redact.mjs)), and forwards it byte-identically upstream
([proxy.mjs](src/runtime/proxy.mjs)). Token counts start as `chars/4`, then the measured input
total from the response corrects the estimate ([calibration.mjs](src/context/calibration.mjs)) —
so the dollar figures track what you were billed rather than a raw guess.

**The hook hop** sees everything the agent does. `init` installs `iris hook` as a PreToolUse and
PostToolUse hook. PreToolUse runs before the tool executes and returns a permission decision:

```text
Claude wants to run  Bash("aws s3 rm s3://acme-prod-assets --recursive")
        │
        ▼
  normalizeEffect()   what does this actually DO?
        │             { effect: "delete", service: "aws",
        │               environment: "production", reversible: false }
        ▼
  evaluate()          is that inside the authority envelope?
        │
        ▼
  { permissionDecision: "deny", reason: "hard-deny.production" }
```

No model is involved. It is a pure function of the tool call, the project root, and the envelope
on disk. A missing or unreadable envelope fails closed to ASK, never to a silent allow.

---

## Optimize

Tool schemas are the biggest controllable line item. Optimize lists every definition on the wire
with its token weight and how many times it was actually called, and stages a trim you review
before publishing.

![Optimize](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/optimize.png)

Publishing writes a **bare tool name** into Claude Code's `permissions.deny`
([permissions.mjs](src/adapters/claude/permissions.mjs)):

| Deny rule | Removes schema from context | Blocks execution |
|---|---|---|
| `"NotebookEdit"` (bare name) | yes | yes |
| `{ "tool": "Bash", "path": "…" }` (scoped) | no | yes |

Only bare names shrink the payload, so Optimize only writes bare names. Two caveats it states
rather than hides: Claude Code applies the deny list on the next session, not the next turn, and a
prefix already resident in cache keeps billing until its TTL expires. Core tools sit behind an
explicit unlock — an agent without `Read`, `Edit` and `Bash` cannot do the job, and "deny Bash for
safety" is the wrong instrument. Use Guard for that.

---

## Guard

Guard does not pattern-match command strings — that is how you end up denying
`echo "the word production appears here"`. It compiles the call into a structured effect
([effects.mjs](src/guard/effects.mjs)) and evaluates it against an authority envelope stored
outside the conversation at `~/.iris/projects/<id>/sessions/authority.json`. The model can propose
an envelope; it cannot widen one.

![Guard](https://raw.githubusercontent.com/csehammad/iris-control-plane/main/docs/images/guard.png)

Real decisions against the default envelope:

| Tool call | Decision | Rule |
|---|---|---|
| `Read src/guard/policy.mjs` | ALLOW | `explicit-allow.in-scope` |
| `npm test` | ALLOW | `explicit-allow.in-scope` |
| `rm -rf ./build` | ASK | `high-consequence.destructive` |
| `npx unknown-cli --wipe` | ASK | `high-consequence.unknown` |
| `git push origin main` | ASK | `high-consequence.external-writes` |
| `Write ~/.ssh/config` | DENY | `scope.filesystem` |
| `aws s3 rm s3://acme-prod-assets --recursive` | DENY | `hard-deny.production` |

Note what is *not* denied. `git push` asks rather than blocks — a branch name is not an
environment. `npm test` allows — classifying it as an install made it prompt on every run. A
guardrail that cries wolf gets switched off.

**Where it is strong:** path containment is resolved against the project root; the envelope cannot
expand itself; anything unclassifiable resolves to ASK or stricter; every decision is logged.

**Where it is not:** Guard is not a sandbox. Arbitrary shell is not perfectly classifiable, the
prose-stripping heuristic is a heuristic and not a shell parser, and Guard should not be the only
boundary between an agent and irreversible infrastructure.

---

## Running from a checkout

```bash
git clone https://github.com/csehammad/iris-control-plane.git
cd iris-control-plane
npm start      # proxy + UI on 127.0.0.1:8787
npm test       # 169 assertions across 6 suites
```

There is no install step — Iris has zero dependencies, runtime or dev. The suite runs against a
local stub upstream, so it needs no API key and makes no outbound calls.

### Project layout

```text
bin/iris.mjs          CLI — start, init, hook
src/runtime/          proxy, HTTP server, sessions, SSE events
src/context/          request analysis, schema sizing, calibration, trim modelling
src/guard/            effect normalization, policy ladder, authority, trajectory
src/adapters/claude/  Claude Code integration — settings, hooks, permissions
src/billing/          usage extraction, list pricing, cache accounting
src/security/         secret redaction, credential patterns
src/forensic/         action ledger, correlation, timeline, export
ui/                   dashboard (iris.html), classic.html, in-app guide
tests/                6 suites, run with `node tests/run.mjs`
```

The adapter boundary is [contract.mjs](src/adapters/contract.mjs) — Claude Code is the only host
implemented today, and `IRIS_ADAPTER` selects it.

---

## Configuration

The ones worth knowing here; the full table lives in the docs.

| Variable | Default | Effect |
|---|---|---|
| `PROXY_PORT` | `8787` | Bind port. Set explicitly, it is never auto-moved on a conflict |
| `IRIS_HOME` | `~/.iris` | Per-project store: envelopes, decisions, exports |
| `IRIS_AUTOWIRE` | on | Keeps `ANTHROPIC_BASE_URL` pointed at the bound port (`=0` to manage it yourself) |
| `PROXY_REDACT` | on | Scrub secrets before anything is written to disk |
| `PROXY_REDACT_WIRE` | off | Also redact outbound, rehydrating the streamed response |
| `IRIS_UI_TOKEN` | unset | Require `X-Iris-Token` on mutating UI routes |

Captured data lands in `.claude/proxy-logs/`, `.claude/history-index.json` and
`.claude/action-log.json` inside the project, and in `~/.iris/projects/<id>/` for envelopes and
decisions. `init` adds all four to `.gitignore`.

---

## Documentation

Full guides, security notes and the research behind the numbers:

| | |
|---|---|
| [Quickstart](https://hammadabbasi.com/iris/docs/quickstart) | Five minutes, first session to first trim |
| [Context](https://hammadabbasi.com/iris/docs/context) | What Iris measures, and what it does not |
| [Optimize](https://hammadabbasi.com/iris/docs/optimize) | Staging, publishing, and what not to disable |
| [Guard](https://hammadabbasi.com/iris/docs/guard) | The envelope, the ladder, known limitations |
| [Security](https://hammadabbasi.com/iris/docs/security) | Threat model, redaction, what is stored where |
| [Troubleshooting](https://hammadabbasi.com/iris/docs/troubleshooting) | Ports, hooks, recovering a disabled tool |
| [The Token Tax](https://hammadabbasi.com/iris/token-tax) | How the 28.0k → 5.6k measurement was taken |

---

## Contributing

Issues and pull requests are welcome — [open an issue](https://github.com/csehammad/iris-control-plane/issues)
for bugs and proposals. Guard recognizers and adapters for other agent hosts are the two areas
where contributions have the most leverage. Run `npm test` before opening a PR; new Guard
behaviour needs a case in `tests/guard.test.mjs`.

Notes on the numbers: dollars are list rates for known models, an unknown model stays unpriced
rather than printed as `$0.00`, and token counts are calibrated estimates — close, not exact.
Claude Console is the invoice.

## License

MIT. Iris is an independent open-source project, not affiliated with or endorsed by Anthropic.
