// Store-and-forward queue (bridge 0.8.0).
//
// A tablet that works offline keeps its operations (orders, payments, item
// status changes, caja movements) in its own outbox and replays them when it
// gets internet back. If that tablet is asleep, closed or out of battery when
// the connection returns, the sales sit on it — and nobody else can see them
// in the cloud. So devices also hand each operation to the bridge, the one
// machine that stays plugged in, and the bridge uploads it as soon as IT is
// online (lan-upload.mjs → POST /api/public/bridge/ops on the app).
//
// The bridge cannot forge or alter these: each one arrives as an ENVELOPE
// signed by the device with a key the app derived from a server-only secret
// and never sent to the bridge (src/lib/sync/relay-key.server.ts). The app
// re-checks the signature and runs the operation as the staff member who
// made it, under that member's own permissions. Replays are harmless: every
// operation carries the idempotency key the device's own replay uses, so
// whichever of the two arrives second gets the first one's result.
//
// "Queued" must mean DURABLE: the envelope is fsynced to <dir>/<key>.json
// before the device is told so.

import fs from "node:fs";
import path from "node:path";

/** Same alphabet as LAN job keys; outbox keys are UUIDs. */
export const OPS_KEY_RE = /^[A-Za-z0-9_-]{8,200}$/;
export const OPS_ENVELOPE_MAX_BYTES = 200 * 1024;
/** Give up uploading an operation this old (the device still has it). */
export const OPS_MAX_AGE_MS = 72 * 60 * 60_000;
const DONE_KEEP_MS = 24 * 60 * 60_000;
const FAILED_KEEP_MS = 7 * 24 * 60 * 60_000;
const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

/** Delay before upload attempt `attempts + 1` (attempts = failures so far). */
export function opsRetryDelayMs(attempts) {
  return BACKOFF_MS[Math.max(0, Math.min(BACKOFF_MS.length - 1, attempts - 1))];
}

function writeFileDurable(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * @param {{ dir: string, now?: () => number, log?: (...a: unknown[]) => void }} opts
 */
export function createOpsStore({ dir, now = () => Date.now(), log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  /** key -> record */
  const ops = new Map();
  let seq = 0;

  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (!rec || !OPS_KEY_RE.test(rec.key) || !rec.envelope) throw new Error("shape");
      ops.set(rec.key, rec);
      if (Number(rec.seq) > seq) seq = Number(rec.seq);
    } catch (e) {
      log(`ops: ignorando ${name} (${e.message})`);
    }
  }

  function file(key) {
    return path.join(dir, `${key}.json`);
  }

  function save(rec) {
    writeFileDurable(file(rec.key), JSON.stringify(rec));
    ops.set(rec.key, rec);
  }

  function update(rec, patch) {
    const next = { ...rec, ...patch };
    try {
      save(next);
    } catch (e) {
      // The in-memory state still moves on; the next boot re-reads the old
      // state and at worst uploads once more (idempotent server-side).
      ops.set(next.key, next);
      log(`ops: no se pudo guardar ${rec.key} (${e.message})`);
    }
    return next;
  }

  function expire(rec, t) {
    if (rec.state === "queued" && t - rec.received_at > OPS_MAX_AGE_MS) {
      log(`ops: ${rec.key} sin subir tras 72 h — queda en el dispositivo que lo creó`);
      return update(rec, { state: "failed", last_error: "expired", done_at: t });
    }
    return rec;
  }

  return {
    /**
     * Durably queue a signed operation. Throws only on disk errors.
     * @returns {"queued" | "known"}
     */
    add(restaurantId, envelope) {
      if (ops.has(envelope.key)) return "known";
      const t = now();
      save({
        key: envelope.key,
        r: restaurantId,
        seq: ++seq,
        envelope,
        state: "queued",
        attempts: 0,
        next_at: t,
        received_at: t,
        last_error: null,
        done_at: null,
      });
      return "queued";
    },

    get: (key) => ops.get(key) ?? null,

    /**
     * Operations ready to upload, in arrival order — a payment uploaded
     * before the order it pays would bounce ("Orden no encontrada").
     * @param {number} limit
     * @param {number} maxBytes  keeps one request under the platform's body cap
     */
    due(limit = 20, maxBytes = 1024 * 1024) {
      const t = now();
      const list = [];
      for (const rec of ops.values()) {
        const cur = expire(rec, t);
        if (cur.state === "queued" && cur.next_at <= t) list.push(cur);
      }
      list.sort((a, b) => a.seq - b.seq);
      const out = [];
      let bytes = 0;
      for (const rec of list) {
        const size = JSON.stringify(rec.envelope).length;
        if (out.length > 0 && (out.length >= limit || bytes + size > maxBytes)) break;
        out.push(rec);
        bytes += size;
      }
      return out;
    },

    /**
     * What the app answered for one upload.
     * @param {string} key
     * @param {{ status: "synced" | "retry" | "failed" | "skip", error?: string | null, retryInMs?: number }} result
     */
    markResult(key, result) {
      const rec = ops.get(key);
      if (!rec || rec.state !== "queued") return rec ?? null;
      const t = now();
      if (result.status === "synced") return update(rec, { state: "synced", last_error: null, done_at: t });
      if (result.status === "failed") return update(rec, { state: "failed", last_error: result.error ?? null, done_at: t });
      if (result.status === "skip") return update(rec, { state: "skipped", last_error: result.error ?? null, done_at: t });
      const attempts = rec.attempts + 1;
      const delay = Math.max(result.retryInMs ?? 0, opsRetryDelayMs(attempts));
      return update(rec, { attempts, next_at: t + delay, last_error: result.error ?? null });
    },

    /** Back off every queued op (the app is unreachable or refused us). */
    deferAll(ms, reason) {
      const t = now();
      for (const rec of ops.values()) {
        if (rec.state === "queued" && rec.next_at < t + ms) {
          ops.set(rec.key, { ...rec, next_at: t + ms, last_error: reason ?? rec.last_error });
        }
      }
    },

    /**
     * The device that made the operation reports it synced it itself, gave
     * up on it (failed on its side — it owns the retry now) or discarded it.
     * Either way this bridge must not upload it any more.
     */
    markDevice(key, how) {
      const rec = ops.get(key);
      if (!rec || rec.state !== "queued") return;
      update(rec, { state: how === "synced" ? "synced" : "device", last_error: how === "synced" ? null : how, done_at: now() });
    },

    /**
     * @param {string | null} [restaurantId]
     * @returns {{ queued: number, failed: number }}
     */
    stats(restaurantId = null) {
      const t = now();
      let queued = 0;
      let failed = 0;
      for (const rec of ops.values()) {
        if (restaurantId && rec.r !== restaurantId) continue;
        if (rec.state === "queued") queued++;
        else if (rec.state === "failed" && t - (rec.done_at ?? 0) < DONE_KEEP_MS) failed++;
      }
      return { queued, failed };
    },

    /** Forget finished operations past their retention. */
    compact() {
      const t = now();
      for (const rec of [...ops.values()]) {
        const cur = expire(rec, t);
        const keep = cur.state === "failed" ? FAILED_KEEP_MS : DONE_KEEP_MS;
        if (cur.state !== "queued" && t - (cur.done_at ?? t) > keep) {
          ops.delete(cur.key);
          fs.rmSync(file(cur.key), { force: true });
        }
      }
    },
  };
}
