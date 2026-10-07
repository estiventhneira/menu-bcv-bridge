// Printed-ticket archive (bridge 0.8.0).
//
// Every ticket this bridge prints — cloud jobs, LAN-first jobs, offline
// tickets and reprints — is kept for the current and the previous day, so any
// tablet on the restaurant WiFi can list them and print a copy again, with or
// without internet (POST /lan/v1/tickets, /lan/v1/tickets/reprint). The
// payload is stored, not the ESC/POS bytes: a reprint renders again with the
// printer's current settings and a «REIMPRESION» banner, exactly like the
// app's own reprint button.
//
// One append-only <dir>/<local day>.jsonl per day. Metadata stays in memory
// (with each line's byte offset); a reprint reads just its line back. Days
// older than yesterday are deleted at boot and every hour. A day file that
// grows past MAX_DAY_BYTES stops archiving (a runaway loop must never fill
// the restaurant PC's disk).

import fs from "node:fs";
import path from "node:path";

export const ARCHIVE_DAYS_KEPT = 2;
const MAX_DAY_BYTES = 64 * 1024 * 1024;
const DAY_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Local calendar day of a timestamp, YYYY-MM-DD (the PC's own timezone —
 *  the restaurant's day, not UTC). */
export function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function str(x, max = 120) {
  if (x === null || x === undefined) return null;
  const s = String(x);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * @param {{ dir: string, now?: () => number, log?: (...a: unknown[]) => void, day?: (ms: number) => string }} opts
 */
export function createTicketArchive({ dir, now = () => Date.now(), log = () => {}, day = localDay }) {
  fs.mkdirSync(dir, { recursive: true });
  /** id -> metadata (+ file, offset, length) */
  const index = new Map();
  let fullWarned = null;

  function keptDays() {
    const t = now();
    const days = [];
    for (let i = 0; i < ARCHIVE_DAYS_KEPT; i++) days.push(`${day(t - i * 24 * 60 * 60_000)}.jsonl`);
    return days;
  }

  function load(name) {
    const file = path.join(dir, name);
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return;
    }
    // A power cut can leave a torn last line with no newline; terminate it so
    // the next append starts a fresh line instead of corrupting both.
    if (buf.length > 0 && buf[buf.length - 1] !== 10) {
      try {
        fs.appendFileSync(file, "\n");
        buf = Buffer.concat([buf, Buffer.from("\n")]);
      } catch {}
    }
    let offset = 0;
    while (offset < buf.length) {
      let end = buf.indexOf(10, offset); // "\n"
      if (end === -1) end = buf.length;
      const length = end - offset;
      if (length > 0) {
        try {
          const rec = JSON.parse(buf.subarray(offset, end).toString("utf8"));
          if (rec && typeof rec.id === "string") {
            const { payload: _p, ...meta } = rec;
            void _p;
            index.set(rec.id, { ...meta, file: name, offset, length });
          }
        } catch {
          // torn line — skip
        }
      }
      offset = end + 1;
    }
  }

  function compact() {
    const keep = new Set(keptDays());
    for (const name of fs.readdirSync(dir)) {
      if (!DAY_RE.test(name) || keep.has(name)) continue;
      fs.rmSync(path.join(dir, name), { force: true });
    }
    for (const [id, meta] of index) if (!keep.has(meta.file)) index.delete(id);
  }

  for (const name of keptDays()) load(name);
  compact();

  return {
    /**
     * Keep a printed ticket. Never throws — archiving must not fail a print.
     * @param {{ id: string, r: string, kind: string, printer_id: string, printer_name?: string | null,
     *           order_id?: string | null, payload: any, source: string,
     *           reprint_of?: string | null, user_id?: string | null }} t
     */
    record(t) {
      try {
        const at = now();
        const name = `${day(at)}.jsonl`;
        const file = path.join(dir, name);
        // The real size, not the tracked one: a second bridge process (seen in
        // the field) may have appended too, and the offset must be exact.
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {}
        if (size > MAX_DAY_BYTES) {
          if (fullWarned !== name) log(`archivo: ${name} superó ${MAX_DAY_BYTES >> 20} MB — no se guardan más tickets hoy`);
          fullWarned = name;
          return;
        }
        const p = t.payload && typeof t.payload === "object" ? t.payload : {};
        const meta = {
          id: t.id,
          at,
          r: t.r,
          kind: t.kind,
          printer_id: t.printer_id,
          printer_name: str(t.printer_name, 80),
          order_id: typeof t.order_id === "string" ? t.order_id : null,
          order_number: str(p.order_number, 32),
          table_label: str(p.table_label, 40),
          // Caja paper (cierre / retiro / ingreso) has no order: its title
          // names it in the list.
          label: str(p.title, 60),
          source: t.source,
          reprint_of: t.reprint_of ?? null,
          user_id: t.user_id ?? null,
        };
        const line = Buffer.from(JSON.stringify({ ...meta, payload: t.payload }) + "\n", "utf8");
        fs.appendFileSync(file, line, { mode: 0o600 });
        index.set(t.id, { ...meta, file: name, offset: size, length: line.length - 1 });
      } catch (e) {
        log(`archivo: no se pudo guardar el ticket ${t.id} (${e.message})`);
      }
    },

    /**
     * Newest first, metadata only.
     * @param {string} restaurantId
     * @param {{ orderId?: string | null, sinceMs?: number | null, limit?: number, kinds?: string[] | null }} [opts]
     */
    list(restaurantId, { orderId = null, sinceMs = null, limit = 100, kinds = null } = {}) {
      const out = [];
      for (const meta of index.values()) {
        if (meta.r !== restaurantId) continue;
        if (orderId && meta.order_id !== orderId) continue;
        if (sinceMs && meta.at < sinceMs) continue;
        if (kinds && !kinds.includes(meta.kind)) continue;
        out.push(meta);
      }
      out.sort((a, b) => b.at - a.at);
      return out.slice(0, limit).map(({ file: _f, offset: _o, length: _l, ...meta }) => {
        void _f;
        void _o;
        void _l;
        return meta;
      });
    },

    /** Full record (with payload), or null. */
    get(id) {
      const meta = index.get(id);
      if (!meta) return null;
      let fd;
      try {
        fd = fs.openSync(path.join(dir, meta.file), "r");
        const buf = Buffer.alloc(meta.length);
        fs.readSync(fd, buf, 0, meta.length, meta.offset);
        const rec = JSON.parse(buf.toString("utf8"));
        return rec && rec.id === id ? rec : null;
      } catch (e) {
        log(`archivo: no se pudo leer el ticket ${id} (${e.message})`);
        return null;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    },

    /** Tickets kept today for a restaurant. */
    countToday(restaurantId) {
      const today = `${day(now())}.jsonl`;
      let n = 0;
      for (const meta of index.values()) if (meta.r === restaurantId && meta.file === today) n++;
      return n;
    },

    compact,
  };
}
