// Follow a wifi printer by its MAC address (0.9.2). Split out of index.mjs so
// the app's vitest can pin the rules (src/lib/printing/bridge-printer-follow.test.ts).
//
// WHY: a router that hands a printer another IP broke printing until someone
// typed the new address in Configuración (Pronto Gourmet's first week: Caja
// .119→.240, Frontline .114→.191), and a printer whose IP another device took
// only ever said ECONNREFUSED (Xing Wah, 2026-10-31: «Impresora principal»
// failed 50 jobs in three days while the scan found no printer at its IP).
//
// The printer's network card keeps its MAC whatever IP it gets. After a good
// print the bridge reads that MAC from the OS ARP table (arp.mjs). When the
// printer stops answering, the bridge looks for the MAC on the LAN — in the
// ARP table first, then in a discovery scan — and when exactly one printer
// port answers with it, prints there. That's proof, not a guess: unlike the
// app's «Usar esta IP» hint (the only unconfigured host), a follow can't send
// tickets to a different printer.
//
// The follow lives on this PC only. Devices have no write path to printer
// config (migrations 200/201): the bridge reports what it sees
// (bridge_tokens.printer_status, migration 366) and a person saves the new IP
// from the app («Guardar la nueva IP»). An IP typed in the app always wins,
// and the bridge learns whatever card answers there.
//
// When the printer isn't found, the report says what answered at its IP:
// another device's card (conflict), the printer itself refusing (refused),
// or nothing (unreachable).
//
// 0.9.3: a refused or unreachable printer is tried again every minute, and
// the report clears as soon as it answers. It used to clear only on the
// printer's next ticket: Pronto Gourmet's Dolce (a few dessert comandas a
// day) still said «La impresora no responde» hours after it was back
// (2026-11-11).

/** Re-read a printer's MAC after a good print at most this often — also how
 *  soon a DHCP swap (its IP now reaching another printer) is noticed. */
export const RELEARN_MS = 10 * 60_000;
/** Batch the MAC reads after a burst of prints. */
export const LEARN_DELAY_MS = 1_500;
/** One ARP read serves every failure within this window. */
export const ARP_FRESH_MS = 3_000;
/** Jobs of a printer being searched for wait this long at most. */
export const LOCATE_WINDOW_MS = 4 * 60_000;
export const PROBE_TIMEOUT_MS = 750;
/** How often a printer that doesn't answer is tried again. */
export const RECHECK_MS = 60_000;
/**
 * Good prints that must see the same new card at the printer's IP — with a
 * scan in between that found the old card nowhere — before it replaces the
 * old one. Two devices sharing one IP flip the ARP entry now and then; a
 * replaced printer shows its card every time.
 */
export const MISMATCH_CONFIRM = 3;

/**
 * One printer in the report (bridge-printer-status.ts parses it app-side).
 * @typedef {{
 *   host: string, port: number, mac: string | null, followed_host: string | null,
 *   state: string, host_mac: string | null, other_printer_id: string | null,
 *   since: string | null, checked_at: string | null,
 * }} PrinterStatusEntry
 */

export const PROBLEM_STATES = new Set(["conflict", "refused", "unreachable"]);
const STATES = new Set(["ok", "moved", ...PROBLEM_STATES]);
/** The problems a connection that opens disproves. Not a conflict: two
 *  devices sharing an IP take turns answering there. */
const DOWN_STATES = new Set(["refused", "unreachable"]);

const MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const asMac = (v) => (typeof v === "string" && MAC_RE.test(v) ? v : null);
const asHost = (v) => (typeof v === "string" && IPV4_RE.test(v) ? v : null);
const asTime = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function blankEntry() {
  return {
    port: 9100,
    configured_host: null,
    mac: null,
    mac_host: null,
    learned_at: null,
    followed_host: null,
    followed_from: null,
    followed_at: null,
    state: null,
    since: null,
    checked_at: null,
    host_mac: null,
    other_printer_id: null,
    // Transient, never persisted.
    locate_requested_at: null,
    located_at: null,
    mismatch_mac: null,
    mismatch_count: 0,
    mismatch_scanned: false,
  };
}

