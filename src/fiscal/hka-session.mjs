// HKA fiscal protocol — one conversation with one machine (bridge 0.9.0).
//
// TFHKA's rule: a single synchronized thread drives the printer (M85 p.83).
// So: one long-lived reader fed by the link, one exchange at a time, a
// timeout per exchange, and NO automatic resend of anything that changes the
// machine. A command that times out may still have run (the PP9 prints
// slowly and answers nothing while busy), so callers reconcile with ENQ and
// S2 instead of retrying (spec §2.5). Only ENQ and the S* reads are retried.
//
// A link is anything with write(bytes) and onData(cb): the COM-port helper
// process (serial-link.mjs) or the simulator (hka-simulator.mjs).

import { ENQ, frameCommand } from "./hka-frame.mjs";
import { createFrameReader } from "./hka-reader.mjs";
import { assertAllowed, READ_COMMANDS } from "./hka-commands.mjs";
import { decodeStatus } from "./hka-parse.mjs";

export const HKA_TIMEOUTS = {
  /** ENQ → STS1 STS2 (SDK: 50 ms + 1 s). */
  enq: 1_000,
  /** S* info reads. */
  read: 2_500,
  /** Data entry: customer lines, comments, items. */
  entry: 5_000,
  /** Commands that print a lot or close a document: 3, payments, 199, 7,
   *  DNF lines, I0X. BIN-PY polls up to 90 s. */
  print: 60_000,
  /** Pause between ENQ polls while waiting for idle. */
  poll: 400,
};

export class HkaLinkClosedError extends Error {
  constructor() {
    super("hka: se cerró la conexión con la máquina fiscal");
    this.name = "HkaLinkClosedError";
  }
}

/**
 * @typedef {{ write(bytes: Uint8Array): unknown, onData(cb: (bytes: Uint8Array) => void): void,
 *   onClose?(cb: (reason?: string) => void): void, close(): Promise<void> | void }} SerialLink
 */

/**
 * @param {SerialLink} link
 * @param {{ log?: (...a: unknown[]) => void, timeouts?: Partial<typeof HKA_TIMEOUTS>,
 *   sleep?: (ms: number) => Promise<void>, maxWaitMs?: number }} [opts]
 *   maxWaitMs caps every waitIdle (tests; production leaves it unset)
 */
export function createHkaSession(link, opts = {}) {
  const log = opts.log ?? (() => {});
  const t = { ...HKA_TIMEOUTS, ...(opts.timeouts ?? {}) };
  const maxWaitCap = opts.maxWaitMs ?? Infinity;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let closed = false;

  /** @type {null | { expect: "status" | "frame" | "ack", done: (v: any) => void }} */
  let waiter = null;

  const reader = createFrameReader((ev) => {
    if (!waiter) {
      // A late reply to an exchange that timed out. Dropping it is the
      // point: the caller already treated that exchange as unknown.
      if (ev.type !== "noise") log(`fiscal: respuesta tardía ignorada (${ev.type})`);
      return;
    }
    const w = waiter;
    if (w.expect === "ack") {
      if (ev.type === "ack") w.done("ack");
      else if (ev.type === "nak") w.done("nak");
    } else if (w.expect === "status") {
      if (ev.type === "frame" && ev.data.length === 2 && ev.lrcOk) w.done({ sts1: ev.data[0], sts2: ev.data[1] });
      else if (ev.type === "frame") w.done("bad");
    } else if (ev.type === "frame") {
      w.done(ev.lrcOk ? ev.data : "bad");
    } else if (ev.type === "nak") {
      w.done("nak");
    }
  });
  link.onData((bytes) => reader.push(bytes));
  link.onClose?.(() => {
    closed = true;
    waiter?.done("closed");
  });

  // Exchanges never overlap, even if a caller forgets to await.
  let chain = Promise.resolve();
  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Write `bytes` and wait for one reply of the expected kind.
   * @returns {Promise<any>} the reply, "nak", "bad", "timeout" or "closed"
   */
  function exchange(bytes, expect, timeoutMs) {
    return exclusive(
      () =>
        new Promise((resolve) => {
          if (closed) {
            resolve("closed");
            return;
          }
          reader.reset();
          let settled = false;
          const timer = setTimeout(() => done("timeout"), timeoutMs);
          function done(v) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (waiter === w) waiter = null;
            resolve(v);
          }
          const w = { expect, done };
          waiter = w;
          try {
            const r = link.write(bytes);
            if (r && typeof r.then === "function") r.then(undefined, () => done("closed"));
          } catch {
            done("closed");
          }
        }),
    );
  }

  function throwIfClosed(v) {
    if (v === "closed") throw new HkaLinkClosedError();
    return v;
  }

  /** ENQ → decoded status, or null when the machine doesn't answer (busy
   *  printing, off, unplugged). Retried: ENQ changes nothing. */
  async function enq({ attempts = 3 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const r = throwIfClosed(await exchange(Uint8Array.of(ENQ), "status", t.enq));
      if (r && typeof r === "object") return decodeStatus(r.sts1, r.sts2);
    }
    return null;
  }

  return {
    get closed() {
      return closed;
    },

    enq,

    /** S* read → reply data bytes. Throws when the machine never answers. */
    async read(command, { attempts = 3 } = {}) {
      if (!READ_COMMANDS.has(command)) throw new Error(`hka: ${command} no es una lectura`);
      let last = "timeout";
      for (let i = 0; i < attempts; i++) {
        const r = throwIfClosed(await exchange(frameCommand(command), "frame", t.read));
        if (r instanceof Uint8Array) return r;
        last = r;
      }
      throw new Error(`hka: la máquina no respondió ${command} (${last})`);
    },

    /**
     * A command that changes the machine. Sent ONCE.
     * @param {string} command
     * @param {"entry" | "print"} [kind]
     * @returns {Promise<"ack" | "nak" | "timeout">}
     */
    async command(command, kind = "entry") {
      assertAllowed(command);
      if (READ_COMMANDS.has(command)) throw new Error("hka: las lecturas van por read()");
      return throwIfClosed(await exchange(frameCommand(command), "ack", kind === "print" ? t.print : t.entry));
    },

    /**
     * Poll ENQ until the machine is idle and ready, a hardware fault shows,
     * or `maxMs` passes. No answer counts as busy. An open document ends the
     * wait at once (`stopOnOpenDocument`, the default: the caller recovers
     * it) or is waited out (after a closing command, while it prints).
     * @returns {Promise<import("./hka-parse.mjs").HkaStatus | null>} the last status seen
     */
    async waitIdle({ maxMs = 30_000, stopOnOpenDocument = true } = {}) {
      const deadline = Date.now() + Math.min(maxMs, maxWaitCap);
      let last = null;
      for (;;) {
        const s = await enq({ attempts: 1 });
        if (s) {
          last = s;
          if (s.ready || (s.error && !s.commandError) || s.mfFull) return s;
          if (stopOnOpenDocument && s.docOpen !== "none") return s;
        }
        if (Date.now() >= deadline) return last;
        await sleep(t.poll);
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      waiter?.done("closed");
      await link.close();
    },
  };
}
