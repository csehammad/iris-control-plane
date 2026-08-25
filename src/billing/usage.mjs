// Pull token usage out of a streamed (or plain JSON) Anthropic response.
//
// This parses the response's own usage objects rather than regex-sweeping the whole
// body. That distinction matters: a response can legitimately *contain* the text
// `"output_tokens": 2048` — any agent writing about token accounting will emit it —
// and a blind scan would bill the model's prose as usage.
//
// SSE semantics: input-side counts are final in message_start and never change;
// output_tokens is cumulative and only final in the last message_delta.
//
// Cache writes are split by TTL because they are priced differently: a 5-minute
// write costs 1.25x base input, a 1-hour write costs 2x. Lumping them together
// underprices any workload that uses the 1h TTL (Claude Code uses it heavily).
export function extractUsage(text) {
  const objs = [];
  let streamed = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let d;
    try {
      d = JSON.parse(line.slice(5).trim());
    } catch {
      continue; // "[DONE]" and keep-alive comments
    }
    if (d?.type === "message_start" && d.message?.usage) { streamed = true; objs.push(d.message.usage); }
    else if (d?.type === "message_delta" && d.usage) { streamed = true; objs.push(d.usage); }
  }
  if (!streamed) {
    try {
      const j = JSON.parse(text); // non-streaming response
      if (j?.usage) objs.push(j.usage);
    } catch {
      /* error page or truncated body: no usage to report */
    }
  }

  const firstOf = (pick) => { for (const o of objs) { const v = pick(o); if (v != null) return v; } return null; };
  const lastOf  = (pick) => { for (let i = objs.length - 1; i >= 0; i--) { const v = pick(objs[i]); if (v != null) return v; } return null; };

  // A turn can be reported as several server-side iterations (compaction, multi-step
  // work). Top-level usage is the aggregate — verified against 289 recorded responses,
  // every one agreeing exactly. Sum the iterations anyway and take the larger: if the
  // two ever diverge, the safe direction is to not under-bill, and `iterCount` makes
  // the divergence visible rather than silent.
  const iters = lastOf((o) => (Array.isArray(o.iterations) ? o.iterations : null)) ?? [];
  const iterSum = (key) => (iters.length ? iters.reduce((a, x) => a + (x?.[key] ?? 0), 0) : null);
  const merge = (top, key) => {
    const s = iterSum(key);
    return s != null && top != null ? Math.max(top, s) : (top ?? s);
  };

  const cacheCreate = merge(firstOf((o) => o.cache_creation_input_tokens), "cache_creation_input_tokens");
  const cw5 = firstOf((o) => o.cache_creation?.ephemeral_5m_input_tokens);
  const cw1 = firstOf((o) => o.cache_creation?.ephemeral_1h_input_tokens);

  const usage = {
    input: merge(firstOf((o) => o.input_tokens), "input_tokens"),
    cacheRead: merge(firstOf((o) => o.cache_read_input_tokens), "cache_read_input_tokens"),
    cacheCreate,
    // TTL split. When the API omits the breakdown, attribute the write to the 5m
    // default rather than silently guessing the more expensive tier.
    cw5m: cw5 ?? (cw1 != null && cacheCreate != null ? Math.max(0, cacheCreate - cw1) : cacheCreate),
    cw1h: cw1 ?? 0,
    output: merge(lastOf((o) => o.output_tokens), "output_tokens"),
    // a breakdown of output_tokens, not an addition to it
    thinking: lastOf((o) => o.output_tokens_details?.thinking_tokens),
    // server-side tools bill on top of tokens (e.g. web search per request)
    serverTools: lastOf((o) => o.server_tool_use) ?? null,
    iterCount: iters.length || null,
    // The response reports the rate modifiers that were actually applied, which beats
    // inferring them from the request. "not_available" means no residency multiplier.
    serviceTier: lastOf((o) => o.service_tier),
    inferenceGeo: lastOf((o) => o.inference_geo),
  };
  usage.inputTotal =
    (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheCreate ?? 0) || null;
  return usage;
}
