// LAN print server (bridge 0.7.0) — the bridge's first listening socket.
//
// Tablets on the restaurant WiFi hand tickets straight to the bridge, with or
// without internet (src/lib/printing/lan-print.client.ts). Chrome/Edge 142+
// let an HTTPS page fetch http://<private IP>:<port> after a one-time "local
// network" permission prompt; normal CORS applies. So: plain HTTP, POST-only
// API, CORS limited to the app's origins, and every print call carries a LAN
// token (lan-token.mjs) the app minted for a staff member — guests on the
// same WiFi cannot print.
//
// This module is transport plumbing only (routing, CORS, limits, auth
// header, validation). What a print MEANS — dedup, durable queueing, cloud
// claims — is injected by index.mjs, which keeps this file testable under
// Node (src/lib/printing/bridge-lan-server.test.ts).
//
//   GET  /               human check ("¿llega la tablet a la PC?")
//   POST /lan/v1/hello   reachability + token check + this restaurant's printers
//   POST /lan/v1/print   { job_key, source, printer_id, kind, payload, order_id? }
//   POST /lan/v1/retry   { job_key } — reprint an offline ticket that failed
//
// 0.8.0 (each route answers 404 when index.mjs doesn't provide it, so the
// app can probe features through hello's `features` list):
//   POST /lan/v1/relay/push     a device's offline rows (+ signed operation)
//   POST /lan/v1/relay/pull     everybody's rows since a cursor (long-poll)
//   POST /lan/v1/relay/ack      operations a device synced / dropped / failed
//   POST /lan/v1/relay/seq      shared temporary order number for the day
//   POST /lan/v1/tickets        printed-ticket archive (today + yesterday)
//   POST /lan/v1/tickets/reprint  print an archived ticket again

import http from "node:http";
import { LAN_JOB_KEY_RE } from "./lan-journal.mjs";
import { OPS_ENVELOPE_MAX_BYTES, OPS_KEY_RE } from "./lan-ops.mjs";
import { RELAY_TABLES, RELAY_WAIT_MAX_MS } from "./lan-relay.mjs";

export const LAN_DEFAULT_PORT = 7373;
export const LAN_BODY_LIMIT_BYTES = 256 * 1024;

const BUILT_IN_ORIGINS = ["https://andescocina.com", "https://www.andescocina.com"];
// Vercel preview deployments of the app. A site there still needs the
// user's per-origin LAN permission AND a LAN token to do anything.
const ORIGIN_SUFFIXES = [".vercel.app"];
const DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3100",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3100",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LAN_PRINT_KINDS = new Set([
  "kitchen_ticket",
  "kitchen_modification",
  "customer_ticket",
  "test",
  "caja_report",
  "caja_movement",
]);

/**
 * Origins the server answers CORS for.
 * @param {{ appOrigin?: string | null, extra?: string[], dev?: boolean }} opts
 */
export function buildAllowedOrigins({ appOrigin = null, extra = [], dev = false } = {}) {
  const set = new Set(BUILT_IN_ORIGINS);
  for (const o of [appOrigin, ...extra]) {
    if (typeof o !== "string") continue;
    try {
      set.add(new URL(o).origin);
    } catch {}
  }
  if (dev) for (const o of DEV_ORIGINS) set.add(o);
  return set;
}

/** @param {string | undefined} origin @param {Set<string>} allowed */
export function isAllowedOrigin(origin, allowed) {
  if (!origin) return false;
  if (allowed.has(origin)) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && ORIGIN_SUFFIXES.some((s) => u.hostname.endsWith(s));
  } catch {
    return false;
  }
}

/**
 * Shape check for a print request. Semantics (does the printer exist, is it
 * this restaurant's) are the caller's job.
 * @returns {{ ok: true, job: { job_key: string, source: "cloud" | "offline", printer_id: string, kind: string, payload: object } }
 *         | { ok: false, error: string }}
 */
