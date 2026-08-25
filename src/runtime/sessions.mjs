/**
 * Proxy session identity + started-at metadata.
 */

export function createSession() {
  return {
    id: "sess_" + Math.random().toString(16).slice(2, 8),
    startedAt: new Date().toISOString(),
  };
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
