# Changelog

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
