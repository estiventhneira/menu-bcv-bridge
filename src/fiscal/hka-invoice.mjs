// HKA fiscal protocol — the factura run, recovery, probe and reports
// (bridge 0.9.0). Pure over an HkaSession: no disk, no network — the host
// (fiscal-host.mjs) journals through the hooks.
//
// Sequence (spec §4.7, design 2026-10-07):
//   ENQ until idle → S1 (registro + RIF, N) → S3 (flag 21, flag 50, tasa 1)
//   → [journal: body] → customer, comments, items, footer → 3 → S2 reconcile
//   → [journal: paying] → 2MM… → 1MM → 199 (flag 50 = 01)
//   → ENQ until idle → S1 must read N+1.
//
// Never resend a command that changes the machine. When one fails:
//   * before any payment: cancel with 7 ([journal: cancelling] first) —
//     prints FACTURA ANULADA and burns the number if the document opened;
//   * after a payment: the document can no longer be cancelled (M85 p.22),
//     so it is finished with the plan's last payment code.
// The journal step tells recovery what an N+1 means after a crash: an
// issued factura (paying) or a voided one (body / cancelling — a factura
// can't close without being paid).
//
// 0.9.6: the same run prints a nota de crédito (plan.doc = "nota_credito",
// spec §6): the header iF*/iD*/iI* + iR*/iS* goes first, items are d1…
// lines, no comment line, and N is S1's NC counter (field 6), which moves
// on its own — a factura and an NC never share a number. Before paying, S2
// must not say "factura": an NC the machine opened as a factura is
// cancelled, never paid.

import {
  CANCEL,
  CLOSE,
  REPORT_X,
  SUBTOTAL,
  commentCommand,
  creditHeaderCommands,
  customerCommands,
  footerCommands,
  fullPaymentCommand,
  itemCommand,
  noFiscalCommands,
  partialPaymentCommand,
  widthsForFlag21,
} from "./hka-commands.mjs";
import { isTaxIncluded, normalizeRif, parseS1, parseS2, parseS3, parseSV } from "./hka-parse.mjs";

/** @typedef {"factura" | "nota_credito"} FiscalDoc */

/** @returns {FiscalDoc} */
export function docOf(plan) {
  return plan?.doc === "nota_credito" ? "nota_credito" : "factura";
}

/** The machine counter a document of `doc` advances (S1 field 2 / 6). */
export function numberOf(s1, doc) {
  return doc === "nota_credito" ? s1.lastNotaCredito : s1.lastFactura;
}

/** A factura message, worded for the document at hand. */
function forDoc(text, doc) {
  if (doc !== "nota_credito" || typeof text !== "string") return text;
  return text.replaceAll("facturas", "notas de crédito").replaceAll("factura", "nota de crédito");
}

/** SV model code of the ACLAS PP9-PLUS. */
export const PP9_PLUS_MODEL = "ZZP";

/** Machine total vs plan total: max(1 Bs, 0.1 %). */
export function totalTolerance(totalCents) {
  return Math.max(100, Math.round(totalCents / 1000));
}

// ── money (D1: every line at tasa 1, prices IVA-inclusive; 392: the ─────
// propina, when the restaurant bills it, as an exento line) ──────────────

/** round(a / b), half up, bigints ≥ 0. */
function divRound(a, b) {
  return (a * 2n + b) / (b * 2n);
}

/** IVA the machine computes on an accumulated base (bp = 1600 for 16 %). */
export function taxOnBase(baseCents, bp) {
  return Number(divRound(BigInt(baseCents) * BigInt(bp), 10000n));
}

/**
 * The net base B whose B + IVA(B) equals `totalCents`. Not every total is
 * reachable (one more cent of base adds 1 or 2 cents of total), so the
 * nearest is used then — the final 1MM pays the machine's own figure anyway.
 */
