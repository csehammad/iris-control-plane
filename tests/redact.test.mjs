import { scrub, tag } from "../src/security/redact.mjs";
import { scrubDeep, makeRehydrator, vault } from "../src/security/vault.mjs";

let n = 0,
  fail = 0;
function assert(cond, msg) {
  n++;
  if (!cond) {
    fail++;
    console.error("  FAIL", msg);
  }
}

const key = "sk-ant-" + "A".repeat(20);
const out = scrub(`token=${key}`);
assert(out.includes("{{anthropic-key:"), "scrubs anthropic key");
assert(!out.includes(key), "removes raw key");
assert(tag("anthropic-key", key) === tag("anthropic-key", key), "stable placeholders");

vault.clear();
const deep = scrubDeep({ type: "text", text: `Bearer ${"x".repeat(32)}` });
assert(typeof deep.text === "string" && deep.text.includes("{{"), "scrubDeep redacts");
const thinking = scrubDeep({ type: "thinking", thinking: key, signature: "sig" });
assert(thinking.thinking === key, "thinking blocks untouched");

const reh = makeRehydrator();
vault.set("{{anthropic-key:deadbeef}}", key);
assert(reh.feed("hi {{anthropic-key:deadbeef}}") === "hi " + key, "rehydrate");

const mailed = scrub("contact me at user@example.com please");
assert(!mailed.includes("user@example.com"), "emails redacted by default");

console.log(`redact: ${n - fail}/${n} ok`);
process.exit(fail ? 1 : 0);