export function validatePrintRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body" };
  const { job_key, source, printer_id, kind, payload, order_id } = body;
  if (typeof job_key !== "string" || !LAN_JOB_KEY_RE.test(job_key)) return { ok: false, error: "job_key" };
  if (source !== "cloud" && source !== "offline") return { ok: false, error: "source" };
  // A cloud job's key IS its print_jobs id — the claim targets that row.
  if (source === "cloud" && !UUID_RE.test(job_key)) return { ok: false, error: "job_key" };
  if (typeof printer_id !== "string" || !UUID_RE.test(printer_id)) return { ok: false, error: "printer_id" };
  if (typeof kind !== "string" || !LAN_PRINT_KINDS.has(kind)) return { ok: false, error: "kind" };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "payload" };
  // 0.8.0: the order the ticket belongs to, for the reprint archive. Optional
  // (0.7.0 apps never send it).
  if (order_id !== undefined && order_id !== null && (typeof order_id !== "string" || !UUID_RE.test(order_id))) {
    return { ok: false, error: "order_id" };
  }
  const job = { job_key, source, printer_id, kind, payload };
  if (typeof order_id === "string") job.order_id = order_id;
  return { ok: true, job };
}

// ── 0.8.0 validators ─────────────────────────────────────────────────────

const RELAY_MAX_ROWS = 200;
export const RELAY_ROW_MAX_BYTES = 32 * 1024;
const MAX_ACK_KEYS = 500;
const MAX_ORDER_IDS = 20;
const ORIGIN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OP_TYPE_RE = /^[a-z_]{3,64}$/;
const TICKET_ID_RE = /^[A-Za-z0-9_-]{8,200}$/;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** Device data minus local markers (`_dirty`, `_synced_at`, …) and keys that
 *  could reach an object's prototype once spread somewhere. */
function cleanRowData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith("_") || RESERVED_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Shape check for a signed operation the bridge will upload later. The
 * signature itself is checked by the app — the bridge has no key for it.
 * @returns {{ ok: true, envelope: object } | { ok: false, error: string }}
 */
export function validateEnvelope(env) {
  if (!isPlainObject(env)) return { ok: false, error: "envelope" };
  if (env.v !== 1) return { ok: false, error: "envelope_version" };
  if (typeof env.key !== "string" || !OPS_KEY_RE.test(env.key)) return { ok: false, error: "envelope_key" };
  if (typeof env.op_type !== "string" || !OP_TYPE_RE.test(env.op_type)) return { ok: false, error: "envelope_op_type" };
  if (typeof env.restaurant_id !== "string" || !UUID_RE.test(env.restaurant_id)) return { ok: false, error: "envelope_restaurant" };
  if (typeof env.actor_user_id !== "string" || !UUID_RE.test(env.actor_user_id)) return { ok: false, error: "envelope_actor" };
  if (typeof env.client_created_at !== "string" || env.client_created_at.length > 40) return { ok: false, error: "envelope_created_at" };
  if (typeof env.payload !== "string" || env.payload.length > OPS_ENVELOPE_MAX_BYTES) return { ok: false, error: "envelope_payload" };
  if (typeof env.c !== "string" || env.c.length < 8 || env.c.length > 2048) return { ok: false, error: "envelope_claims" };
  if (typeof env.s !== "string" || env.s.length < 16 || env.s.length > 128) return { ok: false, error: "envelope_signature" };
  return {
    ok: true,
    envelope: {
      v: 1,
      key: env.key,
      op_type: env.op_type,
      restaurant_id: env.restaurant_id,
      actor_user_id: env.actor_user_id,
      client_created_at: env.client_created_at,
      payload: env.payload,
      c: env.c,
      s: env.s,
    },
  };
}

/**
 * @returns {{ ok: true, push: { origin: string, rows: Array<{ t: string, id: string, order_id: string | null, data: object }>,
 *            op: { key: string, order_ids: string[], creates: boolean }, envelope: object | null } }
 *         | { ok: false, error: string }}
 */
