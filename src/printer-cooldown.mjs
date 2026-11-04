// Unreachable-printer rest (0.9.2) — the bridge's twin of the browser
// runner's UNREACHABLE_COOLDOWN_MS (src/lib/printing/print-runner.tsx). Split
// out of index.mjs so the app's vitest can pin the rules
// (src/lib/printing/bridge-printer-cooldown.test.ts).
//
// A wifi printer that stopped answering used to burn a job's three attempts
// in 30–75 s (10 s connect timeout + the next poll, three times), and the
// comanda was failed for good while the printer was still rebooting or out of
// WiFi range. Nobody saw it, so waiters re-sent the order and the items landed
// on the bill twice (GIN, 2026-10-30: 12 comandas in 20 minutes).
//
// Now a connection that never opened rests the printer: its jobs stay
// 'pending' and unclaimed, the drain leaves it out, and a comanda keeps its
// attempts — the server's reaper fails it after 30 min (migration 359) and the
// sender's device shows it in «Comandas sin imprimir» meanwhile. Other kinds
// still spend an attempt per failure, so a receipt doesn't come out an hour
// after the customer left. Any successful print ends the rest.

/** Rest after the 1st, 2nd and every later consecutive failure. */
export const REST_STEPS_MS = [10_000, 20_000, 30_000];

/** Kinds kept pending while their printer is unreachable. */
export const COMANDA_KINDS = new Set(["kitchen_ticket", "kitchen_modification"]);

/** Times are the caller's monotonic clock (performance.now()). */
export function createPrinterRests() {
  const rests = new Map(); // printer id -> { until, failures }
  return {
    isResting(printerId, now) {
      const r = rests.get(printerId);
      return r !== undefined && r.until > now;
    },
    /** Records a failed connection; returns how long the printer rests. */
    noteUnreachable(printerId, now) {
      const failures = (rests.get(printerId)?.failures ?? 0) + 1;
      const ms = REST_STEPS_MS[Math.min(failures, REST_STEPS_MS.length) - 1];
      rests.set(printerId, { until: now + ms, failures });
      return ms;
    },
    noteReachable(printerId) {
      rests.delete(printerId);
    },
  };
}

/**
 * The status and attempts a failed print leaves on its row. `notConnected`
 * means the TCP connection never opened (printer-tcp.mjs), so nothing printed
 * and a retry can't duplicate the ticket. `locating` (0.9.2): the bridge is
 * looking for the printer by its MAC (printer-follow.mjs, a few minutes at
 * most), so a receipt waits for that search too instead of failing first.
 */
export function failedJobUpdate({ kind, notConnected, attempts, maxAttempts, locating = false }) {
  if (notConnected && (COMANDA_KINDS.has(kind) || locating)) return { status: "pending", attempts };
  const next = attempts + 1;
  return { status: next >= maxAttempts ? "failed" : "pending", attempts: next };
}