export function netBaseFor(totalCents, bp) {
  const guess = Number(divRound(BigInt(totalCents) * 10000n, 10000n + BigInt(bp)));
  let best = guess;
  let bestDiff = Infinity;
  for (let b = Math.max(0, guess - 3); b <= guess + 3; b++) {
    const diff = Math.abs(b + taxOnBase(b, bp) - totalCents);
    if (diff < bestDiff) {
      best = b;
      bestDiff = diff;
    }
  }
  return { base: best, exact: bestDiff === 0 };
}

/** Split `total` (integer) proportionally to `weights` (largest remainder). */
export function spread(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) {
    const out = weights.map(() => 0);
    if (out.length) out[out.length - 1] = total;
    return out;
  }
  const raw = weights.map((w) => (BigInt(total) * BigInt(w)) / BigInt(sum));
  const out = raw.map(Number);
  let left = total - out.reduce((s, v) => s + v, 0);
  const order = weights
    .map((w, i) => ({ i, rem: Number((BigInt(total) * BigInt(w)) % BigInt(sum)) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i]++;
  return out;
}

/**
 * Item lines as the machine must receive them, and the total it will
 * compute from them. 0.9.6 (392): an exento line (tax "E", the propina)
 * goes at its own price, outside the tasa-general base.
 * @param {Array<{ desc: string, qty_milli: number, gross_cents: number, tax?: "G" | "E" }>} items
 * @param {number} totalCents  Σ gross_cents
 * @param {{ type: number, bp: number }} rate  tasa 1 from S3
 * @param {import("./hka-commands.mjs").Widths} w
 */
export function machineLines(items, totalCents, rate, w) {
  const included = isTaxIncluded(rate.type);
  const exempt = items.map((it) => it.tax === "E");
  const exemptGross = items.reduce((s, it, i) => (exempt[i] ? s + it.gross_cents : s), 0);
  const net = included
    ? null
    : spread(
        netBaseFor(totalCents - exemptGross, rate.bp).base,
        items.map((it, i) => (exempt[i] ? 0 : it.gross_cents)),
      );
  const unit = 10n ** BigInt(w.priceDec);
  let taxed = 0;
  let exemptCents = 0;
  const lines = items.map((it, i) => {
    const target = exempt[i] || !net ? it.gross_cents : net[i];
    const qty = BigInt(it.qty_milli);
    // price (field scale) = target / qty, rounded; the machine's line amount
    // is price × qty rounded to cents.
    const priceScaled = divRound(BigInt(target) * unit * 1000n, 100n * qty);
    const amountCents = Number(divRound(priceScaled * qty * 100n, unit * 1000n));
    if (exempt[i]) exemptCents += amountCents;
    else taxed += amountCents;
    return { tax: exempt[i] ? "E" : "G", priceScaled, qtyMilli: it.qty_milli, description: it.desc, amountCents };
  });
  return {
    lines,
    expectedTotal: (included ? taxed : taxed + taxOnBase(taxed, rate.bp)) + exemptCents,
    exemptCents,
  };
}

// ── outcomes ────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   status: "printed" | "voided" | "needs_review" | "not_printed" | "blocked" | "interrupted",
 *   docNumber?: number | null, zNumber?: number | null,
 *   totals?: { total_cents: number, base_cents: number, tax_cents: number, exempt_cents: number, rate_bp: number } | null,
 *   error?: string, message?: string, reviewReason?: string, warnings?: string[],
 *   mismatch?: { machine_due_cents: number, machine_base_cents: number, machine_tax_cents: number,
 *     plan_total_cents: number, expected_cents: number, tax_type: number, rate_bp: number },
 * }} InvoiceOutcome
 *
 *   printed       the factura is on the machine with docNumber
 *   voided        a document opened and was cancelled: docNumber is burned
 *   needs_review  a factura exists (docNumber) but the run didn't go as
 *                 planned (payments merged, totals not captured, …)
 *   not_printed   nothing consumed a number; safe to retry
 *   blocked       refused before sending anything to the document
 *   interrupted   the machine stopped answering mid-document: the journal
 *                 stays open and recovery resolves it later
 */

