/**
 * Upstream Anthropic proxy — observation mode is byte-identical unless wire redaction is on.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrub, REDACT_ON } from "../security/redact.mjs";
import { WIRE_REDACT, vault, wireStats, scrubDeep, makeSseRewriter } from "../security/vault.mjs";
import { extractUsage } from "../billing/usage.mjs";
import { historyRecord } from "../billing/history.mjs";
import { rankTools, estTokens } from "../context/schemas.mjs";
import { systemOf, reconcile } from "../context/counter.mjs";
import { buildPreview, printTable } from "../context/analyzer.mjs";
import { stamp } from "./sessions.mjs";

const BODY_MAX = 200_000;
const fmt = (n) => n.toLocaleString("en-US");

function capBody(text) {
  if (text == null) return null;
  text = scrub(text);
  if (text.length <= BODY_MAX) return text;
  return (
    text.slice(0, BODY_MAX) +
    `\n\n… [truncated ${fmt(text.length - BODY_MAX)} more chars — see full file in proxy-logs/]`
  );
}

/**
 * Handle a proxied client request after local Iris routes have been ruled out.
 */
export async function handleProxyRequest(clientReq, clientRes, ctx) {
  const {
    upstream,
    logDir,
    events,
    toolDocs,
    historyLedger,
    actionLedger,
    counter,
    tokenCounter,
    plan,
  } = ctx;

  const chunks = [];
  clientReq.on("data", (c) => chunks.push(c));
  clientReq.on("end", async () => {
    const id = String(++counter.value).padStart(4, "0");
    const rawBody = Buffer.concat(chunks);
    const target = upstream + clientReq.url;

    let parsed = null;
    if (rawBody.length) {
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        /* non-JSON */
      }
    }

    /* Classify the credential before anything is logged or forwarded. Header shape
       only — the token itself never leaves this call. */
    if (plan) plan.observe(clientReq.headers);

    const uid = `${stamp()}_${id}_${clientReq.method}`;
    const logBase = join(logDir, uid);
    try {
      writeFileSync(
        `${logBase}.req.json`,
        JSON.stringify(
          {
            id,
            time: new Date().toISOString(),
            method: clientReq.method,
            url: clientReq.url,
            headers: clientReq.headers,
            body: parsed ?? rawBody.toString("utf8"),
          },
          null,
          2
        )
          .split("\n")
          .map((line) => scrub(line))
          .join("\n")
      );
    } catch (e) {
      console.error("  ! failed to write request log:", e.message);
    }

    const isMessages = clientReq.method === "POST" && clientReq.url.includes("/v1/messages");
    if (isMessages) {
      printTable(id, clientReq.url, parsed);
      toolDocs.captureToolDocs(parsed);
    }

    const ranked = isMessages ? rankTools(parsed) : null;
    let sysText = "";
    if (typeof parsed?.system === "string") sysText = parsed.system;
    else if (Array.isArray(parsed?.system)) sysText = parsed.system.map((s) => s?.text ?? "").join("\n");
    const systemTokens = estTokens(sysText);
    const msgTokens = Array.isArray(parsed?.messages) ? estTokens(JSON.stringify(parsed.messages)) : 0;
    const preview = isMessages ? buildPreview(parsed) : null;
    const startedAt = Date.now();
    if (preview?.trace?.length) actionLedger.recordActions(preview.trace, new Date(startedAt).toISOString());

    // Keep last request body for Context Diff API
    if (isMessages && parsed) {
      ctx.lastBodies.push(parsed);
      if (ctx.lastBodies.length > 8) ctx.lastBodies.shift();
    }

    events.record({
      kind: "request",
      id,
      uid,
      time: new Date().toISOString(),
      method: clientReq.method,
      url: clientReq.url,
      model: parsed?.model ?? null,
      billing: {
        speed: parsed?.speed ?? null,
        inferenceGeo: parsed?.inference_geo ?? null,
        batch: String(clientReq.url).includes("/batches"),
      },
      msgCount: Array.isArray(parsed?.messages) ? parsed.messages.length : null,
      toolTotal: ranked?.total ?? null,
      tools: ranked ? ranked.rows.slice(0, 12) : [],
      toolCount: ranked ? ranked.rows.length : 0,
      systemTokens,
      msgTokens,
      preview,
      reqBody: capBody(parsed != null ? JSON.stringify(parsed, null, 2) : rawBody.toString("utf8")),
    });

    const fwdHeaders = { ...clientReq.headers };
    delete fwdHeaders.host;
    delete fwdHeaders["content-length"];
    delete fwdHeaders["accept-encoding"];

    let outBody = rawBody.length ? rawBody : undefined;
    let wireRedacted = 0;
    if (WIRE_REDACT && isMessages && parsed) {
      try {
        const before = vault.size;
        outBody = Buffer.from(JSON.stringify(scrubDeep(parsed)), "utf8");
        wireRedacted = vault.size - before;
      } catch (e) {
        console.error(`  ! wire redaction failed for #${id}, forwarding verbatim:`, e.message);
        outBody = rawBody;
      }
    }

    try {
      const upstreamRes = await fetch(target, {
        method: clientReq.method,
        headers: fwdHeaders,
        body: outBody,
      });

      const resHeaders = {};
      upstreamRes.headers.forEach((v, k) => {
        if (k === "content-encoding" || k === "content-length" || k === "transfer-encoding") return;
        resHeaders[k] = v;
      });
      clientRes.writeHead(upstreamRes.status, resHeaders);

      const captured = [];
      const rewriter = WIRE_REDACT && isMessages ? makeSseRewriter() : null;
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          captured.push(buf);
          clientRes.write(rewriter ? Buffer.from(rewriter.push(buf.toString("utf8")), "utf8") : buf);
        }
      }
      if (rewriter) {
        const tail = rewriter.end();
        if (tail) clientRes.write(Buffer.from(tail, "utf8"));
      }
      clientRes.end();
      if (wireRedacted || wireStats.restored) {
        console.log(
          `     [wire] ${wireRedacted} redacted outbound · ${wireStats.restored} restored inbound · vault ${vault.size}`
        );
      }

      const responseText = Buffer.concat(captured).toString("utf8");
      try {
        writeFileSync(`${logBase}.res.txt`, scrub(responseText));
      } catch {
        /* best-effort */
      }
      console.log(`     -> ${upstreamRes.status}  (logged ${uid}.*)`);
      const usage = extractUsage(responseText);
      const ms = Date.now() - startedAt;

      if (isMessages && !clientReq.url.includes("count_tokens")) {
        const rec = historyRecord({
          uid,
          id,
          time: new Date(startedAt).toISOString(),
          url: clientReq.url,
          body: parsed,
          usage,
          status: upstreamRes.status,
          ms,
        });

        /* Exact prefix counts, reconciled against the chars/4 estimate on the same
           record. This runs after clientRes.end() above, so it costs Claude Code
           nothing, and a warm prefix is a cache hit rather than a request. Counting
           never throws: countPrefix returns null and the record keeps its estimate. */
        if (tokenCounter && usage?.inputTotal) {
          const counted = await tokenCounter.countPrefix({
            headers: fwdHeaders,
            model: parsed?.model,
            system: systemOf(parsed),
            tools: parsed?.tools,
            toolChoice: parsed?.tool_choice,
          });
          const audit = reconcile(counted, rec, usage.inputTotal);
          if (audit) {
            rec.audit = audit;
            if (counted) {
              rec.counted = { sys: counted.sys, tools: counted.tools, base: counted.base };
              const d = audit.delta;
              console.log(
                `     [count] prefix ${fmt(audit.counted.sys + audit.counted.tools)} exact vs ` +
                  `${fmt(audit.calibrated.sys + audit.calibrated.tools)} estimated ` +
                  `(${d.prefixPct >= 0 ? "+" : ""}${d.prefixPct.toFixed(1)}%) · ` +
                  `sys ${fmt(audit.counted.sys)} · tools ${fmt(audit.counted.tools)} · ` +
                  `cal x${audit.factor.toFixed(3)}${counted.fromCache ? " · cached" : ` · ${counted.ms}ms`}`
              );
            }
          }
        }
        historyLedger.addHistory(rec);
        try {
          writeFileSync(`${logBase}.meta.json`, JSON.stringify(rec));
        } catch {
          /* best effort */
        }
        if (historyLedger.records.length % 20 === 0) historyLedger.save();
      }

      events.record({
        kind: "response",
        id,
        uid,
        status: upstreamRes.status,
        ms,
        inputTokens: usage.input,
        cacheRead: usage.cacheRead,
        cacheCreate: usage.cacheCreate,
        cacheWrite5m: usage.cw5m,
        cacheWrite1h: usage.cw1h,
        inputTotal: usage.inputTotal,
        outputTokens: usage.output,
        thinkingTokens: usage.thinking,
        serverTools: usage.serverTools,
        iterCount: usage.iterCount,
        serviceTier: usage.serviceTier,
        inferenceGeo: usage.inferenceGeo,
        resBody: capBody(responseText),
      });
    } catch (err) {
      console.error(`  ! upstream error for #${id}:`, err.message);
      /* This catch also covers post-flight work that runs after the response was
         fully written. Writing to an ended response throws ERR_STREAM_WRITE_AFTER_END
         from an event handler, which is unhandled and kills the process — so the
         client only hears about failures it has not already been answered for. */
      if (!clientRes.writableEnded) {
        if (!clientRes.headersSent) clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ error: { type: "proxy_error", message: err.message } }));
      }
      events.record({ kind: "response", id, uid, status: 502, ms: Date.now() - startedAt, error: err.message });
    }
  });

  // silence unused
  void REDACT_ON;
}
