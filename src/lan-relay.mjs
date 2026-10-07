// LAN order relay board (bridge 0.8.0).
//
// While the internet is down, an order taken on one tablet used to exist
// only on that tablet: the KDS never saw it and the caja could not charge it.
// Every device on the restaurant WiFi now pushes the rows its offline work
// produced (orders, order_items — the same shapes the app keeps in IndexedDB)
// to this board, and pulls everybody else's. The bridge is the one machine
// that stays plugged in, so it is the meeting point.
//
// The board is a last-writer-wins row store, not an event log:
//
//  * rows   — (table, id) → merged data. A push SHALLOW-MERGES into the row,
//    so a create sends the full row once and later changes (a payment, an
//    item marked ready) send only the fields they touched. Every write gets
//    the next version number of the restaurant's board.
//  * states — one per order: which outbox operations (by idempotency key)
//    still have to reach the cloud for this order. An order is SETTLED once
//    every one of them synced (acked by a device, or uploaded by this bridge
//    — lan-ops.mjs) or was dropped. Devices hand settled orders back to the
//    server data. A settled order is purged an hour later; an order nobody
//    settles is purged after 72 h. Purges leave a tombstone version so
//    devices drop their copies.
//    IN_CLOUD is narrower: the op that CREATED the order synced (or no
//    create is known — the order came from the server). A payment taken on
//    another device waits for exactly that, not for the whole order to
//    settle: the payment is itself one of the order's pending ops.
//
// Devices pull with a cursor (`since`) and get every row/state written after
// it, in version order, plus long-polling (`waitForChange`) so a new order
// reaches the KDS in about a second without anyone polling hard.
//
// `epoch` identifies this board's history. If the store is wiped (new PC,
// reinstall), a device holding a cursor from another epoch resyncs from 0.
//
// Durability: append-only `board.jsonl` (last line per key wins on replay),
// compacted at boot and hourly. Appends are not fsynced — the board is a
// shared cache of what devices hold; losing the last seconds on a power cut
// costs visibility, never data (every device still has its own copy and its
// own outbox).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELAY_TABLES = new Set(["orders", "order_items"]);
/** Longest a pull may be held open. Bun's HTTP server closes connections idle
 *  for 10 s by default, so stay well under it. */
export const RELAY_WAIT_MAX_MS = 8_000;
export const RELAY_PULL_LIMIT = 400;
/** A settled order stays visible this long, so every device sees the flag. */
export const RELAY_SETTLED_KEEP_MS = 60 * 60_000;
/** An order nobody settles is given up after this. */
export const RELAY_MAX_AGE_MS = 72 * 60 * 60_000;
/** Tombstones outlive the purge by this much. */
export const RELAY_TOMBSTONE_KEEP_MS = 72 * 60 * 60_000;
/** Synced/dropped keys are remembered this long (late pushes stay settled). */
const RESOLVED_KEY_KEEP_MS = 72 * 60 * 60_000;
const SEQ_DAYS_KEPT = 3;

function rowKey(t, id) {
  return `${t}:${id}`;
}

/**
 * @typedef {{ t: string, id: string, order_id: string | null, v: number, origin: string | null, data: Record<string, any> }} RelayRowOut
 * @typedef {{ id: string, v: number, settled: boolean, deleted: boolean, pending: number, in_cloud: boolean }} RelayStateOut
 * @typedef {{ r: string, id: string, settled: boolean }} RelayChange
 */

/**
 * @param {{
 *   dir: string,
 *   now?: () => number,
 *   log?: (...a: unknown[]) => void,
 *   randomId?: () => string,
 * }} opts
 */