const MESSAGES = {
  no_response: "La máquina fiscal no responde. Revisa que esté encendida y conectada al bridge.",
  document_open: "La máquina fiscal tiene un documento abierto. Espera a que el bridge lo resuelva y reintenta.",
  rejected: "La máquina fiscal rechazó la factura.",
  timeout: "La máquina fiscal dejó de responder mientras imprimía la factura.",
  total_mismatch: "El total de la máquina no cuadró con el cobro: la factura se anuló en la máquina.",
  wrong_machine: "La máquina conectada no es la de esta serie.",
  wrong_rif: "El RIF de la máquina no es el del restaurante.",
  journal: "El bridge no pudo guardar el registro de la factura: se anuló en la máquina.",
  recovered: "La factura quedó a medias (el bridge o la máquina se reiniciaron) y se resolvió en la máquina.",
  // No "factura" in it on purpose: forDoc rewords every NC message.
  wrong_document: "La máquina abrió otro tipo de documento en lugar de la nota de crédito: se anuló sin cobrar.",
};

/**
 * Wait for idle; an open documento no fiscal (ours, cut short) is closed
 * with 810 first — it has no fiscal effect and would block every factura.
 */
async function idleClosingNoFiscal(session, maxMs) {
  let st = await session.waitIdle({ maxMs });
  if (st?.docOpen === "nonfiscal") {
    await session.command("810", "print");
    st = await session.waitIdle({ maxMs });
  }
  return st;
}

/** 175287 → "1752,87" (the machine's own format, no thousands mark). */
function bs(cents) {
  return (cents / 100).toFixed(2).replace(".", ",");
}

function blocked(error, message) {
  return { status: "blocked", error, message: message ?? MESSAGES[error] ?? "La máquina fiscal no está lista." };
}

async function readS1(session) {
  return parseS1(await session.read("S1"));
}

// ── the run ─────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof import("./hka-session.mjs").createHkaSession>} session
 * @param {{ registro: string, rif: string, customer?: object, comments?: string[],
 *   items: Array<{ desc: string, qty_milli: number, gross_cents: number }>,
 *   footer?: string[], payments: Array<{ code: string, cents: number }>, total_cents: number,
 *   doc?: "factura" | "nota_credito", credit?: { number: number, date: string, registro: string } }} plan
 * @param {{ onStep?: (step: "body" | "paying" | "cancelling", data: object) => Promise<void> | void,
 *   log?: (...a: unknown[]) => void }} [hooks]
 * @returns {Promise<InvoiceOutcome>}
 */
export async function runInvoice(session, plan, hooks = {}) {
  const doc = docOf(plan);
  const out = await runDocument(session, plan, doc, hooks);
  return doc === "factura" || typeof out.message !== "string" || out.verbatim
    ? out
    : { ...out, message: forDoc(out.message, doc) };
}

