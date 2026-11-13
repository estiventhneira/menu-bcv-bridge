// Pending-jobs read for the drain poll (0.9.3) — split out of index.mjs so the
// app's vitest can pin it (src/lib/printing/bridge-pending-poll.test.ts).
//
// The direct read (`print_jobs?restaurant_id=in.(…)&status=eq.pending
// &order=created_at&limit=20`) was the top statement in pg_stat_statements on
// 2026-11-08 together with the browsers' twin: under RLS the enum `status = $n`
// can't be an index condition (enum_eq isn't leakproof) and PostgREST's
// generic plans can't use the partial pending index either, so every poll
// walked the restaurant's whole print history in created_at order to find
// the one or two pending rows. Migration 372 added `pending_print_jobs`, a
// SECURITY DEFINER read with the same gate as the SELECT policy (member or
// this bridge's restaurant) that runs on the pending index.
//
// One RPC per restaurant (it takes a single restaurant id), merged and cut to
// the same 20 globally-oldest jobs the direct read returned. Until 372 is
// applied the RPC answers PGRST202 / 42883: fall back to the direct read and
// try the RPC again after RPC_RETRY_MS, so applying the migration needs no
// bridge restart.

export const PENDING_PAGE = 20;
export const RPC_RETRY_MS = 10 * 60_000;

/** Missing function: PostgREST's schema cache, or Postgres itself. */
export function isMissingFunction(error) {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/**
 * @param {{ rpcMissingUntil: number }} state  mutable, owned by the caller
 * @param {{ supabase: any, targets: { restaurantId: string, printerIds: string[] }[], now: number }} args
 *   `now` is the caller's monotonic clock (performance.now()).
 * @returns {Promise<{ data: any[] | null, error: { message: string } | null }>}
 */
export async function readPendingJobs(state, { supabase, targets, now }) {
  const live = targets.filter((t) => t.printerIds.length > 0);
  if (live.length === 0) return { data: [], error: null };

  if (now >= state.rpcMissingUntil) {
    const results = await Promise.all(
      live.map((t) =>
        supabase.rpc("pending_print_jobs", {
          p_restaurant_id: t.restaurantId,
          p_printer_ids: t.printerIds,
          p_limit: PENDING_PAGE,
        })
      )
    );
    const missing = results.find((r) => isMissingFunction(r.error));
    if (!missing) {
      const failed = results.find((r) => r.error);
      if (failed) return { data: null, error: failed.error };
      const jobs = results
        .flatMap((r) => r.data ?? [])
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, PENDING_PAGE);
      return { data: jobs, error: null };
    }
    state.rpcMissingUntil = now + RPC_RETRY_MS;
  }

  const { data, error } = await supabase
    .from("print_jobs")
    .select("*")
    .in("restaurant_id", live.map((t) => t.restaurantId))
    .in("printer_id", live.flatMap((t) => t.printerIds))
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(PENDING_PAGE);
  return { data: data ?? null, error: error ?? null };
}
