// Open a TCP connection to host:9100, write bytes, close.
import net from "node:net";

/**
 * Jobs above this size get a drain grace before the socket closes. Raster
 * font tickets are 30–50× a text ticket (tens of KB): some Wi-Fi printer
 * modules discard whatever is still in their receive buffer when the peer
 * sends FIN, which a 3 KB text ticket never exposed. Text tickets keep the
 * historic immediate close.
 */
const GRACE_THRESHOLD_BYTES = 16 * 1024;
const GRACE_MAX_MS = 4_000;

/** ~32 bytes/ms is a conservative drain rate for a cheap LAN print module. */
export function graceMsFor(byteLength) {
  return byteLength > GRACE_THRESHOLD_BYTES
    ? Math.min(GRACE_MAX_MS, Math.ceil(byteLength / 32))
    : 0;
}

export function sendOverTcp(host, port, bytes, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let done = false;
    const cleanup = () => { try { sock.destroy(); } catch { /* ignore */ } };

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`Timeout connecting to ${host}:${port}`));
    }, timeoutMs);

    sock.once("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    sock.connect(port, host, () => {
      sock.write(bytes, (err) => {
        if (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          cleanup();
          return reject(err);
        }
        // The bytes are handed to the kernel: the connect/write timeout no
        // longer applies, and a big job gets its drain grace before FIN.
        clearTimeout(timer);
        const finish = () => {
          // Give the printer a moment to absorb buffered bytes before closing.
          sock.end(() => {
            if (done) return;
            done = true;
            resolve();
          });
        };
        const grace = graceMsFor(bytes.length);
        if (grace > 0) setTimeout(finish, grace);
        else finish();
      });
    });
  });
}
