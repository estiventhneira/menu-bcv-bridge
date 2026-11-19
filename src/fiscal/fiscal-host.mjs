// Máquina fiscal host (bridge 0.9.0) — what the /lan/v1/fiscal/* routes do.
//
// The bridge PC holds the machine's COM port; every staff device on the
// restaurant WiFi issues facturas through it (design 2026-10-07). This
// module owns:
//   * machines: COM port ↔ registro ↔ restaurant, persisted in config.json
//     (`fiscal_machines`) through the injected save callback
//   * one queue per machine (one conversation at a time, TFHKA's rule); the
//     port opens on demand and closes after a minute idle so other software
//     can use it in between
//   * factura jobs: verified plans (index.mjs checks the signature) run
//     through hka-invoice.mjs, journaled at every step, deduplicated by job
//     key AND by order — two tablets can't invoice one order twice
//   * recovery of jobs cut short (boot, before the next job, every 2 min)
//   * probe / connect / test DNF / Reporte X for the settings screen
//   * 0.9.6: notas de crédito (creditNote) — the same job machinery, held
//     per factura instead of per order; a printed NC releases the factura's
//     job so the order can be invoiced again
//
// Plans are trusted here (index.mjs verified them). Results are signed with
// the injected signer so the app can tell a real machine number from a
// typed one.

import { createHkaSession } from "./hka-session.mjs";
import {
  PP9_PLUS_MODEL,
  printNoFiscal,
  printReportX,
  probeMachine,
  recoverInvoice,
  runInvoice,
} from "./hka-invoice.mjs";
import { normalizeRif, parseS1 } from "./hka-parse.mjs";

const IDLE_CLOSE_MS = 60_000;
const RECOVERY_INTERVAL_MS = 2 * 60_000;
/** How long an invoice request waits for the machine before answering
 *  in_progress (the device then polls /lan/v1/fiscal/job). */
export const INVOICE_WAIT_MS = 25_000;

const REGISTRO_RE = /^[A-Za-z0-9]{3,16}$/;

/**
 * @param {unknown} list raw `fiscal_machines` from config.json
 * @returns {Array<{ restaurant_id: string, port: string, registro: string, rif: string, model: string, connected_at: string | null }>}
 */
export function parseFiscalMachines(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m.restaurant_id !== "string" || typeof m.port !== "string" || !m.port) continue;
    if (typeof m.registro !== "string" || !REGISTRO_RE.test(m.registro)) continue;
    out.push({
      restaurant_id: m.restaurant_id,
      port: m.port,
      registro: m.registro.toUpperCase(),
      rif: typeof m.rif === "string" ? m.rif : "",
      model: typeof m.model === "string" ? m.model : "",
      connected_at: typeof m.connected_at === "string" ? m.connected_at : null,
    });
  }
  return out;
}

function within(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(undefined), ms))]);
}

/**
 * @param {{
 *   machines: ReturnType<typeof parseFiscalMachines>,
 *   saveMachines: (list: ReturnType<typeof parseFiscalMachines>) => void,
 *   openLink: (port: string) => Promise<import("./hka-session.mjs").SerialLink>,
 *   listPorts: () => Promise<Array<{ path: string, name: string, vid: string | null, pid: string | null }>>,
 *   journal: ReturnType<typeof import("./fiscal-journal.mjs").createFiscalJournal>,
 *   signResult: (bridgeTokenId: string, payload: object) => string | null,
 *   log?: (...a: unknown[]) => void,
 *   now?: () => number,
 *   sessionOptions?: object,
 *   invoiceWaitMs?: number,
 *   idleCloseMs?: number,
 * }} deps
 */
