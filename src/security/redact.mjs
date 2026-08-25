import { createHash } from "node:crypto";

// Set PROXY_REDACT=0 to log verbatim.
export const REDACT_ON = process.env.PROXY_REDACT !== "0";
export const REDACT_EMAILS = process.env.PROXY_REDACT_EMAILS !== "0";
// No leading \b on these. Scrubbing happens on serialised documents, where a newline
// is the two characters "\" and "n" — so a secret at the start of a line is preceded
// by the letter n, and \b does not match. That silently let 7 of 12 credential shapes
// through. Each pattern is anchored on its own distinctive prefix instead, which is
// the real discriminator; the cost is occasionally redacting a few characters too
// many, and for a security control that is the safe direction to err in.
export const REDACT_RULES = [
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "private-key",   re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "aws-key-id",    re: /(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "aws-secret",    re: /(aws_secret_access_key["'\s]*[=:]\s*["']?)([A-Za-z0-9/+=]{40})/gi, group: 2 },
  { kind: "github-token",  re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { kind: "gitlab-token",  re: /glpat-[A-Za-z0-9_-]{16,}/g },
  { kind: "slack-token",   re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe-key",    re: /sk_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "google-key",    re: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: "openai-key",    re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { kind: "jwt",           re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bearer",        re: /([Bb]earer\s+)([A-Za-z0-9._~+/-]{24,}={0,2})/g, group: 2 },
  { kind: "npm-token",     re: /npm_[A-Za-z0-9]{36}/g },
  { kind: "generic-secret",re: /((?:api[_-]?key|secret|password|passwd|token)["'\s]*[=:]\s*["'])([^"'\n]{12,})(["'])/gi, group: 2 },
];
export const EMAIL_RULE = { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g };
export const redactStats = Object.create(null);
export const tag = (kind, value) => `{{${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 8)}}}`;

// Never throws: a redaction bug must not stop a log being written.
// Passing a vault records placeholder -> value so the swap can be undone, and marks
// this as an explicit wire-redaction call, which is not gated on PROXY_REDACT.
export function scrub(text, vaultRef) {
  if ((!REDACT_ON && !vaultRef) || typeof text !== "string" || !text) return text;
  let out = text;
  try {
    const rules = REDACT_EMAILS ? [...REDACT_RULES, EMAIL_RULE] : REDACT_RULES;
    for (const rule of rules) {
      out = out.replace(rule.re, (m, ...groups) => {
        const value = rule.group ? groups[rule.group - 1] : m;
        if (!value) return m;
        redactStats[rule.kind] = (redactStats[rule.kind] ?? 0) + 1;
        const placeholder = tag(rule.kind, value);
        if (vaultRef) vaultRef.set(placeholder, value);
        return rule.group ? m.replace(value, placeholder) : placeholder;
      });
    }
  } catch {
    return text;
  }
  return out;
}
