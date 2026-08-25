# Changelog

## 1.0.1 — 2026-08-25

### Fixed

- A busy port no longer crashes with an unhandled `EADDRINUSE` stack trace. Iris identifies the occupant: an instance
  already serving this project reports "already running" and exits `0`; anything else moves to the next free port.
- `iris init` writes the port Iris is actually on. It accepts `--port N`, honours `PROXY_PORT`, and otherwise discovers
  a running instance serving this directory — previously it always wrote `8787`.
- `init` re-points a stale `127.0.0.1` `ANTHROPIC_BASE_URL` instead of leaving it. Previously it only wrote the value
  when absent, so a project stuck on an old port silently sent its traffic to another project's instance, where it was
  recorded under that project and evaluated against that project's envelope and project root. A non-loopback base URL
  is reported and left untouched.
- Startup now **re-points** `.claude/settings.json` when it aims at a different port than the one bound, instead of
  only warning. Guarded: loopback URLs only, only in a project that already has the Iris hook installed, and never when
  `IRIS_AUTOWIRE=0`. Claude Code reads settings at session start, so restart it to pick the change up.
- Flight Recorder no longer renders every action twice. The same action arrives over SSE and again from `/__actions`;
  the dashboard trusted the server's hashed key for one source and derived a sliced key for the other, so the two never
  collided. The dashboard now derives one key for both.

### Removed

- `IRIS_RETENTION_DAYS`. It was read and reported in `/__meta` but nothing ever consumed it — no pruning existed. Dead
  configuration is worse than none, because it reads like a guarantee.

### Changed

- An explicitly requested port (`--port` / `PROXY_PORT`) is never auto-moved — it fails with guidance instead, because
  `settings.json` already points Claude Code at a fixed URL.
- `/__meta` and the startup banner report the port actually bound.

## 1.0.0 — 2026-08-23

### Fixed

- Guard hook, init, and the server now share one envelope path: `~/.iris/projects/<id>/sessions/authority.json`. A leftover `projects/<id>/authority.json` is copied once.
- `iris init` installs `node "<pkg>/bin/iris.mjs" hook` and sets `IRIS_ENVELOPE_PATH` / `IRIS_HOME` in `.claude/settings.json`.
- Mutating UI routes require `X-Iris-Token` when `IRIS_UI_TOKEN` is set (`/__config`, `/__authority`, `/__export`, `/__guard/evaluate`, `/__correlate`). Query-string tokens are rejected.
- Invalid JSON bodies return 400. UI JSON bodies over 2 MB return 413.
- Dashboard toasts escape error text. Google Fonts CDN removed so the UI works offline.

### Changed

- Published to npm as `@zero-drift/iris`; the CLI binary is `iris` (`npx @zero-drift/iris`).
- In-package HTML guide at `ui/guide.html`, served at `/__guide`.
- Emails are redacted in logs by default (`PROXY_REDACT_EMAILS=0` to keep them).
- `/__meta` reports `version` from `package.json` and `authRequired`.
- Credential checks go through `authorizeCredential` (production stays hard-denied).
- Sonnet 5 introductory list prices step up after 2026-08-31 (see `src/billing/pricing.mjs`).
