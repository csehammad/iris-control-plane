# Iris for Claude Code

**See what Claude carries. Kill what you don't need. Control what it can do.**

Local observability and guardrail layer for [Claude Code](https://code.claude.com). Package name: **@zero-drift/iris**. Requires Node 18+.

Claude Code sends model traffic to Iris on `127.0.0.1`. Iris forwards it to Anthropic, shows what was in the request, and can Allow / Ask / Deny tools via PreToolUse.

```text
Claude Code  →  Iris  →  Anthropic
                  │
                  ├── Inspect context
                  ├── Remove unused tool schemas
                  ├── Apply Guard rules
                  └── Record what ran
```

```bash
npx @zero-drift/iris
# other terminal, in the repo that has .claude/:
npx @zero-drift/iris init
```

Leave the first process running. Open http://127.0.0.1:8787 (`/__monitor`). Guide: http://127.0.0.1:8787/__guide

`init` writes `.claude/settings.json` — `ANTHROPIC_BASE_URL`, `IRIS_HOME`, `IRIS_ENVELOPE_PATH`, and the PreToolUse **and** PostToolUse hooks — plus `.claude/iris-project.json`, a first authority envelope, and the four capture paths in `.gitignore`. Re-run is safe; it will not wipe `permissions.deny`. Restart Claude Code after init.

From a git checkout: `npm start`.

## Commands

| Command | What it does |
|---|---|
| `iris` | Start proxy + UI (`start` / `run` are aliases) |
| `iris init` | Configure this project for Claude Code |
| `iris hook` | Pre/PostToolUse hook body — Claude Code invokes this, not you |
| `iris version` | Print version |
| `iris help` | Usage |

## Dashboard

Keys `1`–`7`: Overview, Spend, Traffic, Context, Optimize, Guard, Flight Recorder. `⌘K` / `Ctrl-K` opens the command palette; in the call drawer `j` / `k` step through calls and `Esc` closes it. Header time range filters most views.

**Publish changes** writes bare names to `permissions.deny`. **Accept envelope** writes Guard policy. Export writes history, actions, or decisions as JSON or CSV into `~/.iris/projects/<id>/exports/`. Reset clears captured data (`POST /__reset` needs `{"confirm":"clear"}`). `/__classic` is a lighter UI over the same data; `/__health` and `/__meta` report status.

## Configure

| Variable | Default | What it does |
|---|---|---|
| `PROXY_PORT` | `8787` | Bind `127.0.0.1` |
| `ANTHROPIC_PROXY_TARGET` | `https://api.anthropic.com` | Upstream |
| `IRIS_HOME` | `~/.iris` | Per-project store |
| `IRIS_ENVELOPE_PATH` | `~/.iris/projects/<id>/sessions/authority.json` | Guard file (hook = UI = server) |
| `IRIS_UI_TOKEN` | unset | Require `X-Iris-Token` on mutating UI routes |
| `IRIS_ADAPTER` | `claude-code` | Host adapter |
| `PROXY_REDACT` | on | Scrub secrets in logs (`=0` off) |
| `PROXY_REDACT_EMAILS` | on | Scrub emails (`=0` keep) |
| `PROXY_REDACT_WIRE` | off | Redact on the wire (`=1` on) |

If `IRIS_UI_TOKEN` is set, open `/__monitor?iris_token=…` once. Query `?token=` on POST URLs is not accepted. The gate covers `POST` on `/__config`, `/__authority`, `/__correlate`, `/__guard/evaluate`, `/__export`, and `/__reset`.

Path overrides used mainly by the test suite: `PROXY_LOG_DIR`, `PROXY_HISTORY_PATH`, `PROXY_ACTIONS_PATH`, `PROXY_SETTINGS_PATH`, `PROXY_IRIS_PATH`, `IRIS_DECISIONS_PATH`, `IRIS_LEDGER_PATH`.

## Where data lands

| Path | Contents |
|---|---|
| `.claude/proxy-logs/` | Captured request / response payloads |
| `.claude/history-index.json` | Call index behind Spend and Traffic |
| `.claude/action-log.json` | Tool action ledger |
| `~/.iris/projects/<id>/sessions/` | `authority.json`, `decisions.json` |
| `~/.iris/projects/<id>/exports/` | Export output |

`init` adds those three `.claude` paths and `.claude/proxy-run.log` to `.gitignore`.

## Tests

```bash
npm test
```

## License

MIT

Iris is an independent open-source project and is not affiliated with or endorsed by Anthropic.
