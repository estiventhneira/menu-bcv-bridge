// A fake ACLAS PP9-PLUS behind the SerialLink interface (bridge 0.9.0).
//
// The real machines are legal records (the founder's test unit is fiscalized
// with a real RIF), so every flow is exercised here first: the unit tests
// drive it directly, and FUJUN_FISCAL_SIMULATOR=<RIF>[:<registro>] exposes it
// as a "SIMULADOR" port so the whole app can be tried end to end.
//
// It models what the protocol spec documents: STS1/STS2, S1/S2/S3/SV
// replies, the factura state machine (customer lines → items → 3 → payments
// → close, 7 only before any payment), flag 21 widths, flag 50 (199
// mandatory), tax type 1 = price excludes IVA / 2 = includes it, documentos
// no fiscales and Reporte X. Faults can be injected per command: NAK,
// swallowed (busy), executed-but-unanswered, paper out, and a crash after N
// commands (the cable pulled; reconnect() keeps the open document, as the
// real machine's battery does).

import { ACK, NAK, buildFrame, decodeLatin1, replyBytes } from "./hka-frame.mjs";
import { createFrameReader } from "./hka-reader.mjs";
import { assertAllowed, widthsForFlag21 } from "./hka-commands.mjs";

const PRINTING = /^(?:3|2\d{2}\d+|1\d{2}|7|81.*|I0X)$/;
const RATE_INDEX = { " ": 0, "!": 1, '"': 2, "#": 3, "$": 4 };

function pad(n, width) {
  return String(Math.max(0, Math.trunc(n))).padStart(width, "0").slice(-width);
}

/** round(a / b) half up, for non-negative bigints. */
function divRound(a, b) {
  return (a * 2n + b) / (b * 2n);
}

/**
 * @param {{ registro?: string, rif?: string, mode?: "fiscal" | "training",
 *   flag21?: number, flag50?: number, flag63?: number,
 *   rates?: Array<{ type: number, bp: number }>,
 *   lastFactura?: number, lastNoFiscal?: number, zCounter?: number,
 *   printDelayMs?: number, latencyMs?: number,
 *   taxSemantics?: "excluded" | "included" }} [opts]
 *   taxSemantics overrides what the S3 tax type means — models the spec's
 *   open question (§3.3: is type 1 "excluded" or "included"?)
 */