export function createRelayBoard({ dir, now = () => Date.now(), log = () => {}, randomId = () => crypto.randomUUID() }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "board.jsonl");

  let epoch = null;
  /** restaurant id -> board */
  const boards = new Map();
  /** op key -> Set of "restaurantId:orderId" waiting on it */
  const keyOrders = new Map();
  /** op key -> { at, how: "synced" | "dropped" } */
  const resolved = new Map();
  /** restaurant id -> Set of resolve callbacks (long-polls) */
  const waiters = new Map();

  function boardFor(r) {
    let b = boards.get(r);
    if (!b) {
      b = { v: 0, rows: new Map(), states: new Map(), seq: new Map() };
      boards.set(r, b);
    }
    return b;
  }

  function indexPending(r, state) {
    for (const k of state.pending) {
      let set = keyOrders.get(k);
      if (!set) keyOrders.set(k, (set = new Set()));
      set.add(`${r}:${state.id}`);
    }
  }

  function unindex(r, orderId, key) {
    const set = keyOrders.get(key);
    if (!set) return;
    set.delete(`${r}:${orderId}`);
    if (set.size === 0) keyOrders.delete(key);
  }

  // ── load ────────────────────────────────────────────────────────────
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // torn last line after a power cut
    }
    if (!e || typeof e !== "object") continue;
    if (e.e === "m" && typeof e.epoch === "string") {
      epoch = e.epoch;
      continue;
    }
    if (e.e === "k" && typeof e.k === "string") {
      resolved.set(e.k, { at: Number(e.at) || 0, how: e.how === "dropped" ? "dropped" : "synced" });
      continue;
    }
    if (typeof e.r !== "string") continue;
    const b = boardFor(e.r);
    if (Number.isFinite(e.v) && e.v > b.v) b.v = e.v;
    if (e.e === "r" && RELAY_TABLES.has(e.t) && typeof e.id === "string") {
      b.rows.set(rowKey(e.t, e.id), {
        t: e.t,
        id: e.id,
        o: typeof e.o === "string" ? e.o : null,
        v: Number(e.v) || 0,
        origin: typeof e.origin === "string" ? e.origin : null,
        at: Number(e.at) || 0,
        data: e.data && typeof e.data === "object" ? e.data : {},
      });
    } else if (e.e === "s" && typeof e.id === "string") {
      const state = {
        id: e.id,
        v: Number(e.v) || 0,
        pending: new Set(Array.isArray(e.pending) ? e.pending.filter((k) => typeof k === "string") : []),
        settled: e.settled === true,
        deleted: e.deleted === true,
        created_at: Number(e.created_at) || 0,
        settled_at: Number(e.settled_at) || 0,
        at: Number(e.at) || 0,
        create_key: typeof e.create_key === "string" ? e.create_key : null,
      };
      b.states.set(e.id, state);
      if (state.deleted) {
        for (const [k, row] of b.rows) if (row.id === e.id || row.o === e.id) b.rows.delete(k);
      }
    } else if (e.e === "q" && typeof e.day === "string" && Number.isFinite(e.n)) {
      b.seq.set(e.day, Math.max(b.seq.get(e.day) ?? 0, e.n));
    }
  }
  for (const [r, b] of boards) for (const state of b.states.values()) if (!state.deleted) indexPending(r, state);

  const isNew = !epoch;
  if (!epoch) epoch = randomId();

  function append(entries) {
    if (entries.length === 0) return;
    try {
      fs.appendFileSync(file, entries.map((x) => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
    } catch (e) {
      log(`relay: no se pudo escribir el tablero (${e.message})`);
    }
  }

  function rowEntry(r, row) {
    return { e: "r", r, t: row.t, id: row.id, o: row.o, v: row.v, origin: row.origin, at: row.at, data: row.data };
  }

  function stateEntry(r, s) {
    return {
      e: "s",
      r,
      id: s.id,
      v: s.v,
      pending: [...s.pending],
      settled: s.settled,
      deleted: s.deleted,
      created_at: s.created_at,
      settled_at: s.settled_at,
      at: s.at,
      create_key: s.create_key ?? null,
    };
  }

  /** The order exists in the cloud: its creating op synced, or none is known. */
  function inCloud(s) {
    if (!s.create_key) return true;
    return resolved.get(s.create_key)?.how === "synced";
  }

  function wake(r) {
    const set = waiters.get(r);
    if (!set) return;
    waiters.delete(r);
    for (const resolve of set) resolve();
  }

  /** Rewrite the log to the live state (boot + hourly). */
  function compact() {
    const lines = [{ e: "m", epoch }];
    const cutoff = now() - RESOLVED_KEY_KEEP_MS;
    for (const [k, x] of resolved) {
      if (x.at < cutoff) resolved.delete(k);
      else lines.push({ e: "k", k, at: x.at, how: x.how });
    }
    for (const [r, b] of boards) {
      // Keeps the version counter monotonic even when every row is gone: a
      // device cursor must never point past a restarted counter.
      lines.push({ e: "v", r, v: b.v });
      for (const row of b.rows.values()) lines.push(rowEntry(r, row));
      for (const s of b.states.values()) lines.push(stateEntry(r, s));
      const days = [...b.seq.keys()].sort().slice(-SEQ_DAYS_KEPT);
      for (const day of [...b.seq.keys()]) if (!days.includes(day)) b.seq.delete(day);
      for (const day of days) lines.push({ e: "q", r, day, n: b.seq.get(day), v: b.v });
    }
    const body = lines.map((x) => JSON.stringify(x)).join("\n") + "\n";
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      log(`relay: no se pudo compactar el tablero (${e.message})`);
    }
  }

  if (isNew) append([{ e: "m", epoch }]);

  /** Settle (or keep waiting on) one order after its pending set changed. */
  function refreshState(r, b, state, t, out) {
    const settled = state.pending.size === 0;
    if (settled && !state.settled) {
      state.settled = true;
      state.settled_at = t;
    } else if (!settled && state.settled) {
      state.settled = false;
      state.settled_at = 0;
    }
    state.v = ++b.v;
    state.at = t;
    out.push(stateEntry(r, state));
  }

  /**
   * @param {string} key
   * @param {"synced" | "dropped"} how
   * @param {string | null} onlyRestaurant
   * @returns {RelayChange[]}
   */
  function resolveKey(key, how, onlyRestaurant) {
    const t = now();
    if (!resolved.has(key)) {
      resolved.set(key, { at: t, how });
      append([{ e: "k", k: key, at: t, how }]);
    }
    const set = keyOrders.get(key);
    if (!set) return [];
    /** @type {RelayChange[]} */
    const changed = [];
    for (const ref of [...set]) {
      const i = ref.indexOf(":");
      const r = ref.slice(0, i);
      const orderId = ref.slice(i + 1);
      if (onlyRestaurant && r !== onlyRestaurant) continue;
      const b = boards.get(r);
      const state = b?.states.get(orderId);
      set.delete(ref);
      if (!state || state.deleted || !state.pending.delete(key)) continue;
      const out = [];
      refreshState(r, b, state, t, out);
      append(out);
      changed.push({ r, id: orderId, settled: state.settled });
      wake(r);
    }
    if (set.size === 0) keyOrders.delete(key);
    return changed;
  }

  return {
    get epoch() {
      return epoch;
    },

    /**
     * Store what one device's offline operation produced.
     * @param {string} r restaurant id (from the LAN token)
     * @param {{ origin: string, rows: Array<{ t: string, id: string, order_id?: string | null, data: object }>,
     *           op: { key: string, order_ids: string[], creates?: boolean } }} push
     * @returns {{ v: number }}
     */
    push(r, push) {
      const b = boardFor(r);
      const t = now();
      const out = [];
      const touchedOrders = new Set(push.op.order_ids);
      for (const row of push.rows) {
        const orderId = row.t === "orders" ? row.id : row.order_id ?? null;
        if (orderId) touchedOrders.add(orderId);
        const key = rowKey(row.t, row.id);
        const prev = b.rows.get(key);
        const next = {
          t: row.t,
          id: row.id,
          o: row.t === "orders" ? null : orderId,
          v: ++b.v,
          origin: push.origin,
          at: t,
          data: { ...(prev?.data ?? {}), ...row.data },
        };
        b.rows.set(key, next);
        out.push(rowEntry(r, next));
      }
      const how = resolved.get(push.op.key);
      for (const orderId of touchedOrders) {
        let state = b.states.get(orderId);
        const fresh = !state || state.deleted;
        if (fresh) {
          state = { id: orderId, v: 0, pending: new Set(), settled: false, deleted: false, created_at: t, settled_at: 0, at: t, create_key: null };
          b.states.set(orderId, state);
        }
        const before = state.pending.size;
        // A key that already synced (the device pushed after its own flush,
        // or this bridge uploaded it first) must not reopen the order.
        if (!how) state.pending.add(push.op.key);
        // The op that created this order (an offline create): until it
        // syncs, the order is not in the cloud.
        const newCreate = push.op.creates === true && state.create_key !== push.op.key;
        if (newCreate) state.create_key = push.op.key;
        if (fresh || newCreate || state.pending.size !== before || state.settled !== (state.pending.size === 0)) {
          refreshState(r, b, state, t, out);
        }
        if (!how) indexPending(r, { id: orderId, pending: new Set([push.op.key]) });
      }
      append(out);
      wake(r);
      return { v: b.v };
    },

    /**
     * Rows and order states written after `since`, oldest first.
     * @param {string} r
     * @param {number} since
     * @param {number} [limit]
     * @returns {{ v: number, rows: RelayRowOut[], states: RelayStateOut[], more: boolean }}
     */
    pull(r, since, limit = RELAY_PULL_LIMIT) {
      const b = boards.get(r);
      if (!b) return { v: 0, rows: [], states: [], more: false };
      const items = [];
      for (const row of b.rows.values()) if (row.v > since) items.push({ kind: "row", v: row.v, x: row });
      for (const s of b.states.values()) if (s.v > since) items.push({ kind: "state", v: s.v, x: s });
      items.sort((a, c) => a.v - c.v);
      const more = items.length > limit;
      const page = more ? items.slice(0, limit) : items;
      /** @type {RelayRowOut[]} */
      const rows = [];
      /** @type {RelayStateOut[]} */
      const states = [];
      for (const it of page) {
        if (it.kind === "row") {
          const row = it.x;
          rows.push({ t: row.t, id: row.id, order_id: row.o, v: row.v, origin: row.origin, data: row.data });
        } else {
          const s = it.x;
          states.push({ id: s.id, v: s.v, settled: s.settled, deleted: s.deleted, pending: s.pending.size, in_cloud: inCloud(s) });
        }
      }
      return { v: more ? page[page.length - 1].v : b.v, rows, states, more };
    },

    /** Current version of a restaurant's board (0 when empty). */
    version(r) {
      return boards.get(r)?.v ?? 0;
    },

    /**
     * Resolves when the restaurant's board moves past `since`, after `ms`,
     * or when `signal` aborts — whichever comes first.
     */
    waitForChange(r, since, ms, signal) {
      if ((boards.get(r)?.v ?? 0) > since || ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        let set = waiters.get(r);
        if (!set) waiters.set(r, (set = new Set()));
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", done);
          set.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(ms, RELAY_WAIT_MAX_MS));
        signal?.addEventListener?.("abort", done);
        set.add(done);
      });
    },

    /**
     * A device reports what happened to operations it pushed.
     * synced/dropped settle the orders that waited on them; failed ones keep
     * the order open (it is still not in the cloud) — only the upload stops.
     * @param {string} r
     * @param {{ synced?: string[], dropped?: string[] }} ack
     * @returns {RelayChange[]}
     */
    ack(r, { synced = [], dropped = [] }) {
      /** @type {RelayChange[]} */
      const changed = [];
      for (const k of synced) changed.push(...resolveKey(k, "synced", r));
      for (const k of dropped) changed.push(...resolveKey(k, "dropped", r));
      return changed;
    },

    /**
     * This bridge uploaded the operation itself (lan-ops.mjs).
     * @param {string} key
     * @returns {RelayChange[]}
     */
    opSynced(key) {
      return resolveKey(key, "synced", null);
    },

    isResolved(key) {
      return resolved.has(key);
    },

    /**
     * Next shared temporary order number for `day` ("T-014"): one counter for
     * every tablet, so two offline orders never both print as T-001. `min` is
     * the device's own next number — numbers it already used while the bridge
     * was unreachable are skipped.
     */
    nextSeq(r, day, min = 0) {
      const b = boardFor(r);
      const n = Math.max(b.seq.get(day) ?? 0, (Number(min) || 0) - 1) + 1;
      b.seq.set(day, n);
      append([{ e: "q", r, day, n, v: b.v }]);
      return n;
    },

    /** @returns {{ epoch: string, v: number, orders: number, unsettled: number }} */
    stats(r) {
      const b = boards.get(r);
      let orders = 0;
      let unsettled = 0;
      for (const s of b?.states.values() ?? []) {
        if (s.deleted) continue;
        orders++;
        if (!s.settled) unsettled++;
      }
      return { epoch, v: b?.v ?? 0, orders, unsettled };
    },

    /** Purge settled / abandoned orders and expired tombstones. */
    sweep() {
      const t = now();
      for (const [r, b] of boards) {
        const out = [];
        for (const [id, s] of b.states) {
          if (s.deleted) {
            if (t - s.at > RELAY_TOMBSTONE_KEEP_MS) b.states.delete(id);
            continue;
          }
          const expired = s.settled ? t - s.settled_at > RELAY_SETTLED_KEEP_MS : t - s.created_at > RELAY_MAX_AGE_MS;
          if (!expired) continue;
          if (!s.settled) log(`relay: pedido ${id.slice(0, 8)} sin sincronizar tras 72 h — se retira del tablero`);
          for (const k of s.pending) unindex(r, id, k);
          s.pending.clear();
          s.deleted = true;
          s.v = ++b.v;
          s.at = t;
          out.push(stateEntry(r, s));
          for (const [k, row] of b.rows) if (row.id === id || row.o === id) b.rows.delete(k);
        }
        if (out.length) {
          append(out);
          wake(r);
        }
      }
    },

    compact,
  };
}
