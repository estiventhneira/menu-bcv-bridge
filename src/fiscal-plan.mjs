// Máquina fiscal payloads (bridge 0.9.0) — SINGLE SOURCE for both runtimes,
// like lan-token.mjs: the app signs plans and receipts
// (src/lib/fiscal-printer/*.server.ts import this file) and verifies results;
// the bridge verifies plans and receipts and signs results. Every signature
// uses the pairing's bridge_tokens.lan_secret, so both sides work offline
// from each other once the secret is known.
//
//   plan     app → bridge   "print this factura" — built from the order on
//                           the server, so a staff token alone can never
//                           print an arbitrary fiscal document
//   result   bridge → app   what the machine did (number, Z, its totals)
//   receipt  app → bridge   "these results are recorded" — stops the bridge
//                           listing them as unrecorded
//
// Format: f1.<kind>.<base64url(JSON)>.<base64url(HMAC-SHA256)>, the MAC taken
// over "f1.<kind>.<body>" — the kind is inside the MAC, so a result can't be
// replayed as a receipt, and none of them as a LAN token (different version
// prefix and layout).

import crypto from "node:crypto";

export const FISCAL_SIG_VERSION = "f1";
export const FISCAL_KINDS = new Set(["plan", "result", "receipt"]);
/** How long the app makes a plan valid. The bridge also dedups by job and
 *  by order, so expiry only bounds how long a captured plan is useful. */
export const FISCAL_PLAN_TTL_MS = 30 * 60_000;
/** PC clocks drift (see lan-token.mjs): allowance on both ends. */
export const FISCAL_SKEW_MS = 24 * 60 * 60_000;
export const FISCAL_PAYMENT_CODE_RE = /^(?:0[1-9]|1[0-9])$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGISTRO_RE = /^[A-Za-z0-9]{3,16}$/;
const MAX_TOKEN = 256 * 1024;

function mac(secret, signed) {
  return crypto.createHmac("sha256", secret).update(signed).digest("base64url");
}

/**
 * @param {string} secret  bridge_tokens.lan_secret
 * @param {"plan" | "result" | "receipt"} kind
 * @param {object} payload
 */
export function signFiscal(secret, kind, payload) {
  if (typeof secret !== "string" || secret.length < 16) throw new Error("fiscal: falta la clave");
  if (!FISCAL_KINDS.has(kind)) throw new Error(`fiscal: tipo ${kind} desconocido`);
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signed = `${FISCAL_SIG_VERSION}.${kind}.${body}`;
  return `${signed}.${mac(secret, signed)}`;
}

/**
 * Kind and payload WITHOUT checking the signature — only to pick the secret
 * (payload.t). Never trust the result on its own.
 * @returns {{ kind: string, payload: Record<string, any> } | null}
 */
export function peekFiscal(token) {
  if (typeof token !== "string" || token.length > MAX_TOKEN) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== FISCAL_SIG_VERSION || !FISCAL_KINDS.has(parts[1])) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? { kind: parts[1], payload } : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} secret
 * @param {"plan" | "result" | "receipt"} kind
 * @param {unknown} token
 * @param {number} [nowMs]
 * @returns {{ ok: true, payload: Record<string, any> }
 *   | { ok: false, reason: "malformed" | "wrong_kind" | "bad_signature" | "expired" | "not_yet_valid" }}
 */
export function verifyFiscal(secret, kind, token, nowMs = Date.now()) {
  const peek = peekFiscal(token);
  if (!peek || typeof secret !== "string" || secret.length < 16) return { ok: false, reason: "malformed" };
  if (peek.kind !== kind) return { ok: false, reason: "wrong_kind" };
  const parts = /** @type {string} */ (token).split(".");
  const expected = Buffer.from(mac(secret, `${parts[0]}.${parts[1]}.${parts[2]}`), "utf8");
  const given = Buffer.from(parts[3], "utf8");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }
  const p = peek.payload;
  if (Number.isFinite(p.exp) && nowMs > p.exp * 1000 + FISCAL_SKEW_MS) return { ok: false, reason: "expired" };
  if (Number.isFinite(p.iat) && nowMs < p.iat * 1000 - FISCAL_SKEW_MS) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, payload: p };
}

// ── plan validation (shared: the server builds, the bridge re-checks) ────

