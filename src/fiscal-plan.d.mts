// Typings for fiscal-plan.mjs — the single-source máquina fiscal payloads the
// app server imports directly (src/lib/fiscal-printer/*.server.ts). Keep in sync.

export type FiscalKind = "plan" | "result" | "receipt";

export interface FiscalPlanItem {
  desc: string;
  /** Quantity × 1000. */
  qty_milli: number;
  /** Line total in Bs cents, IVA included (D1). */
  gross_cents: number;
}

export interface FiscalPlanPayment {
  /** Printer payment code 01-19 (never the divisa codes 20-24, D2). */
  code: string;
  cents: number;
}

export interface FiscalPlan {
  v: 1;
  /** bridge_tokens.id the plan is signed for. */
  t: string;
  /** Restaurant id. */
  r: string;
  /** Staff member who asked for the factura. */
  u: string;
  /** Epoch seconds. */
  iat: number;
  exp: number;
  /** Job key (UUID): idempotency on the bridge and on record. */
  job: string;
  order_id: string;
  order_number: string | null;
  series_id: string;
  /** Machine registro the serie belongs to (checked against S1). */
  registro: string;
  /** Restaurant RIF (checked against S1). */
  rif: string;
  /** auto = at cobro, manual = issued later. */
  src: "auto" | "manual";
  customer: { tax_id?: string | null; name?: string | null; lines?: string[] };
  comments: string[];
  items: FiscalPlanItem[];
  footer: string[];
  payments: FiscalPlanPayment[];
  total_cents: number;
}

export interface FiscalTotals {
  total_cents: number;
  base_cents: number;
  tax_cents: number;
  exempt_cents: number;
  /** Tasa 1 in basis points (1600 = 16 %). */
  rate_bp: number;
}

export interface FiscalResult {
  v: 1;
  t: string;
  r: string;
  u: string;
  job: string;
  order_id: string;
  series_id: string;
  registro: string;
  src: "auto" | "manual";
  status: "printed" | "voided" | "needs_review";
  doc_number: number;
  z_number: number | null;
  totals: FiscalTotals | null;
  review_reason: string | null;
  error: string | null;
  customer: FiscalPlan["customer"];
  /** Epoch ms on the bridge's clock. */
  at: number;
}

export interface FiscalReceipt {
  v: 1;
  t: string;
  r: string;
  jobs: string[];
  iat: number;
}

export const FISCAL_SIG_VERSION: "f1";
export const FISCAL_KINDS: Set<FiscalKind>;
export const FISCAL_PLAN_TTL_MS: number;
export const FISCAL_SKEW_MS: number;
export const FISCAL_PAYMENT_CODE_RE: RegExp;
export const RECORDABLE_STATUSES: Set<string>;

export function signFiscal(secret: string, kind: FiscalKind, payload: object): string;
export function peekFiscal(token: unknown): { kind: string; payload: Record<string, unknown> } | null;
export function verifyFiscal(
  secret: string,
  kind: FiscalKind,
  token: unknown,
  nowMs?: number,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: "malformed" | "wrong_kind" | "bad_signature" | "expired" | "not_yet_valid" };
export function validatePlan(p: unknown): { ok: true; plan: FiscalPlan } | { ok: false; error: string };
export function validateResult(r: unknown): { ok: true; result: FiscalResult } | { ok: false; error: string };
