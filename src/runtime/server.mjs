/**
 * Iris HTTP server — core control plane + host adapter (Claude Code v1).
 *
 * Core owns context, billing, policy, authority, forensics, UI.
 * Host-specific proxy/hooks/permissions come from AgentAdapter — no if (claudeCode) branches.
 */

import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus } from "./events.mjs";
import { createSession } from "./sessions.mjs";
import { resolveRuntimePaths } from "./paths.mjs";
import { createToolDocsStore } from "../context/schemas.mjs";
import { createHistoryLedger } from "../billing/history.mjs";
import { createActionLedger } from "../forensic/actions.mjs";
import { resolveAdapter } from "../adapters/index.mjs";
import { REDACT_ON, REDACT_EMAILS, redactStats } from "../security/redact.mjs";
import { WIRE_REDACT, vault, wireStats } from "../security/vault.mjs";
import { attributeToolResults, rankToolResults, remediationAdvice } from "../context/tool-results.mjs";
import { contextDiff } from "../context/diff.mjs";
import { buildTimeline } from "../forensic/timeline.mjs";
import { exportJson, exportCsv } from "../forensic/export.mjs";
import {
  proposeEnvelope,
  loadEnvelope,
  saveEnvelope,
  acceptEnvelope,
  createEnvelope,
} from "../guard/authority.mjs";
import { createDecisionLedger } from "../guard/decisions.mjs";
import { createTrajectoryTracker } from "../guard/trajectory.mjs";
import { normalizeEffect } from "../guard/effects.mjs";
import { evaluate } from "../guard/policy.mjs";
import { POLICY_SCHEMA_VERSION, validateEnvelope, migrateEnvelope } from "../guard/policy-schema.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const JSON_BODY_MAX = 2_000_000;

function readPkgVersion() {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
  } catch (err) {
    console.error("iris: failed to read package.json version:", err);
    // FALLBACK-GUARD: INTENTIONAL — version is display-only; server must still boot
    return "unknown";
  }
}

const PKG_VERSION = readPkgVersion();

function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    const buf = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > JSON_BODY_MAX) {
        const err = new Error("payload too large");
        err.code = "PAYLOAD_TOO_LARGE";
        reject(err);
        req.destroy();
        return;
      }
      buf.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(buf).toString("utf8");
      if (!raw.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        const e = new Error("invalid json");
        e.code = "INVALID_JSON";
        e.cause = err;
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function readUiJson(req, res) {
  try {
    return await readJsonBody(req);
  } catch (err) {
    if (err && err.code === "PAYLOAD_TOO_LARGE") {
      json(res, 413, { error: "payload too large" });
      return null;
    }
    json(res, 400, { error: "invalid json" });
    return null;
  }
}

function json(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(process.env.IRIS_UI_TOKEN
      ? {}
      : { "access-control-allow-origin": "null" }),
  });
  res.end(JSON.stringify(obj));
}

/**
 * Start Iris on 127.0.0.1.
 * @returns {{ server: http.Server, paths: object, port: number }}
 */
