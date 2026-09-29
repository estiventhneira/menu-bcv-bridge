// Adaptive drain poll (0.6.7) — why it exists: see pollIntervalMs in
// config.mjs. In short, the poll is the printing latency ceiling, but every
// drain is one billed API-gateway request, so it only runs at the old 5 s
// while realtime is unproven:
//
//   FAST (5 s)  any realtime channel not SUBSCRIBED, or a drain in the last
//               10 minutes found a pending job realtime never delivered.
//   SLOW (15 s) otherwise.
//
// The clock is the last successful drain of any origin (poll, sibling sweep,
// startup) or poll attempt, so the sweep after a realtime burst also
// postpones the next poll, and a failing query retries at the interval.
//
// The tick only decides — it makes no request. It is 1 s rather than 5 s so
// a sweep landing between ticks moves the next poll by exactly the interval,
// instead of rounding up to a later 5 s tick (nearly 10 s in FAST mode).

export const DRAIN_TICK_MS = 1_000;
export const DRAIN_FAST_MS = 5_000;
export const DRAIN_SLOW_MS = 15_000;
export const MISS_WINDOW_MS = 10 * 60_000;

/**
 * The poll interval that applies right now. Pure — unit-tested from the
 * app's vitest. Times share one monotonic clock (performance.now()).
 * @param {{ now: number, allSubscribed: boolean, lastMissAt: number | null }} s
 */
export function drainIntervalMs({ now, allSubscribed, lastMissAt }) {
  const recentMiss = lastMissAt !== null && now - lastMissAt < MISS_WINDOW_MS;
  return allSubscribed && !recentMiss ? DRAIN_SLOW_MS : DRAIN_FAST_MS;
}

/**
 * Whether this tick should drain. `lastDrainAt` null = never drained.
 * @param {{ now: number, lastDrainAt: number | null, allSubscribed: boolean, lastMissAt: number | null }} s
 */
export function drainDue(s) {
  return s.lastDrainAt === null || s.now - s.lastDrainAt >= drainIntervalMs(s);
}
