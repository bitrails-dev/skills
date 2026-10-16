/**
 * @file ws-stdio.mjs
 * @description Minimal client-side WebSocket framing over a child process's stdio. `codex app-server proxy`
 * relays raw bytes between stdio and the app-server control socket (a WebSocket server on a unix socket), so
 * the HTTP upgrade and text frames are spoken by the caller. Text frames only, no fragmentation, no deps.
 */

import { randomBytes } from "node:crypto";

/**
 * @param {import("node:child_process").ChildProcess} proc spawned with stdio pipes
 * @param {{ onMessage: (text: string) => void, onOpen?: () => void, onClose?: (reason: string) => void }} handlers
 * @returns {{ send: (text: string) => void, close: () => void }}
 */
export function wsOverStdio(proc, { onMessage, onOpen, onClose }) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  let upgraded = false;
  let closed = false;
  const queue = [];
  const close = (reason) => {
    if (closed) return;
    closed = true;
    onClose?.(reason);
  };

  const sendFrame = (text) => {
    const payload = Buffer.from(text);
    const mask = randomBytes(4);
    let head;
    if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
    else if (payload.length < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x81;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(payload.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x81;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    proc.stdin.write(Buffer.concat([head, mask, masked]));
  };

  proc.stdin.on("error", () => close("stdin-error"));
  proc.on("exit", () => close("process-exit"));
  proc.stdin.write(
    `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );

  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      if (!buf.slice(0, end).toString().startsWith("HTTP/1.1 101")) return close("upgrade-refused");
      upgraded = true;
      buf = buf.slice(end + 4);
      onOpen?.();
      while (queue.length) sendFrame(queue.shift());
    }
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (op === 1 || op === 0) {
        // text frame or continuation: accumulate until FIN
        fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(fragments).toString();
          fragments = [];
          onMessage(whole);
        }
      }
      else if (op === 9) proc.stdin.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0])); // ping -> empty masked pong
      else if (op === 8) close("server-close");
    }
  });

  return {
    send: (text) => (upgraded ? sendFrame(text) : queue.push(text)),
    close: () => {
      try { proc.stdin.end(); } catch {}
      try { proc.kill(); } catch {}
    },
  };
}