export function validateRelayPush(body) {
  if (!isPlainObject(body)) return { ok: false, error: "body" };
  const { origin, rows, op, envelope } = body;
  if (typeof origin !== "string" || !ORIGIN_RE.test(origin)) return { ok: false, error: "origin" };
  if (!Array.isArray(rows) || rows.length > RELAY_MAX_ROWS) return { ok: false, error: "rows" };
  if (!isPlainObject(op) || typeof op.key !== "string" || !OPS_KEY_RE.test(op.key)) return { ok: false, error: "op" };
  const orderIds = Array.isArray(op.order_ids) ? op.order_ids : [];
  if (orderIds.length > MAX_ORDER_IDS || orderIds.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
    return { ok: false, error: "op_order_ids" };
  }
  const clean = [];
  for (const row of rows) {
    if (!isPlainObject(row) || !RELAY_TABLES.has(row.t)) return { ok: false, error: "row_table" };
    if (typeof row.id !== "string" || !UUID_RE.test(row.id)) return { ok: false, error: "row_id" };
    if (!isPlainObject(row.data)) return { ok: false, error: "row_data" };
    let orderId = null;
    if (row.t === "order_items") {
      if (typeof row.order_id !== "string" || !UUID_RE.test(row.order_id)) return { ok: false, error: "row_order_id" };
      orderId = row.order_id;
      if (row.data.order_id !== undefined && row.data.order_id !== orderId) return { ok: false, error: "row_order_id" };
    } else if (row.data.id !== undefined && row.data.id !== row.id) {
      return { ok: false, error: "row_id" };
    }
    if (JSON.stringify(row.data).length > RELAY_ROW_MAX_BYTES) return { ok: false, error: "row_too_large" };
    clean.push({ t: row.t, id: row.id, order_id: orderId, data: cleanRowData(row.data) });
  }
  let env = null;
  if (envelope !== undefined && envelope !== null) {
    const v = validateEnvelope(envelope);
    if (!v.ok) return v;
    if (v.envelope.key !== op.key) return { ok: false, error: "envelope_key" };
    env = v.envelope;
  }
  // `creates`: this op created the order (an offline create) — the order is
  // not in the cloud until it syncs (lan-relay.mjs in_cloud).
  return { ok: true, push: { origin, rows: clean, op: { key: op.key, order_ids: orderIds, creates: op.creates === true }, envelope: env } };
}

/** @returns {{ ok: true, pull: { since: number, epoch: string | null, wait_ms: number } } | { ok: false, error: string }} */
export function validateRelayPull(body) {
  if (!isPlainObject(body)) return { ok: false, error: "body" };
  const since = body.since ?? 0;
  if (!Number.isSafeInteger(since) || since < 0) return { ok: false, error: "since" };
  const epoch = body.epoch ?? null;
  if (epoch !== null && (typeof epoch !== "string" || epoch.length > 64)) return { ok: false, error: "epoch" };
  const wait = body.wait_ms ?? 0;
  if (!Number.isFinite(wait) || wait < 0) return { ok: false, error: "wait_ms" };
  return { ok: true, pull: { since, epoch, wait_ms: Math.min(wait, RELAY_WAIT_MAX_MS) } };
}

/** @returns {{ ok: true, ack: { synced: string[], dropped: string[], failed: string[] } } | { ok: false, error: string }} */
export function validateRelayAck(body) {
  if (!isPlainObject(body)) return { ok: false, error: "body" };
  const out = {};
  let total = 0;
  for (const k of ["synced", "dropped", "failed"]) {
    const list = body[k] ?? [];
    if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || !OPS_KEY_RE.test(x))) {
      return { ok: false, error: k };
    }
    total += list.length;
    out[k] = list;
  }
  if (total > MAX_ACK_KEYS) return { ok: false, error: "too_many" };
  return { ok: true, ack: out };
}

/** @returns {{ ok: true, seq: { day: string, min: number } } | { ok: false, error: string }} */
export function validateRelaySeq(body) {
  if (!isPlainObject(body) || typeof body.day !== "string" || !DAY_RE.test(body.day)) return { ok: false, error: "day" };
  const min = body.min ?? 0;
  if (!Number.isSafeInteger(min) || min < 0 || min > 1_000_000) return { ok: false, error: "min" };
  return { ok: true, seq: { day: body.day, min } };
}

/** @returns {{ ok: true, query: { order_id: string | null, since_ms: number | null, limit: number, kinds: string[] | null } } | { ok: false, error: string }} */
export function validateTicketsList(body) {
  if (!isPlainObject(body)) return { ok: false, error: "body" };
  const orderId = body.order_id ?? null;
  if (orderId !== null && (typeof orderId !== "string" || !UUID_RE.test(orderId))) return { ok: false, error: "order_id" };
  const since = body.since_ms ?? null;
  if (since !== null && (!Number.isFinite(since) || since < 0)) return { ok: false, error: "since_ms" };
  const limit = body.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return { ok: false, error: "limit" };
  const kinds = body.kinds ?? null;
  if (kinds !== null && (!Array.isArray(kinds) || kinds.some((k) => !LAN_PRINT_KINDS.has(k)))) return { ok: false, error: "kinds" };
  return { ok: true, query: { order_id: orderId, since_ms: since, limit, kinds } };
}

