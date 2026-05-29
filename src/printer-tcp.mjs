// Open a TCP connection to host:9100, write bytes, close.
import net from "node:net";

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
        // Give the printer a moment to absorb buffered bytes before closing.
        sock.end(() => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        });
      });
    });
  });
}