export function startServer(opts = {}) {
  const PORT = Number(opts.port ?? process.env.PROXY_PORT ?? 8787);
  const UPSTREAM = (opts.upstream ?? process.env.ANTHROPIC_PROXY_TARGET ?? "https://api.anthropic.com").replace(
    /\/$/,
    ""
  );
  const uiToken = opts.uiToken ?? process.env.IRIS_UI_TOKEN ?? "";
  const paths = resolveRuntimePaths(opts);

  function checkMutatingAuth(req, res) {
    if (!uiToken) return true;
    const got = req.headers["x-iris-token"];
    if (got === uiToken) return true;
    json(res, 401, { error: "unauthorized" });
    return false;
  }
  const session = createSession();
  const events = createEventBus();
  const toolDocs = createToolDocsStore();
  const historyLedger = createHistoryLedger({ path: paths.historyPath, logDir: paths.logDir });
  const actionLedger = createActionLedger({ path: paths.actionsPath });
  mkdirSync(dirname(paths.decisionsPath), { recursive: true });
  const decisionLedger = createDecisionLedger({ path: paths.decisionsPath });
  const trajectory = createTrajectoryTracker();
  const counter = { value: 0 };
  const lastBodies = [];
  const retentionDays = Number(process.env.IRIS_RETENTION_DAYS || 30);

  const adapter = resolveAdapter(opts.adapter || "claude-code", {
    settingsPath: paths.settingsPath,
    session,
    paths,
    toolDocs,
    port: PORT,
  });

  const origRecord = events.record.bind(events);
  events.record = (event) => {
    if (event?.kind === "request") adapter.observeModelRequest(event);
    if (event?.kind === "response") adapter.observeModelResponse(event);
    return origRecord(event);
  };

  const ctx = {
    upstream: UPSTREAM,
    logDir: paths.logDir,
    events,
    toolDocs,
    historyLedger,
    actionLedger,
    counter,
    lastBodies,
    paths,
  };

  function loadEnvelopeSafe() {
    try {
      return loadEnvelope(paths.envelopePath);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      if (msg.includes("envelope not found")) return null;
      console.error("iris: failed to load authority envelope", paths.envelopePath, err);
      // FALLBACK-GUARD: INTENTIONAL — UI/health stay up; the hook fail-closes on its own path
      return null;
    }
  }

  const server = http.createServer(async (clientReq, clientRes) => {
    const rawUrl = clientReq.url || "/";
    const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
    const url = parsedUrl.pathname;
    const method = clientReq.method || "GET";

    // ---- UI ----
    if (method === "GET" && (url === "/__monitor" || url === "/" || url === "/__iris")) {
      let html;
      try {
        html = readFileSync(paths.irisHtml, "utf8");
      } catch {
        try {
          html = readFileSync(paths.classicHtml, "utf8");
        } catch {
          html = "<h1>Iris UI missing</h1>";
        }
      }
      clientRes.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      clientRes.end(html);
      return;
    }
    if (method === "GET" && (url === "/__guide" || url === "/guide.html")) {
      try {
        const html = readFileSync(paths.guideHtml, "utf8");
        clientRes.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        clientRes.end(html);
      } catch (e) {
        json(clientRes, 404, { error: e.message });
      }
      return;
    }
    if (method === "GET" && url === "/__classic") {
      try {
        const html = readFileSync(paths.classicHtml, "utf8");
        clientRes.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        clientRes.end(html);
      } catch (e) {
        json(clientRes, 404, { error: e.message });
      }
      return;
    }

    if (method === "GET" && url === "/__meta") {
      const env = loadEnvelopeSafe();
      json(clientRes, 200, {
        session: session.id,
        startedAt: session.startedAt,
        port: PORT,
        upstream: UPSTREAM,
        repo: paths.project.name || paths.projectRoot.split("/").filter(Boolean).pop(),
        cwd: paths.projectRoot,
        projectId: paths.projectId,
        settingsPath: paths.settingsPath,
        agent: adapter.label,
        adapter: { id: adapter.id, capabilities: adapter.capabilities },
        version: PKG_VERSION,
        policySchema: POLICY_SCHEMA_VERSION,
        authRequired: !!uiToken,
        guard: {
          active: !!env?.acceptedAt,
          envelopePath: paths.envelopePath,
          task: env?.task || null,
        },
        redaction: {
          on: REDACT_ON,
          emails: REDACT_EMAILS,
          counts: redactStats,
          wire: WIRE_REDACT,
          vault: vault.size,
          wireStats,
        },
        retentionDays,
      });
      return;
    }

    if (method === "GET" && url === "/__history") {
      json(clientRes, 200, {
        records: historyLedger.records,
        builtAt: historyLedger.state.built,
        building: historyLedger.state.building,
        logDir: paths.logDir,
      });
      return;
    }

    if (method === "GET" && url.startsWith("/__actions")) {
      const since = parsedUrl.searchParams.get("since");
      const rows = actionLedger.getActions({ since: since || undefined });
      json(clientRes, 200, { actions: rows, total: actionLedger.actions.length });
      return;
    }

    if (method === "GET" && url === "/__tooldocs") {
      json(clientRes, 200, { tools: toolDocs.list() });
      return;
    }

    if (method === "GET" && url === "/__events") {
      clientRes.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clientRes.write("retry: 2000\n\n");
      events.replay(clientRes);
      const unsub = events.subscribe(clientRes);
      const ping = setInterval(() => {
        try {
          clientRes.write(": ping\n\n");
        } catch {
          /* ignore */
        }
      }, 15000);
      clientReq.on("close", () => {
        clearInterval(ping);
        unsub();
      });
      return;
    }

    if (url === "/__config") {
      if (method === "GET") {
        json(clientRes, 200, {
          deny: adapter.host.readDeny(),
          settingsPath: paths.settingsPath,
          adapter: adapter.id,
          // Bare deny removes schemas from context; scoped deny does not.
          denySemantics: {
            bare: "removes tool from model context",
            scoped: "may leave tool visible; blocks particular executions",
          },
        });
        return;
      }
      if (method === "POST") {
        if (!checkMutatingAuth(clientReq, clientRes)) return;
        const body = await readUiJson(clientReq, clientRes);
        if (body == null) return;
        const result = body.denied ? adapter.disableTool(body.tool) : adapter.enableTool(body.tool);
        if (result.ok) events.broadcast({ kind: "config", deny: result.deny });
        json(clientRes, result.ok ? 200 : 400, result.ok ? { deny: result.deny } : { error: result.error });
        return;
      }
    }

    // ---- 0.2 Context Diff / tool_result attribution ----
    if (method === "GET" && url.startsWith("/__context-diff")) {
      const n = lastBodies.length;
      if (n < 2) {
        json(clientRes, 200, { ok: false, error: "need at least two captured requests", diff: null });
        return;
      }
      const diff = contextDiff(lastBodies[n - 2], lastBodies[n - 1]);
      json(clientRes, 200, { ok: true, diff });
      return;
    }

    if (method === "GET" && url.startsWith("/__tool-results")) {
      const body = lastBodies[lastBodies.length - 1];
      const attrs = attributeToolResults(body?.messages || []);
      const ranked = rankToolResults(attrs).map((a) => ({
        ...a,
        advice: remediationAdvice(a),
      }));
      json(clientRes, 200, { results: ranked, totalTokens: ranked.reduce((s, r) => s + (r.tokens || 0), 0) });
      return;
    }

    // ---- Flight Recorder timeline ----
    if (method === "GET" && url.startsWith("/__timeline")) {
      const decisions = decisionLedger.list ? decisionLedger.list() : decisionLedger.decisions || [];
      const requests = events.history.filter((e) => e.kind === "request" || e.kind === "response");
      const timeline = buildTimeline({
        actions: actionLedger.actions,
        requests,
        decisions,
      });
      json(clientRes, 200, { timeline, signals: trajectory.signals() });
      return;
    }

    if (method === "POST" && url === "/__correlate") {
      if (!checkMutatingAuth(clientReq, clientRes)) return;
      const body = await readUiJson(clientReq, clientRes);
      if (body == null) return;
      json(clientRes, 200, { record: adapter.host.joinOtel(body) });
      return;
    }

    if (method === "GET" && url === "/__adapter") {
      json(clientRes, 200, {
        id: adapter.id,
        label: adapter.label,
        capabilities: adapter.capabilities,
        session: adapter.getSessionMetadata(),
      });
      return;
    }

    // ---- Guard / Authority ----
    if (url.startsWith("/__authority")) {
      if (method === "GET") {
        const env = loadEnvelopeSafe();
        const proposal = proposeEnvelope({
          task: env?.task || "",
          projectRoot: paths.projectRoot,
          projectName: paths.project.name,
        });
        json(clientRes, 200, {
          envelope: env,
          proposal: env ? null : proposal,
          path: paths.envelopePath,
          signals: trajectory.signals(),
        });
        return;
      }
      if (method === "POST") {
        if (!checkMutatingAuth(clientReq, clientRes)) return;
        const body = await readUiJson(clientReq, clientRes);
        if (body == null) return;
        if (body.action === "propose") {
          const proposal = proposeEnvelope({
            task: body.task || "",
            projectRoot: paths.projectRoot,
            projectName: paths.project.name,
          });
          json(clientRes, 200, proposal);
          return;
        }
        if (body.action === "accept") {
          let env =
            body.envelope ||
            createEnvelope({
              task: body.task || "",
              projectRoot: paths.projectRoot,
              projectName: paths.project.name,
            });
          if (body.task) env.task = String(body.task);
          env.projectRoot = env.projectRoot || paths.projectRoot;
          env = acceptEnvelope(env);
          const { ok, errors } = validateEnvelope(migrateEnvelope(env));
          if (!ok) {
            json(clientRes, 400, { error: errors.join("; ") });
            return;
          }
          saveEnvelope(paths.envelopePath, env);
          events.broadcast({ kind: "authority", envelope: env });
          json(clientRes, 200, { ok: true, envelope: env });
          return;
        }
        if (body.action === "clear") {
          try {
            writeFileSync(paths.envelopePath, JSON.stringify(createEnvelope({ projectRoot: paths.projectRoot }), null, 2));
          } catch (err) {
            console.error("iris: failed to clear authority envelope", paths.envelopePath, err);
            json(clientRes, 500, { error: "failed to clear envelope" });
            return;
          }
          json(clientRes, 200, { ok: true });
          return;
        }
        json(clientRes, 400, { error: "unknown action" });
        return;
      }
    }

    if (method === "GET" && url.startsWith("/__decisions")) {
      const list = typeof decisionLedger.list === "function" ? decisionLedger.list() : decisionLedger.decisions || [];
      json(clientRes, 200, { decisions: list });
      return;
    }

    if (method === "POST" && url === "/__guard/evaluate") {
      if (!checkMutatingAuth(clientReq, clientRes)) return;
      const body = await readUiJson(clientReq, clientRes);
      if (body == null) return;
      const envelope = loadEnvelopeSafe();
      const effect = normalizeEffect({
        toolName: body.toolName || body.tool,
        input: body.input || {},
        projectRoot: paths.projectRoot,
      });
      const decision = evaluate({
        effect,
        envelope,
        toolName: body.toolName || body.tool,
        input: body.input || {},
        projectRoot: paths.projectRoot,
      });
      trajectory.observe({ effect, decision: decision.decision, failure: !!body.failure });
      if (typeof decisionLedger.append === "function") {
        decisionLedger.append({
          t: new Date().toISOString(),
          tool: body.toolName || body.tool,
          decision: decision.decision,
          reason: decision.reason,
          effect,
          sessionId: session.id,
        });
      }
      events.broadcast({ kind: "guard", ...decision, effect });
      json(clientRes, 200, { ...decision, effect, signals: trajectory.signals() });
      return;
    }

    // ---- Export ----
    if (method === "POST" && url === "/__export") {
      if (!checkMutatingAuth(clientReq, clientRes)) return;
      const body = await readUiJson(clientReq, clientRes);
      if (body == null) return;
      const kind = body.kind || "history";
      const format = body.format || "json";
      const records =
        kind === "actions"
          ? actionLedger.actions
          : kind === "decisions"
            ? typeof decisionLedger.list === "function"
              ? decisionLedger.list()
              : []
            : historyLedger.records;
      mkdirSync(paths.irisPaths.exports, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outPath = join(paths.irisPaths.exports, `${kind}-${stamp}.${format === "csv" ? "csv" : "json"}`);
      if (format === "csv") exportCsv(records, outPath);
      else exportJson(records, outPath);
      json(clientRes, 200, { ok: true, path: outPath, count: records.length });
      return;
    }

    // ---- Reset: clear captured data and start fresh ----
    if (method === "POST" && url === "/__reset") {
      if (!checkMutatingAuth(clientReq, clientRes)) return;
      const body = await readUiJson(clientReq, clientRes);
      if (body == null) return;

      // Deliberately explicit: a stray POST should not wipe a capture.
      if (body.confirm !== "clear") {
        json(clientRes, 400, { error: 'send {"confirm":"clear"} to reset' });
        return;
      }

      // Only ever remove files this proxy wrote. PROXY_LOG_DIR can point
      // anywhere, so match the exact capture filename shape and leave the rest.
      const CAPTURE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_\d+_[A-Z]+\.(meta\.json|req\.json|res\.txt)$/;
      let files = 0;
      const failed = [];
      try {
        for (const f of readdirSync(paths.logDir)) {
          if (!CAPTURE.test(f)) continue;
          try {
            unlinkSync(join(paths.logDir, f));
            files++;
          } catch (e) {
            failed.push(`${f}: ${e.message}`);
          }
        }
      } catch (e) {
        json(clientRes, 500, { error: `could not read log dir: ${e.message}` });
        return;
      }

      const calls = historyLedger.clear();
      const actions = actionLedger.clear();

      // Guard decisions are a log too. The authority envelope is policy, not a
      // log, so it survives a reset.
      let decisions = 0;
      if (body.decisions !== false && typeof decisionLedger.clear === "function") {
        try {
          decisions = decisionLedger.clear() || 0;
        } catch { /* best effort */ }
      }

      lastBodies.length = 0;
      events.broadcast({ kind: "reset", files, calls, actions, decisions });
      console.log(`Reset: cleared ${files} capture files, ${calls} calls, ${actions} actions`);
      json(clientRes, 200, { ok: true, files, calls, actions, decisions, failed });
      return;
    }

    if (method === "GET" && url === "/__health") {
      json(clientRes, 200, {
        ok: true,
        session: session.id,
        bind: "127.0.0.1",
        guard: !!loadEnvelopeSafe()?.acceptedAt,
        authRequired: !!uiToken,
      });
      return;
    }

    // Host adapter owns the model proxy (Claude Code → Anthropic).
    adapter.host.handleProxyRequest(clientReq, clientRes, ctx);
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log("");
    console.log("Iris for Claude Code");
    console.log(`  Project       ${paths.project.name} (${paths.projectId})`);
    console.log(`  Adapter       ${adapter.label}`);
    console.log(`  Proxy         http://127.0.0.1:${PORT}`);
    console.log(`  Upstream      ${UPSTREAM}`);
    console.log(`  Guard         ${existsSync(paths.envelopePath) ? "configured" : "inactive (accept envelope in UI)"}`);
    console.log(`  Redaction     ${REDACT_ON ? "at-rest" : "off"}${WIRE_REDACT ? " + wire" : ""}`);
    console.log(`  UI            http://127.0.0.1:${PORT}/__monitor`);
    console.log(`  Guide         http://127.0.0.1:${PORT}/__guide`);
    console.log("  Point ANTHROPIC_BASE_URL here — Claude Code is protected.\n");

    historyLedger.load();
    actionLedger.load();
    decisionLedger.reload();
    historyLedger.build().then(() => {
      if (!actionLedger.backfilled) return actionLedger.backfillActions(paths.logDir);
      console.log(`Action ledger: ${actionLedger.actions.length} recorded actions`);
    });
  });

  if (opts.handleSignals !== false) {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        historyLedger.save();
        actionLedger.save();
        decisionLedger.save();
        process.exit(0);
      });
    }
  }

  return { server, paths, port: PORT, events, session };
}