export function createHkaSimulator(opts = {}) {
  const flags = new Array(64).fill(0);
  flags[21] = opts.flag21 ?? 0;
  flags[50] = opts.flag50 ?? 0;
  flags[63] = opts.flag63 ?? 0;

  const state = {
    registro: opts.registro ?? "ZZP0000001",
    rif: opts.rif ?? "J000000000",
    model: "ZZP",
    mode: opts.mode ?? "fiscal",
    flags,
    rates: opts.rates ?? [
      { type: 1, bp: 1600 },
      { type: 1, bp: 800 },
      { type: 1, bp: 3100 },
    ],
    counters: {
      factura: opts.lastFactura ?? 100,
      facturasToday: 0,
      nc: 0,
      nd: 0,
      dnf: opts.lastNoFiscal ?? 50,
      z: opts.zCounter ?? 10,
      fmReports: 3,
      dailyTotal: 0,
    },
    sts2: 0x40,
    paperOut: false,
    /** @type {null | { kind: "factura" | "dnf", items: number, amounts: number[],
     *   paid: number, payments: Array<{ code: string, cents: number }>,
     *   subtotal: boolean, lines: string[], customer: string[] }} */
    doc: null,
    busyUntil: 0,
  };

  /** Everything the machine "printed", in order. */
  const paper = [];
  /** Every command received (strings), in order. */
  const received = [];
  /** Commands outside the allowlist that reached the machine (must stay empty). */
  const forbidden = [];

  /** @type {Array<{ re: RegExp, kind: "nak" | "swallow" | "lost_ack" | "paper_out" }>} */
  const faults = [];
  let crashAfter = null;
  let alive = true;
  let listeners = [];
  let closeListeners = [];
  const printDelayMs = opts.printDelayMs ?? 0;
  const latencyMs = opts.latencyMs ?? 0;

  function emit(bytes) {
    if (!alive) return;
    const deliver = () => {
      if (!alive) return;
      for (const cb of listeners) cb(bytes);
    };
    if (latencyMs > 0) setTimeout(deliver, latencyMs);
    else queueMicrotask(deliver);
  }
  const ACK_REPLY = { reply: "ack" };
  const ack = () => ACK_REPLY;
  const nak = (sts2 = 0x50) => ({ reply: "nak", sts2 });
  const replyText = (text) => emit(buildFrame(replyBytes(text)));

  function sts1() {
    let s = state.mode === "fiscal" ? 0x60 : 0x40;
    if (state.doc?.kind === "factura") s |= 0x01;
    if (state.doc?.kind === "dnf") s |= 0x02;
    return s;
  }

  function totals() {
    const amounts = state.doc?.amounts ?? [0, 0, 0, 0, 0];
    let base = 0;
    let tax = 0;
    const byRate = [];
    amounts.forEach((amt, idx) => {
      if (idx === 0 || idx === 4 || amt === 0) {
        base += amt;
        byRate[idx] = { base: amt, tax: 0 };
        return;
      }
      const r = state.rates[idx - 1];
      const a = BigInt(amt);
      const bp = BigInt(r.bp);
      const included = opts.taxSemantics ? opts.taxSemantics === "included" : r.type === 2;
      // Tax on the ACCUMULATED base per rate (spec §4.2).
      const t = included ? Number(divRound(a * bp, 10000n + bp)) : Number(divRound(a * bp, 10000n));
      const b = included ? amt - t : amt;
      base += b;
      tax += t;
      byRate[idx] = { base: b, tax: t };
    });
    return { base, tax, total: base + tax, byRate };
  }

  function closeFactura() {
    const tot = totals();
    state.counters.factura++;
    state.counters.facturasToday++;
    state.counters.dailyTotal += tot.total;
    paper.push({
      kind: "factura",
      number: state.counters.factura,
      z: state.counters.z + 1,
      total: tot.total,
      base: tot.base,
      tax: tot.tax,
      payments: state.doc.payments.slice(),
      lines: state.doc.lines.slice(),
      customer: state.doc.customer.slice(),
    });
    state.doc = null;
  }

  function openFactura() {
    state.doc = { kind: "factura", items: 0, amounts: [0, 0, 0, 0, 0], paid: 0, payments: [], subtotal: false, lines: [], customer: [] };
  }

  function s2Text(prefix, part) {
    const w = state.flags[63] % 2 === 1 ? 17 : 13;
    if (!state.doc || state.doc.kind !== "factura") {
      return `${prefix}\n${[pad(0, w), pad(0, w), pad(0, w), pad(0, 6), pad(0, w), pad(0, 4), "0"].join("\n")}`;
    }
    const tot = totals();
    const sel = part ?? { base: tot.base, tax: tot.tax };
    const due = Math.max(0, tot.total - state.doc.paid);
    return `${prefix}\n${[
      pad(sel.base, w),
      pad(sel.tax, w),
      pad(0, w),
      pad(state.doc.items * 1000, 6),
      pad(due, w),
      pad(state.doc.payments.length, 4),
      "1",
    ].join("\n")}`;
  }

  function handleRead(cmd) {
    const c = state.counters;
    if (cmd === "S1") {
      replyText(
        "S101\n" +
          [
            pad(c.dailyTotal, 17),
            pad(c.factura, 8),
            pad(c.facturasToday, 5),
            pad(c.nd, 8),
            pad(0, 5),
            pad(c.nc, 8),
            pad(0, 5),
            pad(c.dnf, 8),
            pad(0, 5),
            pad(c.fmReports, 4),
            pad(c.z, 4),
            state.rif,
            state.registro,
            "120000",
            "071026",
          ].join("\n"),
      );
    } else if (cmd === "S2") {
      replyText(s2Text("S2"));
    } else if (cmd === "S2E" || /^S2[1-3]$/.test(cmd)) {
      const idx = cmd === "S2E" ? 0 : Number(cmd[2]);
      const part = totals().byRate[idx] ?? { base: 0, tax: 0 };
      replyText(s2Text(cmd, part));
    } else if (cmd === "S3") {
      const rates = state.rates.map((r) => `${r.type}${pad(r.bp, 4)}`);
      if (state.flags[63] >= 16 && state.flags[63] <= 19) rates.push("10300");
      replyText(`S3${rates.join("\n")}\n${state.flags.map((f) => pad(f, 2)).join("")}`);
    } else if (cmd === "SV") {
      replyText(`SV\n${state.model}\nVE`);
    }
  }

  function payAmount(cmd) {
    const w = widthsForFlag21(state.flags[21]);
    const digits = cmd.slice(3);
    const expect = w.payInt + w.payDec;
    if (digits.length !== expect) return null;
    const scaled = BigInt(digits);
    return Number(w.payDec >= 2 ? scaled / 10n ** BigInt(w.payDec - 2) : scaled * 10n ** BigInt(2 - w.payDec));
  }

  function execute(cmd) {
    const doc = state.doc;
    if (cmd === "S1" || cmd === "S2" || cmd === "S2E" || /^S2[1-3]$/.test(cmd) || cmd === "S3" || cmd === "SV") {
      handleRead(cmd);
      return { reply: "none" };
    }
    if (state.paperOut && PRINTING.test(cmd)) return nak(0x41);
    if (/^iR\*|^iS\*/.test(cmd)) {
      if (doc?.kind === "dnf" || (doc && doc.items > 0)) return nak();
      if (!doc) openFactura();
      state.doc.customer.push(cmd.slice(3));
      return ack();
    }
    if (/^i0\d/.test(cmd)) {
      if (doc?.kind === "dnf" || doc?.payments.length) return nak();
      if (!doc) openFactura();
      (state.doc.items > 0 ? state.doc.lines : state.doc.customer).push(cmd.slice(3));
      return ack();
    }
    if (cmd.startsWith("@")) {
      if (doc?.kind === "dnf" || doc?.payments.length) return nak();
      if (!doc) openFactura();
      state.doc.lines.push(`|${cmd.slice(1)}|`);
      return ack();
    }
    if (cmd[0] in RATE_INDEX && /^[ !"#$]\d{18}/.test(cmd)) {
      if (doc?.kind === "dnf" || doc?.payments.length || doc?.subtotal) return nak();
      const w = widthsForFlag21(state.flags[21]);
      const pw = w.priceInt + w.priceDec;
      const qw = w.qtyInt + w.qtyDec;
      const price = BigInt(cmd.slice(1, 1 + pw));
      const qty = BigInt(cmd.slice(1 + pw, 1 + pw + qw));
      const desc = cmd.slice(1 + pw + qw);
      if (qty <= 0n || !desc) return nak();
      const idx = RATE_INDEX[cmd[0]];
      if (idx >= 1 && idx <= 3 && state.rates[idx - 1].bp === 0) return nak(0x54);
      // amount (cents) = price × qty, both fixed point, rounded half up
      const scale = 10n ** BigInt(w.priceDec) * 1000n;
      const amount = Number(divRound(price * qty * 100n, scale));
      if (!doc) openFactura();
      state.doc.items++;
      state.doc.amounts[idx] += amount;
      state.doc.lines.push(`${desc} x${Number(qty) / 1000} = ${amount}`);
      return ack();
    }
    if (cmd === "3") {
      if (!doc || doc.kind !== "factura" || doc.items === 0) return nak();
      doc.subtotal = true;
      return ack();
    }
    if (/^2\d{2}\d+$/.test(cmd)) {
      if (!doc || doc.kind !== "factura" || doc.items === 0) return nak();
      const code = Number(cmd.slice(1, 3));
      if (code >= 20 && state.flags[50] !== 1) return nak();
      const cents = payAmount(cmd);
      if (cents === null) return nak();
      doc.paid += cents;
      doc.payments.push({ code: cmd.slice(1, 3), cents });
      if (doc.paid >= totals().total && state.flags[50] !== 1) closeFactura();
      return ack();
    }
    if (cmd === "199") {
      if (!doc) return state.flags[50] === 1 ? nak() : ack();
      if (doc.kind !== "factura" || doc.paid < totals().total) return nak();
      closeFactura();
      return ack();
    }
    if (/^1\d{2}$/.test(cmd)) {
      if (!doc || doc.kind !== "factura" || doc.items === 0) return nak();
      const code = Number(cmd.slice(1, 3));
      if (code >= 20 && state.flags[50] !== 1) return nak();
      const due = totals().total - doc.paid;
      doc.paid += Math.max(0, due);
      doc.payments.push({ code: cmd.slice(1, 3), cents: Math.max(0, due) });
      if (state.flags[50] !== 1) closeFactura();
      return ack();
    }
    if (cmd === "7") {
      if (!doc || doc.kind !== "factura" || doc.payments.length > 0) return nak();
      state.counters.factura++;
      paper.push({ kind: "anulada", number: state.counters.factura, lines: doc.lines.slice() });
      state.doc = null;
      return ack();
    }
    if (/^8[01]/.test(cmd)) {
      if (doc?.kind === "factura") return nak();
      if (!doc) state.doc = { kind: "dnf", items: 0, amounts: [0, 0, 0, 0, 0], paid: 0, payments: [], subtotal: false, lines: [], customer: [] };
      state.doc.lines.push(cmd.slice(3));
      if (cmd[1] === "1") {
        state.counters.dnf++;
        paper.push({ kind: "dnf", number: state.counters.dnf, lines: state.doc.lines.slice() });
        state.doc = null;
      }
      return ack();
    }
    if (cmd === "I0X") {
      if (doc) return nak();
      state.counters.dnf++;
      paper.push({ kind: "report_x", number: state.counters.dnf });
      return ack();
    }
    return nak(0x5c);
  }

  function send(result) {
    if (result.reply === "ack") {
      state.sts2 = 0x40;
      emit(Uint8Array.of(ACK));
    } else if (result.reply === "nak") {
      state.sts2 = result.sts2;
      emit(Uint8Array.of(NAK));
    }
  }

  function handleCommand(cmd) {
    received.push(cmd);
    if (crashAfter !== null) {
      if (crashAfter <= 0) {
        alive = false;
        return;
      }
      crashAfter--;
    }
    try {
      assertAllowed(cmd);
    } catch {
      forbidden.push(cmd);
      send(nak(0x5c));
      return;
    }
    const fi = faults.findIndex((f) => f.re.test(cmd));
    const fault = fi >= 0 ? faults.splice(fi, 1)[0] : null;
    if (fault?.kind === "nak") return send(nak());
    if (fault?.kind === "swallow") return;
    if (fault?.kind === "paper_out") {
      state.paperOut = true;
      return send(nak(0x41));
    }
    const result = execute(cmd);
    if (fault?.kind === "lost_ack") return; // it ran; the answer never arrives
    if (result.reply === "ack" && PRINTING.test(cmd) && printDelayMs > 0) {
      // Busy printing: ENQ gets no answer and the ACK comes when it's done.
      state.busyUntil = Date.now() + printDelayMs;
      setTimeout(() => send(result), printDelayMs);
      return;
    }
    send(result);
  }

  const reader = createFrameReader((ev) => {
    if (!alive) return;
    if (ev.type === "enq") {
      if (Date.now() < state.busyUntil) return; // busy printing: no answer
      const s2 = state.paperOut ? 0x41 : state.sts2;
      emit(buildFrame(Uint8Array.of(sts1(), s2)));
    } else if (ev.type === "frame") {
      if (!ev.lrcOk) return send(nak());
      handleCommand(decodeLatin1(ev.data));
    }
  });

  function makeLink() {
    return {
      write(bytes) {
        if (!alive) return;
        reader.push(bytes);
      },
      onData(cb) {
        listeners.push(cb);
      },
      onClose(cb) {
        closeListeners.push(cb);
      },
      async close() {
        listeners = [];
        closeListeners = [];
      },
    };
  }

  let link = makeLink();

  return {
    get link() {
      return link;
    },
    state,
    paper,
    received,
    forbidden,
    /** Inject a one-shot fault on the next command matching `re`. */
    fault(re, kind) {
      faults.push({ re, kind });
    },
    /** Stop answering anything after `n` more commands (cable pulled). */
    crashAfter(n) {
      crashAfter = n;
    },
    /** Plug the cable back in: a fresh link, the same machine state. A crash
     *  that already happened is over; one still counting down stays armed. */
    reconnect() {
      reader.reset();
      alive = true;
      if (crashAfter !== null && crashAfter <= 0) crashAfter = null;
      listeners = [];
      closeListeners = [];
      link = makeLink();
      return link;
    },
    /** Reload paper (clears paper out). */
    reloadPaper() {
      state.paperOut = false;
      state.sts2 = 0x40;
    },
    totals,
  };
}
