// Typings for fiscal-plan.mjs — the single-source máquina fiscal payloads the
// app server imports directly (src/lib/fiscal-printer/*.server.ts). Keep in sync.

export type FiscalKind = "plan" | "result" | "receipt";

export interface FiscalPlanItem {
  desc: string;
  /** Quantity × 1000. */
  qty_milli: number;
  /** Line total in Bs cents, IVA included (D1). */
  gross_cents: number;
  /** 0.9.6 (392): the line's rate. Absent = "G" (tasa general, D1); "E" =
   *  exento (the propina line), only in a v 3 factura plan or a v 2 NC. */
  tax?: "G" | "E";
}

export interface FiscalPlanPayment {
  /** Printer payment code 01-19 (never the divisa codes 20-24, D2). */
  code: string;
  cents: number;
}

export interface FiscalPlan {
  /** 3 when (and only when) a line is exento (392), so bridges ≤ 0.9.5 refuse it. */
  v: 1 | 3;
  doc?: "factura";
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

/** 0.9.6: the factura a nota de crédito reverses, as its header prints it. */
export interface FiscalCreditTarget {
  /** sales_fiscal_documents.id of the factura. */
  document_id: string;
  /** The factura's machine number (iF*). */
  number: number;
  /** "DD/MM/AAAA" (iD*). */
  date: string;
  /** Registro of the machine that printed the factura (iI*). */
  registro: string;
  /** The factura's bridge job, when the bridge printed it (releases the order). */
  job?: string | null;
  /** The motivo (also printed in the footer), echoed in the result. */
  reason?: string | null;
}

/** 0.9.6: a nota de crédito plan — v 2, so bridges ≤ 0.9.5 refuse it. */
export interface FiscalCreditPlan extends Omit<FiscalPlan, "v" | "doc"> {
  v: 2;
  doc: "nota_credito";
  credit: FiscalCreditTarget;
  customer: { tax_id: string; name: string; lines?: string[] };
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
  /** 1 = factura, 2 = nota de crédito (doc + credit set). */
  v: 1 | 2;
  doc?: "factura" | "nota_credito";
  credit?: { document_id: string; reason?: string | null } | null;
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
  /** 0.9.6: when the run started on the machine (epoch ms, bridge clock). */
  printed_at?: number | null;
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
export const FISCAL_CREDIT_DATE_RE: RegExp;
export const FISCAL_ITEM_TAXES: Set<string>;
export const FISCAL_PLAN_V_EXEMPT: 3;
export function planHasExemptLine(p: { items?: ReadonlyArray<{ tax?: string }> } | null | undefined): boolean;
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
export function validateCreditPlan(p: unknown): { ok: true; plan: FiscalCreditPlan } | { ok: false; error: string };
export function validateResult(r: unknown): { ok: true; result: FiscalResult } | { ok: false; error: string };
