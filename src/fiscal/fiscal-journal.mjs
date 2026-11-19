// Máquina fiscal job journal (bridge 0.9.0).
//
// One fsynced JSON file per factura job (<dir>/jobs/<job>.json), rewritten
// at every step that matters for recovery:
//
//   accepted   the plan verified and was queued
//   started    S1 read (lastFactura N), about to open the document; `step`
//              says how far it got: body → paying | cancelling
//   done       the run ended with an outcome; recordable outcomes carry the
//              signed result until a device acks it as recorded
//
// A job still "started" after a restart (or after the machine stopped
// answering) is resolved by recoverInvoice against the machine. Recorded
// jobs are kept 30 days, others 7 — the machine itself is the long-term
// record (audit memory, Z reports).
//
// 0.9.6: a job holds a KEY, not always an order. A factura holds its order
// (rec.order_id); a nota de crédito holds `nc:<factura document id>`
// (rec.hold), so each factura gets at most one NC. A printed NC releases the
// factura's job (released_at), so the order can be invoiced again.

import fs from "node:fs";
import path from "node:path";

export const FISCAL_JOB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORDED_RETENTION_MS = 30 * 24 * 60 * 60_000;
const OTHER_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Outcomes that hold the order: no second factura while one of these stands. */
const HOLDING = new Set(["printed", "needs_review", "interrupted"]);

function writeFileDurable(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * @param {{ dir: string, now?: () => number, log?: (...a: unknown[]) => void }} opts
 */
export function createFiscalJournal({ dir, now = () => Date.now(), log = () => {} }) {
  const jobsDir = path.join(dir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  /** @type {Map<string, any>} */
  const jobs = new Map();

  for (const name of fs.readdirSync(jobsDir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(jobsDir, name);
    try {
      const rec = JSON.parse(fs.readFileSync(file, "utf8"));
      if (rec && FISCAL_JOB_RE.test(rec.job)) jobs.set(rec.job, rec);
    } catch (e) {
      log(`fiscal: registro ilegible ${name} (${e.message})`);
    }
  }

  const fileFor = (job) => path.join(jobsDir, `${job}.json`);

  function save(rec) {
    rec.updated_at = now();
    writeFileDurable(fileFor(rec.job), JSON.stringify(rec));
    jobs.set(rec.job, rec);
    return rec;
  }

  /** Does this job keep its key (order / factura) from being printed again? */
  function holds(rec) {
    if (rec.state !== "done") return true;
    if (rec.released_at) return false;
    return HOLDING.has(rec.outcome?.status);
  }

  return {
    get: (job) => jobs.get(job) ?? null,
    save,

    /**
     * The job that holds `key` (in flight, or a document on the machine):
     * an order id for a factura, `nc:<factura id>` for a nota de crédito.
     */
    holderFor(restaurantId, key) {
      let best = null;
      for (const rec of jobs.values()) {
        if (rec.r !== restaurantId || (rec.hold ?? rec.order_id) !== key || !holds(rec)) continue;
        if (!best || rec.created_at > best.created_at) best = rec;
      }
      return best;
    },

    /**
     * A nota de crédito reversed the factura `rec` printed: it no longer
     * holds its order. Returns whether anything changed.
     */
    release(rec, byJob) {
      if (!rec || rec.released_at) return false;
      rec.released_at = now();
      rec.released_by = byJob;
      save(rec);
      return true;
    },

    /** Jobs whose run never finished (recovery). */
    inFlight() {
      return [...jobs.values()].filter((rec) => rec.state !== "done");
    },

    /** Recordable results no device has confirmed yet. */
    unrecorded(restaurantId) {
      return [...jobs.values()]
        .filter((rec) => rec.r === restaurantId && rec.state === "done" && rec.result_token && !rec.recorded_at)
        .sort((a, b) => a.created_at - b.created_at);
    },

    /** Mark results recorded; returns how many changed. */
    markRecorded(restaurantId, jobKeys) {
      let n = 0;
      for (const key of jobKeys) {
        const rec = jobs.get(key);
        if (!rec || rec.r !== restaurantId || rec.recorded_at) continue;
        rec.recorded_at = now();
        save(rec);
        n++;
      }
      return n;
    },

    /** Newest first, for the settings panel. */
    recent(restaurantId, limit = 20) {
      return [...jobs.values()]
        .filter((rec) => rec.r === restaurantId)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit);
    },

    compact() {
      const t = now();
      for (const [key, rec] of jobs) {
        if (rec.state !== "done") continue;
        if (rec.result_token && !rec.recorded_at) continue; // never drop an unrecorded factura
        const keep = rec.recorded_at ? RECORDED_RETENTION_MS : OTHER_RETENTION_MS;
        if (t - (rec.updated_at ?? rec.created_at ?? 0) > keep) {
          jobs.delete(key);
          fs.rmSync(fileFor(key), { force: true });
        }
      }
    },
  };
}
