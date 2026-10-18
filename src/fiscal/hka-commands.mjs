// HKA fiscal protocol — command builders and the allowlist (bridge 0.9.0).
//
// The founder's test PP9-PLUS is fiscalized with a REAL RIF, and every
// restaurant's machine is a legal record. So the bridge can only ever build
// the commands below; anything else — Reporte Z (I0Z), flag writes (PJ), tax
// rates (PT/Pt), date/time (PG/PF), static header (PH), payment names (PE),
// cash withdrawals (9…), reprints and audit reads — throws before a byte
// leaves the process. The session re-checks every frame it writes.
//
//   ENQ (a raw byte, not a frame)
//   S1 S2 S2E S21 S22 S23 S3 SV        reads
//   iR* iS* i00..i09                   customer and info lines
//   @                                  comment
//   <tax><price><qty><description>     item, widths per flag 21
//   3                                  subtotal
//   2MM<amount>  1MM                   payments, MM = 01..19 only (D2: never
//                                      the divisa codes 20-24, so never IGTF)
//   199                                close (mandatory with flag 50 = 01)
//   7                                  cancel the open document
//   80<attr><text>  81<attr><text>     documento no fiscal
//   I0X                                Reporte X

import { sanitizeText } from "./hka-frame.mjs";

export class ForbiddenCommandError extends Error {
  constructor(command) {
    super(`hka: comando no permitido (${JSON.stringify(String(command).slice(0, 12))})`);
    this.name = "ForbiddenCommandError";
  }
}

/** Printable Latin-1 (what sanitizeText produces). */
const TEXT = "[\\x20-\\x7E\\xA0-\\xFF]";

export const READ_COMMANDS = new Set(["S1", "S2", "S2E", "S21", "S22", "S23", "S3", "SV"]);

const ALLOWED = [
  new RegExp(`^iR\\*${TEXT}{1,40}$`),
  new RegExp(`^iS\\*${TEXT}{1,40}$`),
  new RegExp(`^i0[0-9]${TEXT}{0,40}$`),
  new RegExp(`^@${TEXT}{0,40}$`),
  // Item: tax char, then price+qty digits (10+8 for flag 21 = 00/01/02/11/12,
  // 16+17 for 30), then a description.
  new RegExp(`^[ !"#$](?:[0-9]{18}|[0-9]{33})${TEXT}{1,120}$`),
  /^3$/,
  /^2(?:0[1-9]|1[0-9])(?:[0-9]{12}|[0-9]{17})$/,
  /^1(?:0[1-9]|1[0-9])$/,
  /^199$/,
  /^7$/,
  new RegExp(`^8[01][0*!$> ]${TEXT}{0,40}$`),
  /^I0X$/,
];

/** Throws ForbiddenCommandError unless `command` is on the allowlist. */
export function assertAllowed(command) {
  if (typeof command !== "string") throw new ForbiddenCommandError(command);
  if (READ_COMMANDS.has(command)) return command;
  if (ALLOWED.some((re) => re.test(command))) return command;
  throw new ForbiddenCommandError(command);
}

// ── numeric widths (flag 21, spec §4.2) ─────────────────────────────────

/**
 * @typedef {{ flag21: number, priceInt: number, priceDec: number,
 *   qtyInt: number, qtyDec: number, payInt: number, payDec: number }} Widths
 */

const WIDTHS = {
  0: [8, 2, 5, 3, 10, 2],
  1: [7, 3, 5, 3, 10, 2],
  2: [6, 4, 5, 3, 10, 2],
  11: [9, 1, 5, 3, 10, 2],
  12: [10, 0, 5, 3, 10, 2],
  30: [14, 2, 14, 3, 15, 2],
};

/** @returns {Widths} — throws on a flag value we don't know (never guess). */
export function widthsForFlag21(flag21) {
  const w = WIDTHS[flag21];
  if (!w) throw new Error(`hka: bandera 21 = ${flag21} no soportada`);
  const [priceInt, priceDec, qtyInt, qtyDec, payInt, payDec] = w;
  return { flag21, priceInt, priceDec, qtyInt, qtyDec, payInt, payDec };
}

/**
 * Zero-padded fixed-point field. `scaled` is an integer in units of
 * 10^-dec (a bigint or a safe integer).
 */
