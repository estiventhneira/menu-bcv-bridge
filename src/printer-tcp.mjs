// Open a TCP connection to host:9100, write bytes, close.
import net from "node:net";

/**
 * Jobs above this size get a drain grace before the socket closes. A text
 * ticket is 1–3 KB and has always been closed immediately; raster font
 * tickets are 30–50× that (tens of KB), and some Wi-Fi printer modules
 * discard whatever is still in their receive buffer when the peer sends FIN.
 */
const GRACE_THRESHOLD_BYTES = 4 * 1024;
/**
 * Drain rate the grace assumes, in bytes per millisecond. The module hands
 * bytes to the printer's mainboard over a serial link: 115200 baud is
 * ~11.5 bytes/ms, and slower modules exist. 0.6.0 assumed 32 bytes/ms, which
 * closed a 35 KB comanda after 1.1 s — the module had forwarded the header
 * and the rule, then dropped the item lines on FIN, so the ticket came out
 * blank below the rule. 6 bytes/ms covers a 57600-baud link with margin.
 */
const DRAIN_BYTES_PER_MS = 6;
const GRACE_MAX_MS = 20_000;

/** Milliseconds to hold the socket open after the last byte is handed to the
 *  kernel, so the module can forward everything before it sees FIN. */
export function graceMsFor(byteLength) {
  return byteLength > GRACE_THRESHOLD_BYTES
    ? Math.min(GRACE_MAX_MS, Math.ceil(byteLength / DRAIN_BYTES_PER_MS))
    : 0;
}

/**
 * Upper bound on the time the write itself may take. A module with a small
 * TCP window applies back-pressure for as long as the printer drains, so a
 * big job can legitimately sit in the write for the whole drain time; the
 * connect timeout must not cover it (a timeout mid-write destroys the socket
 * with RST, loses the tail AND retries the job → a second, partial ticket).
 */
export function writeTimeoutMsFor(byteLength) {
  return Math.max(30_000, 2 * graceMsFor(byteLength));
}

export function sendOverTcp(host, port, bytes, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let done = false;
    let timer = null;
    const settle = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      fn(value);
    };
    // A module that talks back (status bytes, echoes) must not stall the
    // stream; nothing here reads it.
    sock.on("data", () => {});
    sock.once("error", (err) => settle(reject, err));

    timer = setTimeout(
      () => settle(reject, new Error(`Timeout connecting to ${host}:${port}`)),
      timeoutMs,
    );

    sock.connect(port, host, () => {
      // Connected: from here on the budget is the write's, not the connect's.
      clearTimeout(timer);
      timer = setTimeout(
        () => settle(reject, new Error(`Timeout sending to ${host}:${port}`)),
        writeTimeoutMsFor(bytes.length),
      );
      sock.write(bytes, (err) => {
        if (err) return settle(reject, err);
        // The bytes are handed to the kernel (and, once the module's window
        // accepted them, to the module). Hold the socket open long enough
        // for the module to forward them before it sees FIN.
        clearTimeout(timer);
        const finish = () => {
          clearTimeout(timer);
          sock.end(() => settle(resolve));
        };
        const grace = graceMsFor(bytes.length);
        if (grace > 0) {
          timer = setTimeout(finish, grace);
          // The printer closing first means it took everything it will.
          sock.once("end", finish);
        } else {
          finish();
        }
      });
    });
  });
}
