/**
 * Claude Code settings.json read/write.
 * Bare-name deny entries remove the tool from model context entirely.
 */

import { readFileSync, writeFileSync } from "node:fs";

/**
 * @param {{ settingsPath: string }} opts
 */
export function createClaudeSettings({ settingsPath } = {}) {
  if (!settingsPath || typeof settingsPath !== "string") {
    throw new Error("createClaudeSettings requires { settingsPath }");
  }

  function readSettings() {
    try {
      return JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      return null;
    }
  }

  function writeSettings(s) {
    writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
  }

  /** @returns {string[]} bare-name deny list (context-removing) */
  function readDeny() {
    const d = readSettings()?.permissions?.deny;
    return Array.isArray(d) ? d : [];
  }

  /**
   * Add or remove a bare tool name from permissions.deny.
   * Bare deny drops the schema from every future payload — that is the Optimize saving.
   * Scoped deny rules (objects) are left untouched; they can block executions while
   * leaving the tool visible in context.
   */
  function setToolDenied(tool, denied) {
    const s = readSettings();
    if (!s || typeof tool !== "string" || !tool) return { ok: false, error: "bad settings or tool name" };
    s.permissions = s.permissions || {};
    const deny = Array.isArray(s.permissions.deny) ? s.permissions.deny : [];
    // Only bare string entries participate in Optimize context-removal.
    const bare = deny.filter((x) => typeof x === "string");
    const scoped = deny.filter((x) => typeof x !== "string");
    const has = bare.includes(tool);
    let nextBare = bare;
    if (denied && !has) nextBare = [...bare, tool];
    else if (!denied && has) nextBare = bare.filter((t) => t !== tool);
    s.permissions.deny = [...nextBare, ...scoped];
    try {
      writeSettings(s);
      console.log(`     [config] ${denied ? "deny" : "allow"} ${tool}  (bare deny now ${nextBare.length} tools)`);
      return { ok: true, deny: nextBare, scopedCount: scoped.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { settingsPath, readSettings, writeSettings, readDeny, setToolDenied };
}

/** @deprecated use createClaudeSettings */
export const createClaudeConfig = createClaudeSettings;