/** What the printer is known by: dropped when someone types another IP. */
function forgetCard(e) {
  e.mac = e.mac_host = e.learned_at = null;
  e.state = e.since = e.host_mac = e.other_printer_id = null;
  e.locate_requested_at = e.located_at = null;
  clearMismatch(e);
}

function clearMismatch(e) {
  e.mismatch_mac = null;
  e.mismatch_count = 0;
  e.mismatch_scanned = false;
}

/** Persisted state back into entries; anything malformed is dropped. */
function loadEntries(saved) {
  const out = new Map();
  const list = saved && typeof saved === "object" && saved.v === 1 ? saved.printers : null;
  if (!list || typeof list !== "object") return out;
  for (const [id, raw] of Object.entries(list)) {
    if (!raw || typeof raw !== "object") continue;
    const e = blankEntry();
    e.port = Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : 9100;
    e.configured_host = asHost(raw.configured_host);
    e.mac = asMac(raw.mac);
    e.mac_host = asHost(raw.mac_host);
    e.learned_at = asTime(raw.learned_at);
    e.followed_host = asHost(raw.followed_host);
    e.followed_from = asHost(raw.followed_from);
    e.followed_at = asTime(raw.followed_at);
    if (!e.followed_host || !e.followed_from) e.followed_host = e.followed_from = e.followed_at = null;
    e.state = STATES.has(raw.state) && (raw.state !== "moved" || e.followed_host) ? raw.state : null;
    e.since = asTime(raw.since);
    e.checked_at = asTime(raw.checked_at);
    e.host_mac = asMac(raw.host_mac);
    e.other_printer_id = typeof raw.other_printer_id === "string" ? raw.other_printer_id.slice(0, 64) : null;
    out.set(id, e);
  }
  return out;
}

