// Typings for lan-token.mjs — the single-source LAN token signer/verifier the
// app server imports directly (src/lib/actions/lan-print.ts). Keep in sync.

export interface LanTokenClaims {
  /** bridge_tokens.id the token is for. */
  t: string;
  /** Restaurant id. */
  r: string;
  /** Staff auth user id. */
  u: string;
  /** Issued at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

export const LAN_TOKEN_VERSION: "v1";
export const LAN_TOKEN_TTL_MS: number;
export const LAN_TOKEN_SKEW_MS: number;

export function signLanToken(secret: string, claims: LanTokenClaims): string;
export function newLanTokenClaims(args: {
  bridgeTokenId: string;
  restaurantId: string;
  userId: string;
  nowMs?: number;
}): LanTokenClaims;
export function peekLanTokenClaims(token: unknown): LanTokenClaims | null;
export function verifyLanToken(
  secret: string,
  token: unknown,
  nowMs?: number,
  opts?: { skewMs?: number },
):
  | { ok: true; claims: LanTokenClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "not_yet_valid" };
