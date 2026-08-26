# Changelog

## Unreleased

Step one of replacing `chars/4` token estimation. The counted split is measured and
reconciled against the existing estimate, but **nothing has been cut over yet** — the
UI and Optimize still render the `chars/4` figures. This release is for comparing the
two on real traffic before switching.

### Added

- **Billing-mode awareness.** Every dollar figure Iris printed assumed the reader was
  billed per token. On a Pro/Max seat nobody is, so a real measurement read as an
  invented one; on Bedrock/Vertex/Foundry it was priced off a rate card that does not
  apply at all. Iris now classifies the metering regime from the credential shape on
  the wire — [plan.mjs](src/billing/plan.mjs) — and labels every figure accordingly:
  `x-api-key` is a Console key (dollars are the bill), `Authorization: Bearer` is a
  subscription seat (dollars become a bracketed API-rate projection and the headline
  becomes share of metered usage), and a partner upstream withholds dollar figures
  rather than guessing them. Header **shape** only: no token, and no fragment of one,
  is read, stored or exposed — asserted in [plan.test.mjs](tests/plan.test.mjs) and
  again over the live `/__meta` response.
- A billing-mode control in the header. Detection cannot see whether a seat is still
  inside its allowance or already drawing **usage credits**, because nothing on the
  wire says so — so that stays a user choice, and picking it switches the assumed
  cache lifetime from an hour to five minutes across Spend and Optimize.
- A help sheet on the header's `?` (or the `?` key) explaining how Claude Code meters
  usage across all four regimes, how Iris works out which one you are on, why a seat
  still gets a dollar figure, what every input to the projection is measured from, and
  — explicitly — what Iris cannot tell you, including that it has no access to your
  remaining allowance and `/usage` is the only source for that.
- `GET /__plan.mjs` serves the mode table to the dashboard verbatim, the same rule the
  price book already follows, so the classifier and the labels cannot drift apart.
- [ui-plan.test.mjs](tests/ui-plan.test.mjs) renders every dashboard view in all four
  modes under a DOM shim and asserts the labels actually differ — that a seat is never
  told its projection is a bill, and a cloud provider is shown no dollar figure at all.
- Exact prefix token counts from `POST /v1/messages/count_tokens`, in
  [counter.mjs](src/context/counter.mjs). The endpoint uses the same tokenizer as
  inference, is free, and sits on a rate-limit pool independent of message creation.
  The system prompt and tool schemas are counted once per `(model, content)` hash and
  cached; the conversation is never counted, deriving instead by subtraction from the
  input total the response already reported. A warm session makes **no** counting calls.
  Counting runs after the response is fully written to the client, so it cannot add
  latency, and a failure degrades to "no counted split" rather than propagating.
- `GET /__token-audit` reports, per call and in aggregate, the counted split against
  the calibrated `chars/4` split, the factor used, and the signed error of each bucket.
  The prefix delta is called out separately because that is the figure Optimize sells
  decisions on.
- `IRIS_COUNT_TOKENS=0` disables counting entirely.

### Removed

- The classic UI (`ui/classic.html`, `/__classic`) is gone. It consumed a strict
  subset of the main dashboard's endpoints — `/__config`, `/__events`, `/__pricing`
  and nothing else — and no part of the product linked to it, so the only way to
  reach it was one sentence in the docs. That invisibility had a cost: it spent an
  unknown stretch pricing every Opus generation at retired Opus 4.1 rates, three
  times the real price, because nobody opens a page nobody can find. Its role as a
  fallback for an unreadable `iris.html` was illusory — both files shipped in the
  same directory of the same tarball. `/__monitor` now reports which file it could
  not read instead of quietly serving a lesser page.
- Unknown `/__` paths return 404 rather than being forwarded to Anthropic. A retired
  route or a typo previously went upstream and came back as a puzzling API error; a
  stale `/__classic` bookmark now gets a plain "no such Iris route".

### Fixed

