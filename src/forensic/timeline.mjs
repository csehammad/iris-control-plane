/**
 * Flight Recorder timeline — merge actions, requests, and (optional) guard decisions
 * into a single sorted event stream.
 */

function asTime(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  const s = String(v);
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : s;
}

function userTextFromRequest(req) {
  const body = req?.body ?? req;
  const messages = body?.messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 240);
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === "text" && b.text) return String(b.text).trim().slice(0, 240);
      }
    }
  }
  return null;
}

/**
 * @param {{
 *   actions?: Array<{t?:string,time?:string,tool?:string,desc?:string,arg?:string,i?:number,k?:string}>,
 *   requests?: Array<{time?:string,t?:string,uid?:string,id?:string,model?:string,body?:any,estSys?:number,estTools?:number,estMsg?:number}>,
 *   decisions?: Array<{time?:string,t?:string,decision?:string,verdict?:string,tool?:string,reason?:string,requestId?:string}>,
 * }} input
 * @returns {Array<{type:'user'|'tool'|'decision'|'request', time:string, [key:string]:any}>}
 */
export function buildTimeline({ actions = [], requests = [], decisions = [] } = {}) {
  /** @type {Array<{type:string,time:string,[k:string]:any}>} */
  const events = [];

  for (const r of requests ?? []) {
    const time = asTime(r.time ?? r.t) ?? new Date(0).toISOString();
    events.push({
      type: "request",
      time,
      uid: r.uid ?? null,
      id: r.id ?? null,
      model: r.model ?? r.body?.model ?? null,
      estSys: r.estSys ?? null,
      estTools: r.estTools ?? null,
      estMsg: r.estMsg ?? null,
    });
    const userText = userTextFromRequest(r);
    if (userText) {
      events.push({
        type: "user",
        time,
        uid: r.uid ?? null,
        text: userText,
      });
    }
  }

  for (const a of actions ?? []) {
    const time = asTime(a.t ?? a.time) ?? new Date(0).toISOString();
    events.push({
      type: "tool",
      time,
      i: a.i ?? null,
      tool: a.tool ?? "(unnamed)",
      desc: a.desc || "",
      arg: a.arg || "",
      k: a.k ?? null,
    });
  }

  for (const d of decisions ?? []) {
    const time = asTime(d.time ?? d.t) ?? new Date(0).toISOString();
    events.push({
      type: "decision",
      time,
      verdict: d.verdict ?? d.decision ?? "ASK",
      tool: d.tool ?? null,
      reason: d.reason ?? "",
      requestId: d.requestId ?? null,
    });
  }

  events.sort((a, b) => {
    if (a.time < b.time) return -1;
    if (a.time > b.time) return 1;
    const rank = { user: 0, request: 1, decision: 2, tool: 3 };
    return (rank[a.type] ?? 9) - (rank[b.type] ?? 9);
  });

  return events;
}
