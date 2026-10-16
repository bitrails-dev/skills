/**
 * Writes to a stream and resolves once flushed, errored, closed or after `timeoutMs`: a closed pipe never
 * emits "drain", so a bare drain promise could hang the process forever.
 * @param {import("node:stream").Writable} stream
 * @param {string} text
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export function safeWrite(stream, text, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off?.("drain", finish);
      stream.off?.("error", finish);
      stream.off?.("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    try {
      if (stream.destroyed || stream.writableEnded) return finish();
      stream.once("error", finish);
      stream.once("close", finish);
      if (stream.write(text)) finish();
      else stream.once("drain", finish);
    } catch {
      finish();
    }
  });
}
