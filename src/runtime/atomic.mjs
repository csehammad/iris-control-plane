/**
 * Atomic JSON writes.
 *
 * Every ledger is rewritten whole on each save. `writeFileSync` truncates first
 * and then writes, so any reader that opens the file inside that window gets a
 * partial document — and since a ledger reader treats a parse failure as "no
 * index yet", the failure mode is not an error but a silent zero.
 *
 * That was tolerable while a ledger was only ever read by the process that wrote
 * it, at startup. It stops being tolerable the moment one Iris reads another
 * project's ledger for a fleet total: a torn read there drops a whole project
 * out of the sum with nothing on screen to say so.
 *
 * Writing to a sibling temp file and renaming fixes it. `rename(2)` is atomic on
 * POSIX and replaces the destination in one step, so a concurrent reader sees
 * either the whole previous file or the whole new one, never a fragment. The
 * temp file must be a sibling — rename is only atomic within a filesystem.
 */

import { writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";

/**
 * Serialise `data` and replace `path` with it atomically.
 *
 * @param {string} path      destination file
 * @param {unknown} data     JSON-serialisable value
 * @param {{ indent?: number, trailingNewline?: boolean }} [opts]
 * @throws whatever the underlying write/rename throws — callers already decide
 *         whether a failed persist is fatal, and swallowing it here would hide
 *         a full disk from every one of them.
 */
export function writeJsonAtomic(path, data, opts = {}) {
  const { indent, trailingNewline = false } = opts;
  const body = JSON.stringify(data, null, indent) + (trailingNewline ? "\n" : "");

  /* Unique per call: two saves racing on one path must not share a temp file, or
     the loser's rename publishes the winner's half-written bytes. */
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`
  );

  try {
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    /* Leaving a stray temp file behind would be its own small bug, and the
       cleanup must never mask the real error. */
    try {
      unlinkSync(tmp);
    } catch {
      // FALLBACK-GUARD: INTENTIONAL — temp may not exist; the original error wins
    }
    throw err;
  }
}