async function runDocument(session, plan, doc, hooks) {
  const onStep = hooks.onStep ?? (() => {});

  // 1. Preflight — nothing reaches a document until all of it passes.
  const st = await idleClosingNoFiscal(session, 15_000);
  if (!st) return blocked("no_response");
  if (st.docOpen !== "none") return blocked("document_open");
  if (!st.ready) return blocked(st.error ?? "not_ready", st.message ?? undefined);

  let s1;
  let s3;
  try {
    s1 = await readS1(session);
    s3 = parseS3(await session.read("S3"));
  } catch (e) {
    return blocked("no_response", `La máquina fiscal no respondió sus datos (${e.message}).`);
  }
  if (s1.registro.trim().toUpperCase() !== String(plan.registro).trim().toUpperCase()) {
    return blocked("wrong_machine", `La máquina conectada es ${s1.registro}, no ${plan.registro}.`);
  }
  if (normalizeRif(s1.rif) !== normalizeRif(plan.rif)) {
    return blocked("wrong_rif", `El RIF de la máquina (${s1.rif}) no es el del restaurante (${plan.rif}).`);
  }
  let widths;
  try {
    widths = widthsForFlag21(s3.flags[21]);
  } catch {
    return blocked("unsupported_flag21", `La máquina usa la bandera 21 = ${s3.flags[21]}, que el bridge no soporta.`);
  }
  const rate = s3.rates[0];
  if (!rate || rate.bp <= 0) return blocked("no_tax_rate", "La máquina no tiene programada la tasa general de IVA.");
  if (rate.type !== 1 && rate.type !== 2) {
    return blocked("unknown_tax_type", `Tipo de tasa desconocido en la máquina (${rate.type}).`);
  }
  const flag50 = s3.flags[50] === 1;

  const pays = plan.payments.filter((p) => p.cents > 0);
  if (pays.length === 0) pays.push(plan.payments[plan.payments.length - 1]);
  let commands;
  let lines;
  try {
    lines = machineLines(plan.items, plan.total_cents, rate, widths);
    const customer = customerCommands(plan.customer);
    if (doc === "nota_credito" && !(customer.some((c) => c.startsWith("iR*")) && customer.some((c) => c.startsWith("iS*")))) {
      throw new Error("la nota de crédito necesita RIF y nombre del cliente");
    }
    commands = [
      ...(doc === "nota_credito" ? creditHeaderCommands(plan.credit) : []),
      ...customer,
      ...(doc === "factura" ? (plan.comments ?? []).map(commentCommand).filter(Boolean) : []),
      ...lines.lines.map((l) =>
        itemCommand({ tax: l.tax, priceScaled: l.priceScaled, qtyMilli: l.qtyMilli, description: l.description }, widths, doc),
      ),
      ...footerCommands(plan.footer),
    ];
    for (const p of pays) fullPaymentCommand(p.code); // validates every code now
  } catch (e) {
    return blocked("invalid_plan", `No se pudo preparar la factura: ${e.message}`);
  }

  const N = numberOf(s1, doc);
  const ctx = {
    doc,
    N,
    // An NC's run also watches the factura counter (wrong_document).
    lastFactura: s1.lastFactura,
    zNumber: s1.zCounter + 1,
    flag50,
    finalCode: pays[pays.length - 1].code,
    totals: null,
    onStep,
  };
  try {
    await onStep("body", {
      doc,
      lastNumber: N,
      lastFactura: s1.lastFactura,
      zCounter: s1.zCounter,
      flag21: widths.flag21,
      flag50: flag50 ? 1 : 0,
      rate,
    });
  } catch {
    return blocked("journal", "El bridge no pudo guardar el registro de la factura. Revisa el disco de la PC.");
  }

  // 2. Document body.
  for (const cmd of commands) {
    const r = await session.command(cmd, "entry");
    if (r !== "ack") return abortBeforePayment(session, ctx, r === "nak" ? "rejected" : "timeout");
  }
  if ((await session.command(SUBTOTAL, "print")) !== "ack") return abortBeforePayment(session, ctx, "rejected");

  // 3. Reconcile with the machine's own figures before any payment.
  let s2;
  try {
    s2 = parseS2(await session.read("S2"));
  } catch {
    return abortBeforePayment(session, ctx, "timeout");
  }
  if (doc === "nota_credito" && s2.docType === "factura") {
    hooks.log?.("fiscal: la máquina abrió una factura en lugar de la nota de crédito — se anula sin cobrar");
    return abortBeforePayment(session, ctx, "wrong_document");
  }
  if (Math.abs(s2.dueCents - plan.total_cents) > totalTolerance(plan.total_cents)) {
    // Kept in the outcome (the job file on the PC) and the message: the
    // console window is the only other place these figures ever appear.
    const mismatch = {
      machine_due_cents: s2.dueCents,
      machine_base_cents: s2.baseCents,
      machine_tax_cents: s2.taxCents,
      plan_total_cents: plan.total_cents,
      expected_cents: lines.expectedTotal,
      tax_type: rate.type,
      rate_bp: rate.bp,
    };
    hooks.log?.(
      `fiscal: total de la máquina ${s2.dueCents} (base ${s2.baseCents} + IVA ${s2.taxCents}) ≠ plan ${plan.total_cents}` +
        ` (esperado ${lines.expectedTotal}, tasa tipo ${rate.type})`,
    );
    const out = await abortBeforePayment(session, ctx, "total_mismatch");
    const figures = ` (máquina Bs ${bs(s2.dueCents)}, cobro Bs ${bs(plan.total_cents)})`;
    return { ...out, mismatch, ...(out.error === "total_mismatch" ? { message: `${out.message}${figures}` } : {}) };
  }
  // An exento line's amount is its price × qty, exactly what the machine
  // bills, so the tasa-general base is what remains of the total after IVA:
  // right whether or not S2's base field counts the exento part.
  ctx.totals = {
    total_cents: s2.dueCents,
    base_cents: lines.exemptCents > 0 ? Math.max(0, s2.dueCents - s2.taxCents - lines.exemptCents) : s2.baseCents,
    tax_cents: s2.taxCents,
    exempt_cents: lines.exemptCents,
    rate_bp: rate.bp,
  };

  // 4. Payments. From the first one on, the document can't be cancelled.
  try {
    await onStep("paying", { totals: ctx.totals });
  } catch {
    return abortBeforePayment(session, ctx, "journal");
  }
  let due = s2.dueCents;
  let finalCode = ctx.finalCode;
  for (let i = 0; i < pays.length - 1; i++) {
    const p = pays[i];
    if (p.cents >= due) {
      // It would close the document; let the final 1MM pay with its code.
      finalCode = p.code;
      break;
    }
    const r = await session.command(partialPaymentCommand(p.code, p.cents, widths), "print");
    if (r !== "ack") return finishAfterPayment(session, { ...ctx, finalCode }, "payment_failed");
    try {
      due = parseS2(await session.read("S2")).dueCents;
    } catch {
      return finishAfterPayment(session, { ...ctx, finalCode }, "payment_failed");
    }
    if (due <= 0) break;
  }
  if (due > 0 && (await session.command(fullPaymentCommand(finalCode), "print")) !== "ack") {
    return finishAfterPayment(session, { ...ctx, finalCode }, "payment_failed");
  }
  if (flag50 && (await session.command(CLOSE, "print")) !== "ack") {
    return finishAfterPayment(session, { ...ctx, finalCode }, "close_failed");
  }

  // 5. Confirm: idle again, and the counter moved by exactly one.
  const idle = await session.waitIdle({ maxMs: 90_000, stopOnOpenDocument: false });
  if (!idle || idle.docOpen !== "none") return finishAfterPayment(session, { ...ctx, finalCode }, "close_failed");
  let after;
  try {
    after = await readS1(session);
  } catch {
    return { status: "interrupted", error: "no_response", message: MESSAGES.timeout, totals: ctx.totals };
  }
  return confirmIssued(after, ctx, null);
}

