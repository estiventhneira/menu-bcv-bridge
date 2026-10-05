// LAN print tokens (bridge 0.7.0) — SINGLE SOURCE for both runtimes: the app
// server signs them (src/lib/actions/lan-print.ts imports this file, the way
// escpos.ts imports raster-text.mjs) and the bridge verifies them OFFLINE.
//
// A token proves "the app vouched for this staff member of restaurant R,
// recently". The key is bridge_tokens.lan_secret (migration 277): the app
// reads it with the admin client after an in-code membership check, and the
// bridge fetches its own copies through bridge_lan_secrets() while online and
// keeps them in config.json — so verification needs no network at all.
//
// Format: v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>, the MAC taken
// over "v1.<claims>". Claims are deliberately tiny:
//   t   bridge_tokens.id the token is for (selects the secret)
//   r   restaurant id
//   u   auth user id of the staff member (logged by the bridge)
//   iat issued at, epoch seconds
//   exp expiry, epoch seconds
//
// PC clocks drift (field data: seconds to minutes, occasionally days after a
// dead CMOS battery), so verification allows a skew window on both ends.

import crypto from "node:crypto";

export const LAN_TOKEN_VERSION = "v1";
/** How long the app makes a token valid. Devices refresh well before. */
export const LAN_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;
/** Clock-skew allowance on the bridge (both iat and exp). */
export const LAN_TOKEN_SKEW_MS = 24 * 60 * 60_000;
/** Sanity cap on exp - iat: a longer-lived token was not minted by us. */
const MAX_LIFETIME_S = 31 * 24 * 60 * 60;

function mac(secret, signed) {
  return crypto.createHmac("sha256", secret).update(signed).digest("base64url");
}

/**
 * @param {string} secret  bridge_tokens.lan_secret
 * @param {{ t: string, r: string, u: string, iat: number, exp: number }} claims
 * @returns {string}
 */
export function signLanToken(secret, claims) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("lan token: missing secret");
  }
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signed = `${LAN_TOKEN_VERSION}.${body}`;
  return `${signed}.${mac(secret, signed)}`;
}

/** Claims for a fresh token, valid LAN_TOKEN_TTL_MS from `nowMs`. */
export function newLanTokenClaims({ bridgeTokenId, restaurantId, userId, nowMs = Date.now() }) {
  const iat = Math.floor(nowMs / 1000);
  return {
    t: bridgeTokenId,
    r: restaurantId,
    u: userId,
    iat,
    exp: iat + Math.floor(LAN_TOKEN_TTL_MS / 1000),
  };
}

function isClaims(c) {
  return (
    !!c &&
    typeof c === "object" &&
    typeof c.t === "string" && c.t.length > 0 &&
    typeof c.r === "string" && c.r.length > 0 &&
    typeof c.u === "string" && c.u.length > 0 &&
    Number.isFinite(c.iat) &&
    Number.isFinite(c.exp) &&
    c.exp > c.iat &&
    c.exp - c.iat <= MAX_LIFETIME_S
  );
}

/**
 * Decodes the claims WITHOUT checking the signature — only to pick which
 * secret to verify with. Never trust the result on its own.
 * @param {unknown} token
 * @returns {{ t: string, r: string, u: string, iat: number, exp: number } | null}
 */
export function peekLanTokenClaims(token) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== LAN_TOKEN_VERSION) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isClaims(claims) ? claims : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} secret
 * @param {unknown} token
 * @param {number} [nowMs]
 * @param {{ skewMs?: number }} [opts]
 * @returns {{ ok: true, claims: { t: string, r: string, u: string, iat: number, exp: number } }
 *         | { ok: false, reason: "malformed" | "bad_signature" | "expired" | "not_yet_valid" }}
 */
export function verifyLanToken(secret, token, nowMs = Date.now(), opts = {}) {
  const claims = peekLanTokenClaims(token);
  if (!claims || typeof secret !== "string" || secret.length < 16) {
    return { ok: false, reason: "malformed" };
  }
  const [version, body, sig] = /** @type {string} */ (token).split(".");
  const expected = Buffer.from(mac(secret, `${version}.${body}`), "utf8");
  const given = Buffer.from(sig, "utf8");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }
  const skew = opts.skewMs ?? LAN_TOKEN_SKEW_MS;
  if (nowMs > claims.exp * 1000 + skew) return { ok: false, reason: "expired" };
  if (nowMs < claims.iat * 1000 - skew) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, claims };
}