const str = (x, max, min = 0) => typeof x === "string" && x.length >= min && x.length <= max;
const int = (x, min, max) => Number.isSafeInteger(x) && x >= min && x <= max;
const strList = (x, maxItems, maxLen) =>
  x === undefined || (Array.isArray(x) && x.length <= maxItems && x.every((s) => str(s, maxLen)));

/**
 * Strict shape check of a factura plan.
 * @returns {{ ok: true, plan: object } | { ok: false, error: string }}
 */
export function validatePlan(p) {
  const fail = (error) => ({ ok: false, error });
  if (!p || typeof p !== "object" || Array.isArray(p)) return fail("plan");
  if (p.v !== 1) return fail("version");
  for (const k of ["r", "u", "job", "order_id", "series_id"]) {
    if (typeof p[k] !== "string" || !UUID_RE.test(p[k])) return fail(k);
  }
  if (!str(p.t, 64, 1)) return fail("t");
  if (!int(p.iat, 0, 1e11) || !int(p.exp, 0, 1e11) || p.exp <= p.iat) return fail("exp");
  if (p.order_number !== null && p.order_number !== undefined && !str(p.order_number, 32)) return fail("order_number");
  if (typeof p.registro !== "string" || !REGISTRO_RE.test(p.registro)) return fail("registro");
  if (!str(p.rif, 20, 3)) return fail("rif");
  if (p.src !== "auto" && p.src !== "manual") return fail("src");
  const c = p.customer ?? {};
  if (typeof c !== "object" || Array.isArray(c)) return fail("customer");
  if (c.tax_id !== undefined && c.tax_id !== null && !str(c.tax_id, 20)) return fail("customer.tax_id");
  if (c.name !== undefined && c.name !== null && !str(c.name, 120)) return fail("customer.name");
  if (!strList(c.lines, 5, 120)) return fail("customer.lines");
  if (!strList(p.comments, 3, 120)) return fail("comments");
  if (!strList(p.footer, 5, 120)) return fail("footer");
  if (!Array.isArray(p.items) || p.items.length < 1 || p.items.length > 200) return fail("items");
  let sum = 0;
  for (const it of p.items) {
    if (!it || typeof it !== "object") return fail("item");
    if (!str(it.desc, 200, 1)) return fail("item.desc");
    if (!int(it.qty_milli, 1, 99_999_999)) return fail("item.qty");
    if (!int(it.gross_cents, 0, 1e15)) return fail("item.gross");
    sum += it.gross_cents;
  }
  if (!int(p.total_cents, 1, 1e15) || sum !== p.total_cents) return fail("total");
  if (!Array.isArray(p.payments) || p.payments.length < 1 || p.payments.length > 10) return fail("payments");
  let paid = 0;
  for (const pay of p.payments) {
    if (!pay || typeof pay.code !== "string" || !FISCAL_PAYMENT_CODE_RE.test(pay.code)) return fail("payment.code");
    if (!int(pay.cents, 0, 1e15)) return fail("payment.cents");
    paid += pay.cents;
  }
  if (paid !== p.total_cents) return fail("payments_total");
  return { ok: true, plan: p };
}

/** Result statuses the app can record. */
export const RECORDABLE_STATUSES = new Set(["printed", "voided", "needs_review"]);

/**
 * Shape check of a result (the app, after verifying its signature).
 * @returns {{ ok: true, result: object } | { ok: false, error: string }}
 */
export function validateResult(r) {
  const fail = (error) => ({ ok: false, error });
  if (!r || typeof r !== "object" || r.v !== 1) return fail("result");
  for (const k of ["r", "u", "job", "order_id", "series_id"]) {
    if (typeof r[k] !== "string" || !UUID_RE.test(r[k])) return fail(k);
  }
  if (typeof r.registro !== "string" || !REGISTRO_RE.test(r.registro)) return fail("registro");
  if (!RECORDABLE_STATUSES.has(r.status)) return fail("status");
  if (!int(r.doc_number, 1, 99_999_999)) return fail("doc_number");
  if (r.z_number !== null && !int(r.z_number, 0, 99_999)) return fail("z_number");
  if (r.totals !== null) {
    const t = r.totals;
    if (!t || typeof t !== "object") return fail("totals");
    for (const k of ["total_cents", "base_cents", "tax_cents", "exempt_cents", "rate_bp"]) {
      if (!int(t[k], 0, 1e15)) return fail(`totals.${k}`);
    }
  }
  return { ok: true, result: r };
}
