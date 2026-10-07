// Store-and-forward uploader (bridge 0.8.0) — see lan-ops.mjs.
//
// Whenever this bridge has a cloud session, it posts the operations devices
// left with it to the app (POST <app>/api/public/bridge/ops, authenticated
// with the bridge's own device token). The app verifies each device
// signature and runs the operation as the staff member who made it; the
// answer per operation is synced / retry / failed / skip.
//
// Deploy order is free: an app without the route answers 404 and the bridge
// simply waits an hour before asking again — the devices sync their own
// outboxes exactly as before.

const TICK_MS = 15_000;
const REQUEST_TIMEOUT_MS = 110_000;
const MISSING_ROUTE_BACKOFF_MS = 60 * 60_000;
const AUTH_BACKOFF_MS = 60_000;
const ERROR_BACKOFF_MS = 30_000;

/**
 * @param {{
 *   store: ReturnType<typeof import("./lan-ops.mjs").createOpsStore>,
 *   onSynced: (key: string) => void,
 *   getAccessToken: () => Promise<string | null>,
 *   appOrigin: string,
 *   version: string,
 *   log: (...a: unknown[]) => void,
 *   fetchImpl?: typeof fetch,
 * }} deps
 */
export function createOpsUploader({ store, onSynced, getAccessToken, appOrigin, version, log, fetchImpl = fetch }) {
  const url = `${appOrigin.replace(/\/+$/, "")}/api/public/bridge/ops`;
  let running = false;
  let timer = null;
  let kickTimer = null;
  let stopped = false;

  async function uploadOnce() {
    if (running || stopped) return;
    const batch = store.due(20, 1024 * 1024);
    if (batch.length === 0) return;
    const token = await getAccessToken().catch(() => null);
    if (!token) return; // not signed in yet (offline boot) — next tick
    running = true;
    const ctl = new AbortController();
    const abort = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "x-bridge-version": version,
          },
          body: JSON.stringify({ ops: batch.map((r) => r.envelope) }),
          signal: ctl.signal,
        });
      } catch (e) {
        // No internet yet, DNS, timeout: everything waits a little.
        store.deferAll(ERROR_BACKOFF_MS, `red: ${e?.message ?? e}`);
        return;
      }
      if (res.status === 404) {
        store.deferAll(MISSING_ROUTE_BACKOFF_MS, "la app aún no recibe operaciones del bridge");
        log("ops: la app todavía no acepta operaciones del bridge — reintento en 1 h");
        return;
      }
      if (res.status === 401 || res.status === 403) {
        store.deferAll(AUTH_BACKOFF_MS, `rechazado (${res.status})`);
        log(`ops: la app rechazó la sesión del bridge (${res.status})`);
        return;
      }
      if (!res.ok) {
        store.deferAll(ERROR_BACKOFF_MS, `HTTP ${res.status}`);
        return;
      }
      let body;
      try {
        body = await res.json();
      } catch {
        store.deferAll(ERROR_BACKOFF_MS, "respuesta inválida");
        return;
      }
      const results = Array.isArray(body?.results) ? body.results : [];
      const answered = new Set();
      let synced = 0;
      for (const r of results) {
        if (!r || typeof r.key !== "string") continue;
        answered.add(r.key);
        const status = ["synced", "retry", "failed", "skip"].includes(r.status) ? r.status : "retry";
        store.markResult(r.key, {
          status,
          error: typeof r.error === "string" ? r.error.slice(0, 300) : null,
          retryInMs: Number(r.retry_in_ms) || 0,
        });
        if (status === "synced") {
          synced++;
          onSynced(r.key);
        } else if (status === "failed") {
          log(`ops: ${r.key.slice(0, 8)} rechazada por la app: ${r.error ?? "?"}`);
        }
      }
      // Anything the app did not get to (time budget) goes again shortly.
      for (const rec of batch) if (!answered.has(rec.key)) store.markResult(rec.key, { status: "retry", retryInMs: 5_000 });
      if (synced) log(`ops: ${synced} operación(es) subida(s) a la nube desde el bridge`);
    } finally {
      clearTimeout(abort);
      running = false;
    }
    // More waiting (a long outage): keep going without waiting a full tick.
    if (!stopped && store.due(1).length > 0) kick(1_000);
  }

  function kick(delay = 500) {
    if (stopped || kickTimer) return;
    kickTimer = setTimeout(() => {
      kickTimer = null;
      void uploadOnce().catch((e) => log(`ops: error subiendo (${e?.message ?? e})`));
    }, delay);
  }

  return {
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => kick(0), TICK_MS);
      kick(2_000);
    },
    kick,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (kickTimer) clearTimeout(kickTimer);
    },
    /** Test seam. */
    uploadOnce,
  };
}