/** After the document closed with payments: what S1 says happened. */
function confirmIssued(after, ctx, reviewReason) {
  const n = numberOf(after, ctx.doc);
  if (n === ctx.N + 1) {
    return reviewReason
      ? { status: "needs_review", docNumber: ctx.N + 1, zNumber: ctx.zNumber, totals: ctx.totals, reviewReason }
      : { status: "printed", docNumber: ctx.N + 1, zNumber: ctx.zNumber, totals: ctx.totals };
  }
  if (n > ctx.N + 1) {
    return {
      status: "needs_review",
      docNumber: n,
      zNumber: ctx.zNumber,
      totals: ctx.totals,
      reviewReason: "number_jumped",
      message: `La máquina avanzó de ${ctx.N} a ${n}: otro programa imprimió facturas.`,
    };
  }
  return {
    status: "needs_review",
    docNumber: null,
    totals: ctx.totals,
    reviewReason: "number_not_advanced",
    message: "La máquina aceptó la factura pero no avanzó su número. Revisa la máquina.",
  };
}

/** A command failed before any payment: cancel the document (never resend). */
async function abortBeforePayment(session, ctx, reason) {
  const message = MESSAGES[reason] ?? MESSAGES.rejected;
  const st = await session.waitIdle({ maxMs: 20_000 });
  if (!st) return { status: "interrupted", error: "no_response", message: MESSAGES.timeout };
  try {
    if (st.docOpen === "fiscal") {
      const s2 = parseS2(await session.read("S2"));
      if (s2.payments > 0) return finishAfterPayment(session, ctx, reason);
      await ctx.onStep("cancelling", { reason });
      if ((await session.command(CANCEL, "print")) !== "ack") {
        return { status: "interrupted", error: "cancel_failed", message: "No se pudo anular el documento abierto en la máquina." };
      }
      await session.waitIdle({ maxMs: 30_000, stopOnOpenDocument: false });
    }
    const after = await readS1(session);
    if (reason === "wrong_document" && Number.isSafeInteger(ctx.lastFactura) && after.lastFactura > ctx.lastFactura) {
      // The machine had opened a FACTURA: 7 burned a factura number, not an
      // NC's. needs_review without a number holds this NC (no retry burns
      // another one) until a person looks at the machine.
      return {
        status: "needs_review",
        docNumber: null,
        error: reason,
        reviewReason: "wrong_document",
        burnedFactura: after.lastFactura,
        message: `La máquina abrió una factura en lugar de la nota de crédito y quedó anulada (factura Nº ${after.lastFactura}). Revisa la máquina antes de reintentar.`,
        verbatim: true,
      };
    }
    const n = numberOf(after, ctx.doc);
    if (n === ctx.N) return { status: "not_printed", error: reason, message };
    if (n === ctx.N + 1) {
      return { status: "voided", docNumber: ctx.N + 1, zNumber: ctx.zNumber, error: reason, message };
    }
    return {
      status: "needs_review",
      docNumber: null,
      error: reason,
      reviewReason: "number_jumped",
      message: `La máquina avanzó de ${ctx.N} a ${n} sin factura de este cobro.`,
    };
  } catch (e) {
    return { status: "interrupted", error: "no_response", message: `${MESSAGES.timeout} (${e.message})` };
  }
}