export function createFiscalHost(deps) {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const journal = deps.journal;
  const invoiceWaitMs = deps.invoiceWaitMs ?? INVOICE_WAIT_MS;
  const idleCloseMs = deps.idleCloseMs ?? IDLE_CLOSE_MS;

  /** registro → runtime */
  const runtimes = new Map();
  let machines = deps.machines.slice();

  function runtimeFor(m) {
    let rt = runtimes.get(m.registro);
    if (!rt) {
      rt = { queue: Promise.resolve(), session: null, port: m.port, idleTimer: null, last: null, busy: false };
      runtimes.set(m.registro, rt);
    }
    return rt;
  }

  function findMachine(restaurantId, registro) {
    const reg = String(registro ?? "").toUpperCase();
    return machines.find((m) => m.restaurant_id === restaurantId && m.registro === reg) ?? null;
  }

  async function closeSession(rt) {
    clearTimeout(rt.idleTimer);
    rt.idleTimer = null;
    const s = rt.session;
    rt.session = null;
    if (s) {
      try {
        await s.close();
      } catch {}
    }
  }

  async function ensureSession(m, rt) {
    if (rt.session && !rt.session.closed && rt.port === m.port) return rt.session;
    if (rt.session) await closeSession(rt);
    rt.port = m.port;
    const link = await deps.openLink(m.port);
    rt.session = createHkaSession(link, { log, ...(deps.sessionOptions ?? {}) });
    return rt.session;
  }

  /**
   * Run `fn(session)` alone on the machine. A port that won't open becomes
   * { portError } instead of a throw.
   */
  function withMachine(m, fn) {
    const rt = runtimeFor(m);
    const run = rt.queue.then(async () => {
      clearTimeout(rt.idleTimer);
      rt.busy = true;
      let session;
      try {
        session = await ensureSession(m, rt);
      } catch (e) {
        rt.busy = false;
        rt.last = { at: now(), ok: false, error: "port_unavailable", message: `No se pudo abrir ${m.port}: ${e.message}` };
        return { portError: rt.last.message };
      }
      try {
        return await fn(session);
      } catch (e) {
        // A link that died mid-conversation: drop it, the next run reopens.
        if (session.closed) await closeSession(rt);
        throw e;
      } finally {
        rt.busy = false;
        clearTimeout(rt.idleTimer);
        rt.idleTimer = setTimeout(() => void closeSession(rt), idleCloseMs);
        rt.idleTimer.unref?.();
      }
    });
    rt.queue = run.then(() => {}, () => {});
    return run;
  }

  // ── results ─────────────────────────────────────────────────────────

  const isCredit = (rec) => rec.doc === "nota_credito";

  function resultPayload(rec) {
    const o = rec.outcome;
    return {
      // v 2 for an NC: an app that only knows facturas refuses it.
      v: isCredit(rec) ? 2 : 1,
      ...(isCredit(rec)
        ? { doc: "nota_credito", credit: { document_id: rec.plan.credit.document_id, reason: rec.plan.credit.reason ?? null } }
        : {}),
      t: rec.t,
      r: rec.r,
      u: rec.u,
      job: rec.job,
      order_id: rec.order_id,
      series_id: rec.series_id,
      registro: rec.registro,
      src: rec.src,
      status: o.status,
      doc_number: o.docNumber,
      z_number: o.zNumber ?? null,
      totals: o.totals ?? null,
      review_reason: o.reviewReason ?? null,
      error: o.error ?? null,
      customer: rec.plan?.customer ?? {},
      at: now(),
      // 0.9.6: when the run started on the machine (epoch ms, this PC's
      // clock) — the document's date, which `at` isn't after a recovery.
      printed_at: rec.started_at ?? rec.created_at ?? null,
    };
  }

  function finish(rec, outcome) {
    rec.outcome = outcome;
    if (outcome.status === "interrupted") {
      rec.state = "started"; // recovery owns it
    } else {
      rec.state = "done";
      const recordable =
        (outcome.status === "printed" || outcome.status === "voided" || outcome.status === "needs_review") &&
        Number.isSafeInteger(outcome.docNumber) &&
        outcome.docNumber > 0;
      rec.result_token = recordable ? deps.signResult(rec.t, resultPayload(rec)) : null;
      if (isCredit(rec) && recordable && outcome.status !== "voided") releaseCredited(rec);
    }
    journal.save(rec);
    const noun = isCredit(rec) ? "nota de crédito" : "factura";
    log(
      `fiscal: ${rec.registro} orden ${rec.plan?.order_number ?? rec.order_id.slice(0, 8)} → ${outcome.status}` +
        `${outcome.docNumber ? ` (${noun} ${outcome.docNumber})` : ""}${outcome.error ? ` [${outcome.error}]` : ""}`,
    );
    return rec;
  }

  /** The NC `ncRec` printed: the factura job it reverses stops holding the order. */
  function releaseCredited(ncRec) {
    const credit = ncRec.plan?.credit ?? {};
    let target = credit.job ? journal.get(credit.job) : null;
    if (target && (target.r !== ncRec.r || isCredit(target))) target = null;
    if (!target) {
      // A factura job without a recorded job key: the order's holder, if it
      // printed exactly the affected number.
      const holder = journal.holderFor(ncRec.r, ncRec.order_id);
      if (
        holder &&
        !isCredit(holder) &&
        holder.outcome?.docNumber === credit.number &&
        holder.registro === String(credit.registro ?? "").toUpperCase()
      ) {
        target = holder;
      }
    }
    if (target && journal.release(target, ncRec.job)) {
      log(`fiscal: la factura ${target.outcome?.docNumber ?? "?"} quedó revertida por la nota de crédito ${ncRec.outcome?.docNumber}`);
    }
  }

  /** What a device sees for a job. */
  function view(rec) {
    if (!rec) return { ok: false, error: "unknown_job" };
    const o = rec.outcome;
    const base = { ok: true, job: rec.job, order_id: rec.order_id, doc: rec.doc ?? "factura" };
    if (rec.state === "accepted") return { ...base, status: "queued" };
    if (rec.state === "started" && (!o || o.status !== "interrupted")) return { ...base, status: "in_progress" };
    return {
      ...base,
      status: o.status,
      doc_number: o.docNumber ?? null,
      z_number: o.zNumber ?? null,
      totals: o.totals ?? null,
      error: o.error ?? null,
      message: o.message ?? null,
      review_reason: o.reviewReason ?? null,
      result: rec.result_token ?? null,
      recorded: !!rec.recorded_at,
    };
  }

  // ── recovery ────────────────────────────────────────────────────────

  async function recoverOn(session, m) {
    for (const rec of journal.inFlight()) {
      if (rec.registro !== m.registro || rec.r !== m.restaurant_id) continue;
      if (rec.state === "accepted") {
        // Queued but never started (restart before its turn): nothing was
        // sent, so it simply never happened.
        finish(rec, { status: "not_printed", error: "restarted", message: "El bridge se reinició antes de imprimir la factura." });
        continue;
      }
      const started = rec.started ?? {};
      const out = await recoverInvoice(session, {
        step: rec.step ?? "body",
        doc: rec.doc ?? "factura",
        lastFactura: started.lastFactura,
        lastNumber: started.lastNumber ?? started.lastFactura,
        zCounter: started.zCounter ?? 0,
        flag50: started.flag50 ?? 0,
        finalCode: rec.plan.payments[rec.plan.payments.length - 1].code,
        totals: rec.totals ?? null,
      });
      if (out) finish(rec, out);
    }
  }

  function pendingFor(m) {
    return journal.inFlight().some((rec) => rec.registro === m.registro && rec.r === m.restaurant_id && rec.state !== "accepted");
  }

  /** Resolve every interrupted job whose machine answers. Never throws. */
  async function recover() {
    for (const m of machines) {
      if (!pendingFor(m)) continue;
      try {
        await withMachine(m, (session) => recoverOn(session, m));
      } catch (e) {
        log(`fiscal: recuperación en ${m.registro} falló: ${e.message}`);
      }
    }
  }

  // ── the factura ─────────────────────────────────────────────────────

  /**
   * A factura (doc "factura", /lan/v1/fiscal/invoice) or a nota de crédito
   * (0.9.6, doc "nota_credito", /lan/v1/fiscal/credit-note).
   * @param {{ t: string, r: string, u: string }} claims  the LAN token's
   * @param {object} plan  verified + validated (validatePlan / validateCreditPlan)
   * @param {"factura" | "nota_credito"} doc
   * @returns {Promise<{ status: number, body: object }>}
   */
  async function submit(claims, plan, doc) {
    const same = journal.get(plan.job);
    if (same) {
      if (same.r !== claims.r || (same.doc ?? "factura") !== doc) return { status: 404, body: { ok: false, error: "unknown_job" } };
      return { status: 200, body: await waitView(same) };
    }
    const m = findMachine(claims.r, plan.registro);
    if (!m) return { status: 404, body: { ok: false, error: "unknown_machine" } };
    // Check and claim in the same tick: no await between them, so two
    // devices racing on one order (or one factura's NC) can't both get through.
    const hold = doc === "nota_credito" ? `nc:${plan.credit.document_id}` : plan.order_id;
    const holder = journal.holderFor(claims.r, hold);
    if (holder) {
      const v = view(holder);
      const inFlight = holder.state !== "done";
      return { status: inFlight ? 200 : 409, body: inFlight ? v : { ...v, ok: false, error: "already_printed" } };
    }
    const rec = journal.save({
      job: plan.job,
      r: claims.r,
      t: plan.t,
      u: plan.u,
      order_id: plan.order_id,
      series_id: plan.series_id,
      registro: m.registro,
      src: plan.src,
      ...(doc === "nota_credito" ? { doc, hold } : {}),
      plan,
      state: "accepted",
      step: null,
      started: null,
      totals: null,
      outcome: null,
      result_token: null,
      recorded_at: null,
      created_at: now(),
    });
    const run = withMachine(m, async (session) => {
      if (pendingFor(m)) await recoverOn(session, m);
      rec.state = "started";
      rec.started_at = now();
      journal.save(rec);
      const outcome = await runInvoice(session, plan, {
        log,
        onStep: (step, data) => {
          rec.step = step;
          if (step === "body") {
            rec.started = {
              lastFactura: data.lastFactura,
              lastNumber: data.lastNumber ?? data.lastFactura,
              zCounter: data.zCounter,
              flag21: data.flag21,
              flag50: data.flag50,
              taxType: data.rate?.type ?? null,
              rateBp: data.rate?.bp ?? null,
            };
          }
          if (step === "paying") rec.totals = data.totals;
          journal.save(rec); // durable before the next command goes out
        },
      });
      return finish(rec, outcome);
    }).then(
      (r) => (r && r.portError ? finish(rec, { status: "blocked", error: "port_unavailable", message: r.portError }) : r),
      (e) => finish(rec, { status: "interrupted", error: "link", message: `Se perdió la conexión con la máquina (${e.message}).` }),
    );
    void run;
    return { status: 200, body: await waitView(rec, run) };
  }

  async function waitView(rec, run) {
    if (rec.state === "done") return view(rec);
    await within(run ?? Promise.resolve(), run ? invoiceWaitMs : 0);
    return view(journal.get(rec.job));
  }

  // ── status / setup ──────────────────────────────────────────────────

  function machineSummary(m) {
    const rt = runtimes.get(m.registro);
    return {
      registro: m.registro,
      model: m.model,
      port: m.port,
      busy: !!rt?.busy,
      last: rt?.last ?? null,
    };
  }

  /** Light summary for /lan/v1/hello. */
  function summary(restaurantId) {
    return {
      machines: machines.filter((m) => m.restaurant_id === restaurantId).map((m) => ({ registro: m.registro, model: m.model })),
      unrecorded: journal.unrecorded(restaurantId).length,
    };
  }

  /**
   * Machines of the restaurant; `live` asks each one (ENQ + S1) unless it's
   * busy printing, in which case the cached status stands.
   */
  async function status(restaurantId, { live = false } = {}) {
    const mine = machines.filter((m) => m.restaurant_id === restaurantId);
    if (live) {
      await Promise.all(
        mine.map(async (m) => {
          const rt = runtimeFor(m);
          if (rt.busy) return;
          await within(
            withMachine(m, async (session) => {
              const st = await session.enq();
              rt.last = st
                ? { at: now(), ok: st.ready, sts: st, error: st.ready ? null : st.error ?? (st.docOpen !== "none" ? "document_open" : "not_ready"), message: st.message }
                : { at: now(), ok: false, error: "no_response", message: "La máquina fiscal no responde." };
              if (st) {
                try {
                  const s1 = parseS1(await session.read("S1"));
                  rt.last.lastFactura = s1.lastFactura;
                  rt.last.zCounter = s1.zCounter;
                } catch {}
              }
            }),
            8_000,
          );
        }),
      );
    }
    return {
      machines: mine.map(machineSummary),
      unrecorded: journal.unrecorded(restaurantId).map((rec) => ({ job: rec.job, order_id: rec.order_id, result: rec.result_token })),
      in_flight: journal.inFlight().filter((rec) => rec.r === restaurantId).map((rec) => view(rec)),
    };
  }

  async function ports() {
    const list = await deps.listPorts();
    return list.map((p) => {
      const m = machines.find((x) => x.port === p.path);
      return { ...p, registro: m?.registro ?? null };
    });
  }

  /**
   * Probe a port (reads only) and, when asked and everything matches, save
   * it as this restaurant's machine for `registro`.
   */
  async function connect(restaurantId, { port, registro, rif, save }) {
    const existing = machines.find((m) => m.port === port);
    if (existing && existing.restaurant_id !== restaurantId) {
      return { ok: false, error: "port_taken", message: "Ese puerto ya está conectado a la máquina de otro restaurante." };
    }
    const probeTarget = existing ?? { restaurant_id: restaurantId, port, registro: `PROBE${port.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 16) };
    const r = await withMachine(probeTarget, (session) => probeMachine(session));
    if (r.portError) return { ok: false, error: "port_unavailable", message: r.portError };
    if (!r.ok) return { ok: false, error: r.error, message: r.message };
    const identity = {
      model: r.model,
      country: r.country,
      registro: r.s1.registro,
      rif: r.s1.rif,
      lastFactura: r.s1.lastFactura,
      lastNotaCredito: r.s1.lastNotaCredito,
      lastNoFiscal: r.s1.lastNoFiscal,
      zCounter: r.s1.zCounter,
      fmReportCounter: r.s1.fmReportCounter,
      date: r.s1.date,
      time: r.s1.time,
      mode: r.status.mode,
      ready: r.status.ready,
      statusMessage: r.status.message,
      flags: { 21: r.s3.flags[21], 50: r.s3.flags[50], 63: r.s3.flags[63] },
      rates: r.s3.rates,
      igtf: r.s3.igtf,
    };
    const match = {
      model: identity.model === PP9_PLUS_MODEL,
      registro: identity.registro.toUpperCase() === String(registro ?? "").toUpperCase(),
      rif: normalizeRif(identity.rif) === normalizeRif(rif),
    };
    let saved = false;
    if (save && match.model && match.registro && match.rif) {
      const entry = {
        restaurant_id: restaurantId,
        port,
        registro: identity.registro.toUpperCase(),
        rif: identity.rif,
        model: identity.model,
        connected_at: new Date(now()).toISOString(),
      };
      machines = [...machines.filter((m) => m.registro !== entry.registro && m.port !== port), entry];
      deps.saveMachines(machines);
      saved = true;
      log(`fiscal: máquina ${entry.registro} conectada en ${port}`);
    }
    if (!existing) {
      // The probe ran under a placeholder registro: release its port now
      // (a saved machine reopens it under its own queue).
      const rt = runtimes.get(probeTarget.registro);
      if (rt) await closeSession(rt);
      runtimes.delete(probeTarget.registro);
    }
    return { ok: true, identity, match, saved };
  }

  async function disconnect(restaurantId, registro) {
    const m = findMachine(restaurantId, registro);
    if (!m) return { ok: false, error: "unknown_machine" };
    machines = machines.filter((x) => x !== m);
    const rt = runtimes.get(m.registro);
    if (rt) {
      await rt.queue;
      await closeSession(rt);
      runtimes.delete(m.registro);
    }
    deps.saveMachines(machines);
    log(`fiscal: máquina ${m.registro} desconectada`);
    return { ok: true };
  }

  async function safeOp(restaurantId, registro, fn) {
    const m = findMachine(restaurantId, registro);
    if (!m) return { ok: false, error: "unknown_machine" };
    const r = await withMachine(m, async (session) => {
      if (pendingFor(m)) await recoverOn(session, m);
      return fn(session);
    });
    if (r.portError) return { ok: false, error: "port_unavailable", message: r.portError };
    return r;
  }

  const recoveryTimer = setInterval(() => {
    if (machines.some(pendingFor)) void recover();
  }, RECOVERY_INTERVAL_MS);
  recoveryTimer.unref?.();

  return {
    get machines() {
      return machines.slice();
    },
    /** A factura printing or queued: self-update must wait. */
    busy() {
      return [...runtimes.values()].some((rt) => rt.busy) || journal.inFlight().some((rec) => rec.state === "accepted");
    },
    summary,
    status,
    ports,
    connect,
    disconnect,
    invoice: (claims, plan) => submit(claims, plan, "factura"),
    creditNote: (claims, plan) => submit(claims, plan, "nota_credito"),
    job: (restaurantId, jobKey) => {
      const rec = journal.get(jobKey);
      return rec && rec.r === restaurantId ? view(rec) : { ok: false, error: "unknown_job" };
    },
    ack: (restaurantId, jobKeys) => journal.markRecorded(restaurantId, jobKeys),
    test: (restaurantId, registro, lines) => safeOp(restaurantId, registro, (s) => printNoFiscal(s, lines)),
    reportX: (restaurantId, registro) => safeOp(restaurantId, registro, (s) => printReportX(s)),
    recover,
    async close() {
      clearInterval(recoveryTimer);
      for (const rt of runtimes.values()) await closeSession(rt);
    },
  };
}