/**
 * @param {{
 *   readArp: () => Promise<Map<string, string>>,
 *   probe: (host: string, port: number, timeoutMs: number) => Promise<unknown>,
 *   requestScan: (opts: { urgent: boolean }) => boolean,
 *   onFollow: (printerId: string, host: string, from: string | null) => void,
 *   onChange: () => void,
 *   nameOf?: (printerId: string) => string,
 *   saved?: unknown,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createPrinterFollow({
  readArp,
  probe,
  requestScan,
  onFollow,
  onChange,
  nameOf = (id) => id.slice(0, 8),
  saved = null,
  now = () => Date.now(),
  log = () => {},
}) {
  const printers = loadEntries(saved);
  const learnQueue = new Map(); // printer id -> host it just printed at
  let learnTimer = null;
  let recheckTimer = null;
  let arpCache = null; // { at, table }
  let arpInflight = null;
  const said = new Set();

  function logOnce(msg) {
    if (said.has(msg)) return;
    if (said.size > 200) said.clear();
    said.add(msg);
    log(msg);
  }

  /** Where the printer's jobs go right now. */
  const currentHost = (e) => e.followed_host ?? e.configured_host;

  /** A new read of the table — after a print or a probe, the entry that
   *  matters was just refreshed by that very connection. */
  function readArpFresh() {
    return Promise.resolve()
      .then(readArp)
      .then((table) => {
        arpCache = { at: now(), table };
        return table;
      });
  }

  /** Failures of several printers in a row share one read. */
  function readArpCached(maxAgeMs) {
    if (arpCache && now() - arpCache.at <= maxAgeMs) return Promise.resolve(arpCache.table);
    if (!arpInflight) arpInflight = readArpFresh().finally(() => { arpInflight = null; });
    return arpInflight;
  }

  /** Another tracked printer whose card this is — never one at the same IP:
   *  a printer registered twice learns the same card twice. */
  function printerWithMac(mac, exceptId, exceptHost) {
    for (const [id, e] of printers) {
      if (id !== exceptId && e.mac === mac && currentHost(e) !== exceptHost) return id;
    }
    return null;
  }

  function follow(id, host) {
    const e = printers.get(id);
    if (!e) return;
    const from = currentHost(e);
    const t = now();
    if (host === e.configured_host) {
      e.followed_host = e.followed_from = e.followed_at = null;
      e.state = "ok";
      e.since = null;
    } else {
      e.followed_host = host;
      e.followed_from = e.configured_host;
      e.followed_at = t;
      e.state = "moved";
      e.since = t;
    }
    e.mac_host = host;
    e.learned_at = t;
    e.host_mac = null;
    e.other_printer_id = null;
    e.locate_requested_at = null;
    e.located_at = t;
    e.checked_at = t;
    clearMismatch(e);
    log(`${nameOf(id)}: la impresora cambió de IP — ${from} → ${host} (la reconocí por su MAC ${e.mac})`);
    onChange();
    onFollow(id, host, from);
  }

  /** The printer's card at `ip`, confirmed live: the port answers and the
   *  fresh ARP entry still holds the card. */
  async function confirmAt(e, ip) {
    if (!(await probe(ip, e.port, PROBE_TIMEOUT_MS))) return false;
    const table = await readArpFresh().catch(() => null);
    return table?.get(ip) === e.mac;
  }

  function learnFrom(id, e, host, mac) {
    if (!e.mac) {
      e.mac = mac;
      e.mac_host = host;
      e.learned_at = now();
      log(`${nameOf(id)}: MAC ${mac} en ${host}`);
      return true;
    }
    if (e.mac === mac) {
      const moved = e.mac_host !== host;
      e.mac_host = host;
      e.learned_at = now();
      clearMismatch(e);
      return moved;
    }
    const otherId = printerWithMac(mac, id, host);
    if (e.mismatch_mac !== mac) {
      e.mismatch_mac = mac;
      e.mismatch_count = 0;
      e.mismatch_scanned = false;
      log(`${nameOf(id)}: en ${host} responde otra MAC (${mac}, antes ${e.mac}) — la busco en la red`);
      requestScan({ urgent: true });
    }
    e.mismatch_count += 1;
    if (otherId) {
      // The printer's IP now reaches another printer of the restaurant (a
      // DHCP swap): its tickets come out there. Flag it; never learn it.
      if (e.state === "conflict" && e.other_printer_id === otherId && e.host_mac === mac) return false;
      e.state = "conflict";
      e.since = now();
      e.host_mac = mac;
      e.other_printer_id = otherId;
      return true;
    }
    if (e.mismatch_count < MISMATCH_CONFIRM || !e.mismatch_scanned) return false;
    // A replaced printer at the same IP (or the row re-pointed outside the app).
    log(`${nameOf(id)}: MAC nueva ${mac} en ${host} (antes ${e.mac})`);
    e.mac = mac;
    e.mac_host = host;
    e.learned_at = now();
    clearMismatch(e);
    return true;
  }

  async function runLearn() {
    learnTimer = null;
    const queue = new Map(learnQueue);
    learnQueue.clear();
    let table;
    try {
      table = await readArpFresh();
    } catch (err) {
      logOnce(`follow: no se pudo leer la tabla ARP (${err.message}) — sin seguimiento por MAC`);
      return;
    }
    let changed = false;
    for (const [id, host] of queue) {
      const e = printers.get(id);
      // Missing from the table: the printer is behind a router (another
      // subnet), where its card can't be seen — nothing to follow there.
      const mac = table.get(host);
      if (!e || !mac || currentHost(e) !== host) continue;
      if (learnFrom(id, e, host, mac)) changed = true;
    }
    if (changed) onChange();
  }

  async function diagnose(id, e, host, err) {
    let table = new Map();
    try {
      table = await readArpCached(ARP_FRESH_MS);
    } catch (readErr) {
      logOnce(`follow: no se pudo leer la tabla ARP (${readErr.message}) — sin seguimiento por MAC`);
    }
    if (printers.get(id) !== e || currentHost(e) !== host) return; // followed meanwhile
    const hostMac = table.get(host) ?? null;
    const otherId = hostMac ? printerWithMac(hostMac, id, host) : null;
    const state = (e.mac && hostMac && hostMac !== e.mac) || (!e.mac && otherId)
      ? "conflict"
      : err?.code === "ECONNREFUSED"
        ? "refused"
        : "unreachable";
    if (e.state !== state || e.host_mac !== hostMac || e.other_printer_id !== otherId) {
      e.state = state;
      e.host_mac = hostMac;
      e.other_printer_id = otherId;
      onChange();
    }
    armRecheck();
    // Fast path: the card already sits at another IP in the table.
    if (!e.mac) return;
    const elsewhere = [...table].filter(([ip, mac]) => mac === e.mac && ip !== host).map(([ip]) => ip);
    if (elsewhere.length === 1 && (await confirmAt(e, elsewhere[0]))) {
      if (printers.get(id) === e && currentHost(e) === host) follow(id, elsewhere[0]);
    }
  }

  /** The printer answers where its jobs go: whatever was reported is over.
   *  Returns whether the report changed. */
  function markAnswering(e) {
    const state = e.followed_host ? "moved" : "ok";
    if (e.state === state && !e.host_mac && !e.other_printer_id) return false;
    e.state = state;
    e.since = e.followed_host ? e.followed_at : null;
    e.host_mac = null;
    e.other_printer_id = null;
    return true;
  }

  /** Down, and its IP not in dispute (then the state is the learner's call). */
  const isDown = (e) => DOWN_STATES.has(e.state) && !e.mismatch_mac;

  /**
   * Whether the printer itself answers at `host`. One with no card learned
   * yet (it hasn't printed since 0.9.2, or sits behind a router) is taken at
   * its word unless another printer's card answers there.
   */
  async function answersAt(id, e, host) {
    if (e.mac) return confirmAt(e, host);
    if (!(await probe(host, e.port, PROBE_TIMEOUT_MS))) return false;
    const hostMac = (await readArpFresh().catch(() => null))?.get(host);
    return !hostMac || !printerWithMac(hostMac, id, host);
  }

  /** Runs while some printer is down, and stops by itself. */
  function armRecheck() {
    if (recheckTimer || ![...printers.values()].some(isDown)) return;
    recheckTimer = setTimeout(() => {
      runRecheck().catch((err) => log(`follow: ${err.message}`));
    }, RECHECK_MS);
    recheckTimer.unref?.();
  }

  async function runRecheck() {
    recheckTimer = null;
    let changed = false;
    for (const [id, e] of printers) {
      if (!isDown(e)) continue;
      const host = currentHost(e);
      if (!host || !(await answersAt(id, e, host))) continue;
      // A print or an edit may have settled it while the probe was out.
      if (printers.get(id) !== e || currentHost(e) !== host || !isDown(e)) continue;
      e.checked_at = now();
      markAnswering(e);
      log(`${nameOf(id)}: volvió a responder en ${host}`);
      changed = true;
    }
    if (changed) onChange();
    armRecheck();
  }

  // A problem saved before a restart may be over by now.
  armRecheck();

  return {
    /**
     * The address to print at for a wifi printer whose row says `rowHost`.
     * Called on every printer reload. A row that now says the followed IP was
     * saved from the app; any other new IP was typed by someone, and whatever
     * answers there is this printer from now on.
     */
    resolveHost(id, rowHost, port) {
      let e = printers.get(id);
      if (!e) {
        e = blankEntry();
        printers.set(id, e);
      }
      const before = e.configured_host;
      e.port = port;
      e.configured_host = rowHost;
      if (e.followed_host && rowHost !== e.followed_from) {
        const saved = rowHost === e.followed_host;
        e.followed_host = e.followed_from = e.followed_at = null;
        if (saved) {
          e.state = "ok";
          e.since = null;
        } else {
          forgetCard(e);
        }
        onChange();
      } else if (!e.followed_host && before && before !== rowHost) {
        forgetCard(e);
        onChange();
      }
      return currentHost(e);
    },

    /** Forget printers the cloud no longer lists. */
    retain(ids) {
      let dropped = false;
      for (const id of [...printers.keys()]) {
        if (!ids.has(id)) {
          printers.delete(id);
          learnQueue.delete(id);
          dropped = true;
        }
      }
      if (dropped) onChange();
    },

    /** A job just printed at `host`. */
    noteReachable(id, host) {
      const e = printers.get(id);
      if (!e || currentHost(e) !== host) return;
      const t = now();
      e.checked_at = t;
      e.locate_requested_at = null;
      // While another card answers here, the state is the learner's call.
      if (!e.mismatch_mac && markAnswering(e)) onChange();
      if (!e.mac || e.mismatch_mac || e.mac_host !== host || t - (e.learned_at ?? 0) >= RELEARN_MS) {
        learnQueue.set(id, host);
        if (!learnTimer) {
          learnTimer = setTimeout(() => {
            runLearn().catch((err) => log(`follow: ${err.message}`));
          }, LEARN_DELAY_MS);
          learnTimer.unref?.();
        }
      }
    },

    /**
     * The connection to the printer never opened. Books the search
     * synchronously — the failing job asks isLocating() right after — then
     * diagnoses from the ARP table in the background.
     */
    noteUnreachable(id, host, err) {
      const e = printers.get(id);
      if (!e || currentHost(e) !== host) return;
      const t = now();
      if (!PROBLEM_STATES.has(e.state)) e.since = t;
      e.checked_at = t;
      // Urgent until a scan that started after the problem began is done;
      // after that it's searched for at discovery's normal pace.
      const urgent = !!e.mac && !(e.located_at >= e.since);
      if (requestScan({ urgent }) && urgent && !e.locate_requested_at) e.locate_requested_at = t;
      diagnose(id, e, host, err).catch((diagErr) => log(`follow: ${diagErr.message}`));
    },

    /**
     * A discovery scan finished: `responders` answered on the printer port,
     * each with the MAC the ARP table holds for it. A printer whose card
     * answers at exactly one other IP is followed there; several answers
     * (a WiFi repeater that rewrites MACs) follow nothing.
     */
    onScan(responders, { startedAt } = {}) {
      const scannedAt = startedAt ?? now();
      for (const [id, e] of printers) {
        if (!e.mac) continue;
        const hits = responders.filter((r) => r.mac === e.mac && r.port === e.port);
        if (hits.length === 1) {
          if (hits[0].host !== currentHost(e)) {
            follow(id, hits[0].host);
            continue;
          }
          clearMismatch(e);
        } else if (hits.length > 1) {
          logOnce(`${nameOf(id)}: ${hits.length} equipos responden con la MAC ${e.mac} (¿repetidor WiFi?) — no la sigo`);
        } else if (e.mismatch_mac) {
          e.mismatch_scanned = true;
        }
        if (e.locate_requested_at && scannedAt >= e.locate_requested_at) e.locate_requested_at = null;
        if (PROBLEM_STATES.has(e.state) && !(e.located_at >= scannedAt)) e.located_at = scannedAt;
      }
    },

    /** Its jobs should wait instead of spending attempts: the bridge is
     *  searching for it right now (bounded by LOCATE_WINDOW_MS). */
    isLocating(id) {
      const at = printers.get(id)?.locate_requested_at;
      return !!at && now() - at < LOCATE_WINDOW_MS;
    },

    /** For bridge_report_printer_status (migration 366). */
    report() {
      /** @type {Record<string, PrinterStatusEntry>} */
      const out = {};
      for (const [id, e] of printers) {
        if (!e.configured_host || (!e.mac && !e.state)) continue;
        out[id] = {
          host: e.configured_host,
          port: e.port,
          mac: e.mac,
          followed_host: e.followed_host,
          state: e.state ?? "ok",
          host_mac: e.host_mac,
          other_printer_id: e.other_printer_id,
          since: iso(e.since),
          checked_at: iso(e.checked_at),
        };
      }
      return { v: 1, printers: out };
    },

    /** Durable state for the cache file (loadEntries reads it back). */
    serialize() {
      /** @type {Record<string, object>} */
      const out = {};
      for (const [id, e] of printers) {
        out[id] = {
          port: e.port,
          configured_host: e.configured_host,
          mac: e.mac,
          mac_host: e.mac_host,
          learned_at: e.learned_at,
          followed_host: e.followed_host,
          followed_from: e.followed_from,
          followed_at: e.followed_at,
          state: e.state,
          since: e.since,
          checked_at: e.checked_at,
          host_mac: e.host_mac,
          other_printer_id: e.other_printer_id,
        };
      }
      return { v: 1, printers: out };
    },

    stop() {
      if (learnTimer) clearTimeout(learnTimer);
      learnTimer = null;
      if (recheckTimer) clearTimeout(recheckTimer);
      recheckTimer = null;
    },
  };
}
