// LAN print journal + durable local queue (bridge 0.7.0).
//
// Two kinds of ticket reach the bridge over the LAN (see lan-server.mjs):
//
//  * source "offline" — a tablet with no internet printed an order locally.
//    No print_jobs row exists, and none ever will: once the bridge answers
//    "accepted", the tablet reports the (kind, printer) pair as printed and
//    the server skips it when the order syncs (exclude_pairs). So "accepted"
//    must mean DURABLY QUEUED — the payload is written (and fsynced) to
//    <dir>/jobs/<job_key>.json before the reply, survives a bridge restart,
//    and is deleted only once printed. After LAN_MAX_ATTEMPTS failures it
//    stays on disk as "failed" so staff can reprint it from Configuración.
//  * source "cloud" — the app forwarded a print_jobs row it just inserted
//    (LAN-first). The cloud row is the durable record; the journal only
//    remembers what this bridge printed so a later realtime/poll delivery of
//    the same row (still pending because the ack never landed, or re-pended
//    by the 5-min reaper) is ACKED instead of printed twice.
//
// journal.jsonl is append-only (a torn last line after a power cut is
// skipped on load — worst case one duplicate ticket, never a lost one) and
// compacted to the retention window at boot and daily. print_jobs rows are
// purged after 7 days server-side, so older entries can never matter.

import fs from "node:fs";
import path from "node:path";

/** Accepted job keys: UUIDs (cloud) and offline-<kind>-<printer>-…-<order>. */
export const LAN_JOB_KEY_RE = /^[A-Za-z0-9_-]{8,200}$/;
export const LAN_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Attempts for an offline-source ticket before it is parked as failed. More
 *  generous than the cloud path's 3: power cuts take the internet AND the
 *  printers down together, and a thermal printer needs ~30-60 s to boot. */
export const LAN_MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000];

/** Delay before retry number `attempts` (1-based count of failures so far). */
export function lanRetryDelayMs(attempts) {
  const i = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, attempts - 1));
  return RETRY_DELAYS_MS[i];
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Write-then-rename with an fsync: a reader never sees half a file, and a
 *  reply of "accepted" really is on disk. */
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
export function createLanStore({ dir, now = () => Date.now(), log = () => {} }) {
  const journalPath = path.join(dir, "journal.jsonl");
  const jobsDir = path.join(dir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  /** job_key -> { src, pid, kind, at, acked } */
  const printed = new Map();
  /** job_key -> offline job record (state "queued" | "failed") */
  const jobs = new Map();

  // ── load ────────────────────────────────────────────────────────────
  let text = "";
  try {
    text = fs.readFileSync(journalPath, "utf8");
  } catch {}
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // torn line
    }
    if (!e || typeof e.k !== "string") continue;
    if (e.st === "printed") {
      printed.set(e.k, {
        src: e.src === "cloud" ? "cloud" : "offline",
        pid: e.pid ?? null,
        kind: e.kind ?? null,
        at: Number(e.at) || 0,
        acked: e.acked === true,
      });
    } else if (e.st === "acked") {
      const cur = printed.get(e.k);
      if (cur) cur.acked = true;
    }
  }
  for (const name of safeReaddir(jobsDir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(jobsDir, name);
    try {
      const rec = JSON.parse(fs.readFileSync(file, "utf8"));
      if (rec && LAN_JOB_KEY_RE.test(rec.job_key) && !printed.has(rec.job_key)) {
        jobs.set(rec.job_key, rec);
      } else {
        fs.rmSync(file, { force: true }); // printed before a crash, or junk
      }
    } catch (e) {
      log(`lan: ignoring unreadable job file ${name}: ${e.message}`);
    }
  }

  function append(entry) {
    try {
      fs.appendFileSync(journalPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch (e) {
      log(`lan: journal write failed: ${e.message}`);
    }
  }

  function jobFile(key) {
    return path.join(jobsDir, `${key}.json`);
  }

  return {
    isPrinted: (key) => printed.has(key),
    printedEntry: (key) => printed.get(key) ?? null,
    getJob: (key) => jobs.get(key) ?? null,

    /** Persist (create or update) an offline job record — durable on return. */
    saveJob(rec) {
      writeFileDurable(jobFile(rec.job_key), JSON.stringify(rec));
      jobs.set(rec.job_key, rec);
    },

    /** Record a printed ticket and drop its queued payload. */
    markPrinted(key, { src, pid, kind, acked }) {
      const entry = { src, pid: pid ?? null, kind: kind ?? null, at: now(), acked: acked === true };
      printed.set(key, entry);
      append({ k: key, st: "printed", ...entry });
      if (jobs.delete(key)) fs.rmSync(jobFile(key), { force: true });
    },

    markAcked(key) {
      const cur = printed.get(key);
      if (!cur || cur.acked) return;
      cur.acked = true;
      append({ k: key, st: "acked", at: now() });
    },

    /** Cloud rows this bridge printed whose `done` ack never landed. */
    unackedCloudKeys() {
      return [...printed.entries()]
        .filter(([, e]) => e.src === "cloud" && !e.acked)
        .map(([k]) => k);
    },

    queuedJobs() {
      return [...jobs.values()].filter((j) => j.state === "queued");
    },

    /**
     * Offline tickets that ran out of attempts, newest first.
     * @param {{ sinceMs?: number, restaurantId?: string | null, limit?: number }} [opts]
     */
    failedJobs({ sinceMs = 24 * 60 * 60_000, restaurantId = null, limit = 20 } = {}) {
      const cutoff = now() - sinceMs;
      return [...jobs.values()]
        .filter((j) => j.state === "failed" && (j.failed_at ?? 0) >= cutoff)
        .filter((j) => !restaurantId || j.restaurant_id === restaurantId)
        .sort((a, b) => (b.failed_at ?? 0) - (a.failed_at ?? 0))
        .slice(0, limit);
    },

    stats() {
      let queued = 0;
      let failed = 0;
      for (const j of jobs.values()) j.state === "failed" ? failed++ : queued++;
      let unacked = 0;
      for (const e of printed.values()) if (e.src === "cloud" && !e.acked) unacked++;
      return { printed: printed.size, queued, failed, unacked };
    },

    /** Drop entries past the retention window and rewrite the journal. */
    compact() {
      const cutoff = now() - LAN_RETENTION_MS;
      for (const [k, e] of printed) if (e.at < cutoff) printed.delete(k);
      for (const [k, j] of jobs) {
        if (j.state === "failed" && (j.failed_at ?? 0) < cutoff) {
          jobs.delete(k);
          fs.rmSync(jobFile(k), { force: true });
        }
      }
      const lines = [...printed.entries()].map(([k, e]) => JSON.stringify({ k, st: "printed", ...e }));
      try {
        writeFileDurable(journalPath, lines.length ? lines.join("\n") + "\n" : "");
      } catch (e) {
        log(`lan: journal compaction failed: ${e.message}`);
      }
    },
  };
}