/** Payments were applied: finish the document with the last payment code. */
async function finishAfterPayment(session, ctx, reason) {
  try {
    const st = await session.waitIdle({ maxMs: 20_000 });
    if (!st) return { status: "interrupted", error: "no_response", message: MESSAGES.timeout, totals: ctx.totals };
    if (st.docOpen === "fiscal") {
      const s2 = parseS2(await session.read("S2"));
      if (s2.dueCents > 0 && (await session.command(fullPaymentCommand(ctx.finalCode), "print")) !== "ack") {
        return { status: "interrupted", error: reason, message: MESSAGES.timeout, totals: ctx.totals };
      }
      if (ctx.flag50 && (await session.command(CLOSE, "print")) !== "ack") {
        return { status: "interrupted", error: reason, message: MESSAGES.timeout, totals: ctx.totals };
      }
      await session.waitIdle({ maxMs: 90_000, stopOnOpenDocument: false });
    }
    return confirmIssued(await readS1(session), ctx, reason);
  } catch (e) {
    return { status: "interrupted", error: "no_response", message: `${MESSAGES.timeout} (${e.message})`, totals: ctx.totals };
  }
}

/**
 * Resolve a job whose run never finished (bridge restart, link lost).
 * @param {object} session
 * @param {{ step: "body" | "paying" | "cancelling", lastFactura: number, zCounter: number,
 *   flag50: number, finalCode: string, totals: object | null,
 *   doc?: "factura" | "nota_credito", lastNumber?: number }} rec
 *   0.9.6: doc + lastNumber (the counter of that document); a journal from
 *   0.9.5 has only lastFactura, which is a factura's lastNumber.
 * @returns {Promise<InvoiceOutcome | null>} null while the machine doesn't answer
 */
