// HKA fiscal protocol — status bytes and info replies (bridge 0.9.0).
//
// Info replies (S1, S2, S3, SV) are LF-separated fields after the command
// echo, sometimes with a leading space. Field widths change with flag 63 and
// differ between TFHKA's libraries and the direct protocol, so everything is
// parsed by splitting on 0x0A and trimming — never by fixed offsets
// (spec §2.4, §3).

import { decodeLatin1 } from "./hka-frame.mjs";

// ── STS1 / STS2 (spec §2.6-2.7) ─────────────────────────────────────────

const STS2_ERRORS = new Map([
  [0x41, { code: "paper_out", message: "Se acabó el papel de la máquina fiscal" }],
  [0x42, { code: "printer_mechanism", message: "Error mecánico o de papel en la máquina fiscal" }],
  [0x43, { code: "printer_mechanism", message: "Error mecánico y sin papel en la máquina fiscal" }],
  [0x48, { code: "drawer", message: "Error de la gaveta de la máquina fiscal" }],
  [0x50, { code: "invalid_command", message: "La máquina fiscal rechazó el comando (comando o valor inválido)" }],
  [0x54, { code: "invalid_tax_rate", message: "La máquina fiscal rechazó la tasa de impuesto" }],
  [0x58, { code: "no_directives", message: "La máquina fiscal no tiene directivas asignadas" }],
  [0x5c, { code: "invalid_command", message: "La máquina fiscal rechazó el comando" }],
  [0x60, { code: "fiscal_error", message: "Error fiscal en la máquina" }],
  [0x64, { code: "fiscal_memory_error", message: "Error de memoria fiscal en la máquina" }],
  [0x6c, { code: "fiscal_memory_full", message: "La memoria fiscal de la máquina está llena" }],
]);

/** STS2 errors that come from the last command, not from the hardware. */
const COMMAND_ERRORS = new Set(["invalid_command", "invalid_tax_rate", "no_directives"]);

/**
 * @typedef {{
 *   sts1: number, sts2: number,
 *   mode: "training" | "fiscal",
 *   docOpen: "none" | "fiscal" | "nonfiscal",
 *   bufferFull: boolean, mfNearFull: boolean, mfFull: boolean,
 *   ready: boolean,
 *   error: string | null, commandError: boolean, message: string | null,
 * }} HkaStatus
 */

/**
 * @param {number} sts1
 * @param {number} sts2
 * @returns {HkaStatus}
 */
export function decodeStatus(sts1, sts2) {
  // b7 = 0, b6 = 1, b5 fiscal mode, b4 MF near full, b3 MF full,
  // b2 buffer full, b1 non-fiscal doc open, b0 fiscal doc open (M83 p.15).
  const bufferFull = (sts1 & 0x04) !== 0;
  const mode = (sts1 & 0x20) !== 0 ? "fiscal" : "training";
  const docOpen = (sts1 & 0x01) !== 0 ? "fiscal" : (sts1 & 0x02) !== 0 ? "nonfiscal" : "none";
  const mfNearFull = (sts1 & 0x10) !== 0;
  const mfFull = (sts1 & 0x08) !== 0;
  const known = STS2_ERRORS.get(sts2) ?? null;
  const error = sts2 === 0x40 ? null : known?.code ?? `sts2_0x${sts2.toString(16).padStart(2, "0")}`;
  const commandError = error !== null && COMMAND_ERRORS.has(error);
  const hardwareError = error !== null && !commandError;
  let message = known?.message ?? (error ? `La máquina fiscal reportó un error (${error})` : null);
  if (!message && mfFull) message = "La memoria fiscal de la máquina está llena";
  return {
    sts1,
    sts2,
    mode,
    docOpen,
    bufferFull,
    mfNearFull,
    mfFull,
    // "Ready for the next command" = idle (0x40/0x60, near-full still works),
    // buffer not full, and no hardware fault pending. A command error in
    // STS2 describes the previous command, not the machine.
    ready: docOpen === "none" && (sts1 & 0xc0) === 0x40 && !bufferFull && !mfFull && !hardwareError,
    error,
    commandError,
    message,
  };
}

// ── info replies ────────────────────────────────────────────────────────

/**
 * Fields of an info reply after its command echo (e.g. "S1", "S2E").
 * @param {Uint8Array} data
 * @param {string} prefix
 */
