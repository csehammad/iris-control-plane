/**
 * In-memory SSE ring buffer + subscriber fan-out.
 */

const HISTORY_MAX = 200;

export function createEventBus({ max = HISTORY_MAX } = {}) {
  const history = [];
  const monitors = new Set();

  function broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of monitors) {
      try {
        res.write(payload);
      } catch {
        monitors.delete(res);
      }
    }
  }

  function record(event) {
    history.push(event);
    if (history.length > max) history.shift();
    broadcast(event);
  }

  function subscribe(res) {
    monitors.add(res);
    return () => monitors.delete(res);
  }

  function replay(res) {
    for (const e of history) res.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  return { record, broadcast, subscribe, replay, history, monitors };
}