export async function recoverInvoice(session, rec) {
  const doc = rec.doc === "nota_credito" ? "nota_credito" : "factura";
  const out = await recoverDocument(session, rec, doc);
  return !out || doc === "factura" || typeof out.message !== "string" ? out : { ...out, message: forDoc(out.message, doc) };
}

async function recoverDocument(session, rec, doc) {
  const st = await session.waitIdle({ maxMs: 15_000 });
  if (!st) return null;
  const ctx = {
    doc,
    N: Number.isSafeInteger(rec.lastNumber) ? rec.lastNumber : rec.lastFactura,
    zNumber: rec.zCounter + 1,
    flag50: rec.flag50 === 1,
    finalCode: rec.finalCode,
    totals: rec.totals ?? null,
    onStep: async () => {},
  };
  if (st.docOpen === "fiscal") {
    // Still open: cancel if unpaid, finish if any payment went through.
    return abortBeforePayment(session, ctx, "recovered");
  }
  try {
    const n = numberOf(await readS1(session), doc);
    if (n === ctx.N) return { status: "not_printed", error: "recovered", message: "La factura no llegó a imprimirse." };
    if (n === ctx.N + 1) {
      // Closed while we were away. Only a paid document closes on its own;
      // before the payment step the only way out was 7.
      return rec.step === "paying"
        ? { status: "needs_review", docNumber: ctx.N + 1, zNumber: ctx.zNumber, totals: ctx.totals, reviewReason: "recovered" }
        : { status: "voided", docNumber: ctx.N + 1, zNumber: ctx.zNumber, error: "recovered", message: "El documento quedó anulado en la máquina." };
    }
    return {
      status: "needs_review",
      docNumber: null,
      totals: ctx.totals,
      reviewReason: "number_jumped",
      message: `La máquina avanzó de ${ctx.N} a ${n} mientras el bridge estaba fuera.`,
    };
  } catch {
    return null;
  }
}

// ── safe operations (fine on a fiscalized unit) ─────────────────────────

/** ENQ, SV, S1, S3 — reads only. */
export async function probeMachine(session) {
  const status = await session.enq();
  if (!status) return { ok: false, error: "no_response", message: MESSAGES.no_response };
  try {
    const sv = parseSV(await session.read("SV"));
    const s1 = await readS1(session);
    const s3 = parseS3(await session.read("S3"));
    return { ok: true, status, model: sv.model, country: sv.country, s1, s3 };
  } catch (e) {
    return { ok: false, error: "no_response", message: `La máquina no respondió sus datos (${e.message}).`, status };
  }
}

/** Documento no fiscal (the printer adds its own header and marks). */
export async function printNoFiscal(session, lines) {
  const st = await idleClosingNoFiscal(session, 15_000);
  if (!st) return { ok: false, error: "no_response", message: MESSAGES.no_response };
  if (!st.ready) return { ok: false, error: st.error ?? "not_ready", message: st.message ?? MESSAGES.document_open };
  for (const cmd of noFiscalCommands(lines)) {
    const r = await session.command(cmd, cmd.startsWith("81") ? "print" : "entry");
    if (r !== "ack") {
      await session.command("810", "print"); // close whatever opened
      return { ok: false, error: r, message: "La máquina rechazó el documento de prueba." };
    }
  }
  await session.waitIdle({ maxMs: 30_000, stopOnOpenDocument: false });
  return { ok: true };
}

/** Reporte X (current day, changes nothing). */
export async function printReportX(session) {
  const st = await idleClosingNoFiscal(session, 15_000);
  if (!st) return { ok: false, error: "no_response", message: MESSAGES.no_response };
  if (!st.ready) return { ok: false, error: st.error ?? "not_ready", message: st.message ?? MESSAGES.document_open };
  const r = await session.command(REPORT_X, "print");
  if (r !== "ack") return { ok: false, error: r, message: "La máquina rechazó el Reporte X." };
  await session.waitIdle({ maxMs: 60_000, stopOnOpenDocument: false });
  return { ok: true };
}