/** @returns {{ ok: true, reprint: { id: string, printer_id: string | null } } | { ok: false, error: string }} */
export function validateTicketReprint(body) {
  if (!isPlainObject(body) || typeof body.id !== "string" || !TICKET_ID_RE.test(body.id)) return { ok: false, error: "id" };
  const printerId = body.printer_id ?? null;
  if (printerId !== null && (typeof printerId !== "string" || !UUID_RE.test(printerId))) return { ok: false, error: "printer_id" };
  return { ok: true, reprint: { id: body.id, printer_id: printerId } };
}

function bearer(req) {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

const ROUTES_080 = {
  "/lan/v1/relay/push": { dep: "relayPush", validate: validateRelayPush, field: "push" },
  "/lan/v1/relay/pull": { dep: "relayPull", validate: validateRelayPull, field: "pull" },
  "/lan/v1/relay/ack": { dep: "relayAck", validate: validateRelayAck, field: "ack" },
  "/lan/v1/relay/seq": { dep: "relaySeq", validate: validateRelaySeq, field: "seq" },
  "/lan/v1/tickets": { dep: "ticketsList", validate: validateTicketsList, field: "query" },
  "/lan/v1/tickets/reprint": { dep: "ticketReprint", validate: validateTicketReprint, field: "reprint" },
};

/** @typedef {{ status: number, body: object }} Reply */

/**
 * @param {{
 *   version: string,
 *   allowedOrigins: Set<string>,
 *   verify: (token: string) => { ok: true, claims: object } | { ok: false, reason: string },
 *   hello: (claims: object | null) => object,
 *   print: (claims: object, job: object) => Promise<{ status: number, body: object }> | { status: number, body: object },
 *   retry: (claims: object, jobKey: string) => Promise<{ status: number, body: object }> | { status: number, body: object },
 *   relayPush?: (claims: object, push: object) => Promise<Reply> | Reply,
 *   relayPull?: (claims: object, pull: object, signal: AbortSignal) => Promise<Reply> | Reply,
 *   relayAck?: (claims: object, ack: object) => Promise<Reply> | Reply,
 *   relaySeq?: (claims: object, seq: object) => Promise<Reply> | Reply,
 *   ticketsList?: (claims: object, query: object) => Promise<Reply> | Reply,
 *   ticketReprint?: (claims: object, reprint: object) => Promise<Reply> | Reply,
 *   log?: (...a: unknown[]) => void,
 *   rate?: { windowMs: number, max: number },
 *   bodyLimit?: number,
 * }} deps
 */
export function createLanServer(deps) {
  const log = deps.log ?? (() => {});
  const rate = deps.rate ?? { windowMs: 10_000, max: 150 };
  const bodyLimit = deps.bodyLimit ?? LAN_BODY_LIMIT_BYTES;
  const hits = new Map(); // ip -> { start, count }

  function limited(ip) {
    const now = Date.now();
    const cur = hits.get(ip);
    if (!cur || now - cur.start >= rate.windowMs) {
      hits.set(ip, { start: now, count: 1 });
      if (hits.size > 1000) {
        for (const [k, v] of hits) if (now - v.start >= rate.windowMs) hits.delete(k);
      }
      return false;
    }
    cur.count++;
    return cur.count > rate.max;
  }

  function send(res, status, body, cors) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...cors,
    });
    res.end(text);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const fail = (code) => reject(Object.assign(new Error(code), { code }));
      if (Number(req.headers["content-length"]) > bodyLimit) {
        fail("too_large");
        return;
      }
      let size = 0;
      let tooLarge = false;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > bodyLimit) tooLarge = true; // keep draining; requestTimeout bounds it
        if (!tooLarge) chunks.push(c);
      });
      req.on("end", () => {
        if (tooLarge) return fail("too_large");
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          fail("bad_json");
        }
      });
      req.on("error", reject);
    });
  }

  async function handle(req, res) {
    const url = (req.url ?? "/").split("?")[0];
    const origin = req.headers.origin;
    const originOk = isAllowedOrigin(origin, deps.allowedOrigins);
    /** @type {Record<string, string>} */
    const cors = originOk ? { "access-control-allow-origin": origin, vary: "Origin" } : {};

    if (req.method === "GET" && (url === "/" || url === "/lan/v1")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(`Fujun Print Bridge v${deps.version} — red local OK\n`);
      return;
    }

    // A browser always sends Origin on these cross-origin calls; only a
    // foreign site's is refused. Origin-less callers (curl, scripts) still
    // need a token for anything beyond hello.
    if (origin && !originOk) {
      send(res, 403, { ok: false, error: "origin" }, {});
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
        // Pre-LNA Chrome builds sent Private Network Access preflights.
        ...(req.headers["access-control-request-private-network"]
          ? { "access-control-allow-private-network": "true" }
          : {}),
      });
      res.end();
      return;
    }

    if (req.method !== "POST" || !url.startsWith("/lan/v1/")) {
      send(res, 404, { ok: false, error: "not_found" }, cors);
      return;
    }

    const ip = req.socket.remoteAddress ?? "?";
    if (limited(ip)) {
      send(res, 429, { ok: false, error: "rate_limited" }, cors);
      return;
    }

    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      const code = /** @type {any} */ (e).code;
      if (code === "too_large") res.setHeader("connection", "close");
      send(res, code === "too_large" ? 413 : 400, { ok: false, error: code ?? "bad_request" }, cors);
      return;
    }

    const token = bearer(req);
    const auth = token ? deps.verify(token) : null;

    if (url === "/lan/v1/hello") {
      const claims = auth && auth.ok ? auth.claims : null;
      send(res, 200, {
        ok: true,
        lan: "v1",
        version: deps.version,
        authorized: !!claims,
        ...(auth && !auth.ok ? { reason: auth.reason } : {}),
        ...(claims ? deps.hello(claims) : {}),
      }, cors);
      return;
    }

    if (!auth || !auth.ok) {
      send(res, 401, { ok: false, error: "token", reason: auth ? auth.reason : "missing" }, cors);
      return;
    }

    if (url === "/lan/v1/print") {
      const v = validatePrintRequest(body);
      if (!v.ok) {
        send(res, 400, { ok: false, error: v.error }, cors);
        return;
      }
      const out = await deps.print(auth.claims, v.job);
      send(res, out.status, out.body, cors);
      return;
    }

    if (url === "/lan/v1/retry") {
      const key = body && typeof body === "object" ? body.job_key : null;
      if (typeof key !== "string" || !LAN_JOB_KEY_RE.test(key)) {
        send(res, 400, { ok: false, error: "job_key" }, cors);
        return;
      }
      const out = await deps.retry(auth.claims, key);
      send(res, out.status, out.body, cors);
      return;
    }

    // ── 0.8.0: relay, store-and-forward, archive ──────────────────────
    const route = Object.hasOwn(ROUTES_080, url) ? ROUTES_080[url] : null;
    if (route) {
      const handler = deps[route.dep];
      if (typeof handler !== "function") {
        send(res, 404, { ok: false, error: "not_found" }, cors);
        return;
      }
      const v = route.validate(body);
      if (!v.ok) {
        send(res, 400, { ok: false, error: v.error }, cors);
        return;
      }
      // A long-poll pull is released as soon as the device hangs up.
      const ctl = new AbortController();
      res.on("close", () => ctl.abort());
      const out = await handler(auth.claims, v[route.field], ctl.signal);
      if (res.destroyed || res.writableEnded) return;
      send(res, out.status, out.body, cors);
      return;
    }

    send(res, 404, { ok: false, error: "not_found" }, cors);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`lan: error atendiendo ${req.method} ${req.url}: ${e?.message ?? e}`);
      if (!res.headersSent) send(res, 500, { ok: false, error: "internal" }, {});
      else res.destroy();
    });
  });
  // Slow or idle clients must not pin sockets on a POS PC.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    /** Resolves with the bound port; rejects (never throws later) on bind errors. */
    listen(port = LAN_DEFAULT_PORT, host = "0.0.0.0") {
      return new Promise((resolve, reject) => {
        const onError = (e) => {
          server.off("listening", onListening);
          reject(e);
        };
        const onListening = () => {
          server.off("error", onError);
          // After a successful bind, a socket error must never crash the bridge.
          server.on("error", (e) => log(`lan: error del servidor: ${e.message}`));
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