- Spend and Optimize stated the prompt-cache lifetime as "an hour on a subscription,
  five minutes on an API key". Both are true, but the lifetime also drops to five
  minutes the moment a subscription starts drawing usage credits, and the copy never
  said which one applied to the reader. Both pages now name the lifetime for the mode
  in effect.
- The context-diff and tool-result panels shipped raw `chars/4` with no calibration at
  all, reading roughly 35% low on Claude 4.7+ tokenizers. Both now apply the session
  factor and report `calUsed` alongside the numbers, so a corrected estimate is not
  mistaken for a measurement.
- [calibration.mjs](src/context/calibration.mjs) was imported by nothing but its own
  test while the real logic sat inlined in `iris.html` — the same dead-module pattern
  the price book had. It is now the module both panels use, and it gained
  `sessionFactor()` (median of measured/estimated over the recent window, so one
  oddly-shaped call cannot drag a panel) plus coverage of the array and aggregate
  shapes those panels actually carry.
- A throw anywhere in the proxy's post-flight work reached `clientRes.end()` a second
  time and killed the process with an unhandled `ERR_STREAM_WRITE_AFTER_END`. The
  error path now checks `writableEnded` before answering a client that already has
  its response.

## 1.0.3 — 2026-08-26

### Fixed

- Sonnet 5 no longer steps up to $3/$15 on 2026-09-01. The price book carried the launch-announced increase as a dated
  rule, but Anthropic has since cancelled it — "the previously scheduled increase ... on September 1, 2026 will not
  occur" — and $2/$10 is now the standard price. Left alone, every Sonnet 5 figure would have inflated by 50% overnight
  with nothing in the UI to indicate why. The dated-price mechanism remains for a future change; no row uses it.
- The classic UI priced every model from a three-tier table matched by substring, so each Opus generation was billed at
  retired Opus 4.1 rates: Opus 5 showed **$15/$75 against an actual $5/$25, three times too high**. Sonnet and Haiku were
  similarly stale. It now prices from the shared book, and gained two things it never had: cache writes split by TTL
  (5-minute at 1.25x input, 1-hour at 2x — Claude Code leans on the 1-hour TTL) and the US data-residency multiplier.
- `costOf()` in `src/billing/pricing.mjs` ignored every rate modifier, so a fast-mode Opus 5 call was priced at $5/$25
  instead of $10/$50 — **half**. Batch (−50%) and US residency (×1.1) were dropped the same way, and a non-standard
  service tier was silently priced as standard. `rateFor()` and `costOf()` now take the call's `billing` object and
  apply fast mode, batch and residency; an unrecognised service tier is surfaced rather than assumed.

### Changed

- There is one price book. It previously existed in three copies — the module, inline in the main UI, and the classic
  UI's own table — which is how the cancelled step-up survived in two of them and the classic UI drifted years out of
  date. `src/billing/pricing.mjs` is now the single source; the server serves it verbatim at `/__pricing.mjs` and both
  UIs import it. A test asserts neither UI declares a book of its own.
- Server-side tool fees are priced in the module too (web search at $10 per 1,000; web fetch free; code execution left
  explicitly unpriced, since container-hour billing cannot be derived from a request count).

## 1.0.2 — 2026-08-25

### Fixed

- `init` re-points Guard hooks at the copy of Iris being run. It previously treated "an Iris hook exists" as "nothing
  to do", so a hook left pointing into a pruned `npx` cache — or a moved global install, or a relocated checkout —
  could not be repaired by re-running `init` at all. It now reports `installed`, `path refreshed to this copy of Iris`,
  or `already correct`.
- Hooks belonging to anything other than Iris are preserved, including ones sharing an entry with an Iris hook. A
  redundant second Iris hook is dropped instead of rewritten, so the hook cannot run twice per tool call.
- Startup warns when a configured hook path no longer exists on disk, naming the path and the command that fixes it.
  That failure was previously silent: every tool call would fail the hook with nothing shown anywhere.

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