export function fixedField(scaled, intDigits, decDigits) {
  const v = BigInt(scaled);
  if (v < 0n) throw new Error("hka: monto negativo");
  const width = intDigits + decDigits;
  const s = v.toString();
  if (s.length > width) throw new Error(`hka: monto ${s} no cabe en ${intDigits}+${decDigits} dígitos`);
  return s.padStart(width, "0");
}

/** Cents → the price field's scale (rounding half up when the field has
 *  fewer than 2 decimals). */
export function centsToScale(cents, dec) {
  const c = BigInt(cents);
  if (dec >= 2) return c * 10n ** BigInt(dec - 2);
  const div = 10n ** BigInt(2 - dec);
  return (c * 2n + div) / (div * 2n);
}

// ── builders ────────────────────────────────────────────────────────────

const TAX_CHARS = { E: " ", G: "!", R: '"', A: "#", P: "$" };

/** Item description width: the printer wraps up to 120 chars; one line keeps
 *  facturas short (chars per line is hardware checklist item 11). */
export const ITEM_DESC_MAX = 40;

/**
 * @param {{ tax: "E" | "G" | "R" | "A" | "P", priceScaled: bigint | number,
 *   qtyMilli: number, description: string }} item  priceScaled in the
 *   price field's own scale (centsToScale)
 * @param {Widths} w
 */
export function itemCommand(item, w) {
  const taxChar = TAX_CHARS[item.tax];
  if (taxChar === undefined) throw new Error(`hka: tasa ${item.tax} desconocida`);
  if (!Number.isSafeInteger(item.qtyMilli) || item.qtyMilli <= 0) throw new Error("hka: cantidad inválida");
  const desc = sanitizeText(item.description, ITEM_DESC_MAX) || "Producto";
  const cmd =
    taxChar +
    fixedField(item.priceScaled, w.priceInt, w.priceDec) +
    fixedField(item.qtyMilli, w.qtyInt, w.qtyDec) +
    desc;
  return assertAllowed(cmd);
}

/** Customer header lines: RIF/CI, razón social, then up to 5 extra lines
 *  (i00-i04) — sent before the first item they print in the header. */
export function customerCommands(customer) {
  const out = [];
  const taxId = sanitizeText(customer?.tax_id, 20);
  const name = sanitizeText(customer?.name, 34);
  if (taxId) out.push(assertAllowed(`iR*${taxId}`));
  if (name) out.push(assertAllowed(`iS*${name}`));
  const lines = Array.isArray(customer?.lines) ? customer.lines : [];
  let n = 0;
  for (const line of lines) {
    const text = sanitizeText(line, 40);
    if (!text || n > 4) continue;
    out.push(assertAllowed(`i0${n}${text}`));
    n++;
  }
  return out;
}

/** Footer info lines i05-i09 — sent after the last item. */
export function footerCommands(lines) {
  const out = [];
  let n = 5;
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = sanitizeText(line, 40);
    if (!text || n > 9) continue;
    out.push(assertAllowed(`i0${n}${text}`));
    n++;
  }
  return out;
}

export function commentCommand(text) {
  const t = sanitizeText(text, 40);
  return t ? assertAllowed(`@${t}`) : null;
}

export const SUBTOTAL = "3";
export const CLOSE = "199";
export const CANCEL = "7";
export const REPORT_X = "I0X";

const PAY_CODE_RE = /^(?:0[1-9]|1[0-9])$/;

/** Partial payment `2MM<amount>` (closes the document when it covers the
 *  balance — callers keep non-final tenders under it). */
export function partialPaymentCommand(code, cents, w) {
  if (!PAY_CODE_RE.test(code)) throw new ForbiddenCommandError(`2${code}`);
  return assertAllowed(`2${code}${fixedField(centsToScale(cents, w.payDec), w.payInt, w.payDec)}`);
}

/** `1MM`: pay the whole remaining balance with method MM. */
export function fullPaymentCommand(code) {
  if (!PAY_CODE_RE.test(code)) throw new ForbiddenCommandError(`1${code}`);
  return assertAllowed(`1${code}`);
}

/** Documento no fiscal lines; the last one closes it (`81`). The SDK and the
 *  demo use "0" as the normal attribute. */
export function noFiscalCommands(lines) {
  const texts = (Array.isArray(lines) ? lines : []).map((l) => sanitizeText(l, 40)).filter(Boolean);
  if (texts.length === 0) texts.push("Documento de prueba");
  return texts.map((t, i) => assertAllowed(`${i === texts.length - 1 ? "81" : "80"}0${t}`));
}