export function replyFields(data, prefix) {
  let text = decodeLatin1(data);
  if (text.startsWith(prefix)) text = text.slice(prefix.length);
  const fields = text.split("\n").map((f) => f.trim());
  // "S2\n<f1>\n…" leaves an empty first field; "S2 <f1>\n…" doesn't.
  if (fields.length > 0 && fields[0] === "") fields.shift();
  while (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  return fields;
}

function digits(s, what) {
  if (typeof s !== "string" || !/^-?\d+$/.test(s)) {
    throw new Error(`hka: campo ${what} inválido (${JSON.stringify(s)})`);
  }
  return s;
}

/** Integer field. */
export function intField(s, what) {
  return Number(digits(s, what));
}

/** Amount with 2 implied decimals → integer cents. */
export function centsField(s, what) {
  const d = digits(s, what);
  // Daily totals can exceed 2^53 cents only in theory; Number keeps display
  // precision, and per-document amounts are far below it.
  return d.length > 15 ? Number(BigInt(d)) : Number(d);
}

/**
 * S1 — counters and identity (spec §3.1).
 * Field 11 is read as the daily Z counter (M83, the SDK and BIN agree; M85
 * swaps 10 and 11 — hardware checklist item 6), both kept raw.
 * @param {Uint8Array} data
 */
export function parseS1(data) {
  const f = replyFields(data, "S1");
  if (f.length < 16) throw new Error(`hka: respuesta S1 incompleta (${f.length} campos)`);
  return {
    cashier: f[0],
    dailyTotalCents: centsField(f[1], "S1.total"),
    lastFactura: intField(f[2], "S1.factura"),
    facturasToday: intField(f[3], "S1.facturas_hoy"),
    lastNotaDebito: intField(f[4], "S1.nd"),
    lastNotaCredito: intField(f[6], "S1.nc"),
    lastNoFiscal: intField(f[8], "S1.dnf"),
    fmReportCounter: intField(f[10], "S1.reportes_mf"),
    zCounter: intField(f[11], "S1.z"),
    rif: f[12],
    registro: f[13],
    time: f[14],
    date: f[15],
  };
}

/**
 * S2 / S2E / S21-S23 — the open document (spec §3.2). All zeros when no
 * document is open.
 * @param {Uint8Array} data
 * @param {string} [prefix]
 */
export function parseS2(data, prefix = "S2") {
  const f = replyFields(data, prefix);
  if (f.length < 7) throw new Error(`hka: respuesta ${prefix} incompleta (${f.length} campos)`);
  return {
    baseCents: centsField(f[0], `${prefix}.base`),
    taxCents: centsField(f[1], `${prefix}.iva`),
    articlesMilli: intField(f[3], `${prefix}.articulos`),
    dueCents: centsField(f[4], `${prefix}.por_pagar`),
    payments: intField(f[5], `${prefix}.pagos`),
    docType: /** @type {"none" | "factura" | "nota_credito" | "nota_debito"} */ (
      ["none", "factura", "nota_credito", "nota_debito"][intField(f[6], `${prefix}.tipo`)] ?? "none"
    ),
  };
}

/**
 * S3 — tax rates and the 64 flags (spec §3.3). A rate field is
 * type(1) + rate(4 = 2+2): "11600" = type 1, 16.00 %. Type 1 is read as
 * "price excludes IVA" (the PT definition; the manual's own invoice example
 * prices items net under PT1) — hardware checklist item 9.
 * @param {Uint8Array} data
 */
export function parseS3(data) {
  const f = replyFields(data, "S3");
  const flagField = f.findLast((x) => /^\d{128,}$/.test(x));
  if (!flagField) throw new Error("hka: respuesta S3 sin banderas");
  const rateFields = f.filter((x) => /^\d{5}$/.test(x));
  if (rateFields.length < 3) throw new Error(`hka: respuesta S3 con ${rateFields.length} tasas`);
  const toRate = (x) => ({ type: Number(x[0]), bp: Number(x.slice(1)) });
  const flags = [];
  for (let i = 0; i < 64; i++) flags.push(Number(flagField.slice(i * 2, i * 2 + 2)));
  return {
    rates: rateFields.slice(0, 3).map(toRate),
    igtf: rateFields.length >= 4 ? toRate(rateFields[3]) : null,
    flags,
  };
}

/** SV — model and country ("ZZP" = ACLAS PP9-PLUS, spec §3.4). */
export function parseSV(data) {
  const f = replyFields(data, "SV");
  return { model: f[0] ?? "", country: f[1] ?? "" };
}

/** RIF as compared across S1, the restaurant and the plan: J-12345678-9,
 *  J123456789 and j 12345678 9 are the same RIF. */
export function normalizeRif(rif) {
  return typeof rif === "string" ? rif.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}
