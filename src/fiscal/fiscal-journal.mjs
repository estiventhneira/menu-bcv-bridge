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

  /** Does this job keep its order from being invoiced again? */
  function holds(rec) {
    if (rec.state !== "done") return true;
    return HOLDING.has(rec.outcome?.status);
  }

  return {
    get: (job) => jobs.get(job) ?? null,
    save,

    /** The job that holds `orderId` (in flight, or a factura on the machine). */
    holderFor(restaurantId, orderId) {
      let best = null;
      for (const rec of jobs.values()) {
        if (rec.r !== restaurantId || rec.order_id !== orderId || !holds(rec)) continue;
        if (!best || rec.created_at > best.created_at) best = rec;
      }
      return best;
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
