// How the bridge feeds jobs to its printers (0.6.8) — split out of index.mjs
// so the app's vitest can pin the concurrency rules
// (src/lib/printing/bridge-job-queue.test.ts).

/**
 * Per-printer promise chain — drive each printer one job at a time (mirror of
 * src/lib/printing/printer-serial.ts). Station splits put several rows per
 * order on one printer; a second TCP socket to a printer mid-ticket is
 * refused or interleaved by some firmwares, and the spooler path is cheap to
 * serialize. Different printers still run in parallel.
 *
 * @returns {<T>(printerId: string, fn: () => Promise<T>) => Promise<T>}
 */
export function createPrinterChains() {
  const chains = new Map();
  return function serialized(printerId, fn) {
    const prev = chains.get(printerId) ?? Promise.resolve();
    const result = prev.then(fn);
    // The chain itself never rejects — a failed job must not block the next.
    const tail = result.then(() => undefined, () => undefined);
    chains.set(printerId, tail);
    tail.then(() => {
      if (chains.get(printerId) === tail) chains.delete(printerId);
    });
    return result;
  };
}

/**
 * Hand a swept batch of pending jobs to `processJob` all at once, then wait
 * for the lot. processJob joins each job to its printer's chain before its
 * first await, so one printer still prints in created_at order while the
 * other printers run alongside it.
 *
 * Up to 0.6.7 the sweep awaited job by job across ALL printers. Whenever
 * realtime dropped a burst — or the bridge came back from a network outage
 * to a backlog — one unreachable printer (10 s connect timeout per attempt)
 * held every other station's comanda behind it.
 *
 * @template J
 * @param {J[]} jobs
 * @param {(job: J) => Promise<void>} processJob
 */
export function startJobs(jobs, processJob) {
  return Promise.all(jobs.map((job) => processJob(job)));
}
