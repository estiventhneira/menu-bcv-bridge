#!/usr/bin/env node
/**
 * fujun-bridge — local WiFi print bridge.
 *
 * Connects to Supabase, watches `print_jobs` for the configured restaurants,
 * and prints every pending job whose target printer is driven from this PC:
 * transport 'wifi' over TCP:9100, 'usb_bridge' through the OS spooler.
 *
 * 0.7.0 adds a LAN print server (lan-server.mjs): tablets on the restaurant
 * network hand tickets straight to this process — LAN-first while online,
 * and the only way to reach these printers while the internet is down. The
 * bridge also boots without internet now, from a cached printer list.
 *
 * 0.8.0 makes it the restaurant's offline hub: tablets relay their offline
 * orders to each other through it (lan-relay.mjs — the KDS and the caja see
 * an order taken on another tablet), hand it their signed operations so it
 * uploads them as soon as it is online even if the tablet is off
 * (lan-ops.mjs + lan-upload.mjs), and every printed ticket is kept for the
 * day so any tablet can reprint it (lan-archive.mjs).
 *
 * One process can drive many printers across one or more restaurants on the
 * same PC (e.g. a restaurant and its sucursal): run `pair` once per
 * restaurant — the same device account accumulates them.
 *
 * Setup (0.3.0+): `print-bridge pair <CODIGO> --url <app-url>` exchanges a
 * staff-generated pairing code for a scoped device account (anon key + auth
 * user confined by RLS to this restaurant's printers/print_jobs) and writes
 * ~/.fujun-bridge/config.json itself. See config.mjs for both config shapes;
 * legacy service-role configs still run, with a deprecation warning.
 */

import { createClient } from "@supabase/supabase-js";
import { loadConfig, parseLanSecrets, stateDir, updateConfigRaw } from "./config.mjs";
import { runPair } from "./pair.mjs";
import { startDiscovery, isConnectionError } from "./discover.mjs";
import { startSelfUpdate } from "./self-update.mjs";
import { disableQuickEdit } from "./console-mode.mjs";
import { VERSION } from "./version.mjs";
import { renderKitchenTicket } from "./template.mjs";
import { renderCajaReport } from "./caja-report.mjs";
import { paperDotsForWidth } from "./raster-text.mjs";
import { JETBRAINS_MONO } from "./fonts/jetbrains-mono.atlas.mjs";
import { sendOverTcp } from "./printer-tcp.mjs";
import { sendOverSpooler } from "./printer-spooler.mjs";
import { DRAIN_SLOW_MS, DRAIN_TICK_MS, drainDue, drainIntervalMs } from "./drain-poll.mjs";
import { createPrinterChains, startJobs } from "./job-queue.mjs";
import { buildAllowedOrigins, createLanServer } from "./lan-server.mjs";
import { createLanStore, LAN_MAX_ATTEMPTS, lanRetryDelayMs } from "./lan-journal.mjs";
import { peekLanTokenClaims, verifyLanToken } from "./lan-token.mjs";
import { lanAddresses, startLanEndpointsReporter } from "./lan-endpoints.mjs";
import { loadPrinterCache, savePrinterCache } from "./printer-cache.mjs";
import { createRelayBoard } from "./lan-relay.mjs";
import { createOpsStore } from "./lan-ops.mjs";
import { createOpsUploader } from "./lan-upload.mjs";
import { createTicketArchive } from "./lan-archive.mjs";
import crypto from "node:crypto";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv[0] === "pair") {
  await runPair(argv.slice(1));
  process.exit(0);
}

// Windows: a stray click inside the console window puts conhost into
// QuickEdit selection mode, and every console write blocks until someone
// presses Enter — which froze a whole bridge for 10+ hours in the field
// (see console-mode.mjs). Turn it off before the first log line.
await disableQuickEdit({ log });

const cfg = loadConfig();
const supabase = createClient(
  cfg.supabaseUrl,
  cfg.mode === "device" ? cfg.anonKey : cfg.serviceRoleKey,
  {
    // Device mode: supabase-js refreshes the 1h access token on its own and
    // forwards each new token to realtime — no manual auth plumbing here.
    auth: {
      autoRefreshToken: cfg.mode === "device",
      persistSession: false,
      detectSessionInUrl: false,
    },
  },
);

// Device mode: `bridge:<auth user id>` (stable across label edits, and what
// the claim/heartbeat RPCs stamp server-side). Known before sign-in when a
// previous run persisted the uid (0.7.0) — an offline boot still answers LAN
// hellos with the right "this printer is mine". Legacy mode keeps the
// historical label-hash id.
let DEVICE_ID = cfg.mode === "device" && cfg.deviceUserId
  ? `bridge:${cfg.deviceUserId}`
  : `bridge:${crypto.createHash("sha1").update(cfg.label).digest("hex").slice(0, 16)}`;

/**
 * Signs in with the device credentials, retrying forever on transient errors
 * (the PC may boot before its network). A 400 means the credentials are
 * gone/revoked — that's fatal and needs a re-pair, so exit with a clear
 * message rather than hammering auth.
 */
async function signInDevice() {
  let delay = 5_000;
  for (;;) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: cfg.deviceEmail,
      password: cfg.devicePassword,
    });
    if (!error) return data.user.id;
    if (error.status === 400) {
      console.error("Credenciales del bridge inválidas o revocadas.");
      console.error("Vinculá de nuevo con: print-bridge pair <CODIGO> --url <url de la app>");
      process.exit(3);
    }
    log(`auth: ${error.message} — reintento en ${Math.round(delay / 1000)}s`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5 * 60_000);
  }
}

// id -> { restaurant_id, transport: 'wifi' | 'usb_bridge', name, host?, port?, os_printer_name?, ... }
const printers = new Map();
const inFlight = new Set();
// One job at a time per printer, printers in parallel — see job-queue.mjs.
const serialized = createPrinterChains();
// Discovery reporter (device mode only) — see discover.mjs.
let discovery = null;

// ── LAN print server state (0.7.0, device mode only) ─────────────────────
const STATE_DIR = stateDir();
const PRINTER_CACHE_FILE = path.join(STATE_DIR, "cache", "printers.json");
const lanEnabled = cfg.mode === "device" && !cfg.disableLanServer;
let lanStore = null;
if (lanEnabled) {
  try {
    lanStore = createLanStore({ dir: path.join(STATE_DIR, "lan"), log });
  } catch (e) {
    console.error(`LAN: no se pudo abrir ${path.join(STATE_DIR, "lan")} (${e.message}) — impresión por red local desactivada`);
  }
}
// 0.8.0 stores. Each is independent: a broken one switches off only its own
// feature (hello stops advertising it), never printing.
let relayBoard = null;
let opsStore = null;
let archive = null;
let uploader = null;
if (lanStore) {
  try {
    relayBoard = createRelayBoard({ dir: path.join(STATE_DIR, "lan", "relay"), log });
  } catch (e) {
    console.error(`LAN: tablero de pedidos desactivado (${e.message})`);
  }
  try {
    opsStore = createOpsStore({ dir: path.join(STATE_DIR, "lan", "ops"), log });
  } catch (e) {
    console.error(`LAN: subida de operaciones desactivada (${e.message})`);
  }
  try {
    archive = createTicketArchive({ dir: path.join(STATE_DIR, "lan", "archive"), log });
  } catch (e) {
    console.error(`LAN: archivo de tickets desactivado (${e.message})`);
  }
}
// Where the store-and-forward uploader posts (configs paired before 0.7.0
// have no app_origin).
const DEFAULT_APP_ORIGIN = "https://andescocina.com";
// bridge_tokens.id -> { bridgeTokenId, restaurantId, secret } (LAN token keys)
let lanSecrets = new Map((cfg.lanSecrets ?? []).map((x) => [x.bridgeTokenId, x]));
let lanPort = null; // set once the LAN server is listening
let lanEndpoints = null;
// True once the device signed in: cloud claims/acks are only attempted then
// (an anon update is a silent 0-row no-op, indistinguishable from "lost").
let cloudReady = cfg.mode !== "device";
const lanRetryTimers = new Map(); // job_key -> timeout

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function reloadPrinters() {
  const { data, error } = await supabase
    .from("printers")
    .select("id, restaurant_id, name, transport, connection, is_active, chars_per_line, paper_width_mm, print_settings, claimed_by_device_id")
    .in("restaurant_id", cfg.restaurantIds)
    .in("transport", ["wifi", "usb_bridge"])
    .eq("is_active", true);
  if (error) {
    log("ERROR fetching printers:", error.message);
    return;
  }
  printers.clear();
  for (const p of data ?? []) {
    const c = p.connection ?? {};
    // Body width for this printer's paper (80mm ≈ 48, 58mm ≈ 32). Threaded
    // into renderKitchenTicket so tickets fit the configured paper size.
    const charsPerLine = Number(p.chars_per_line) || 48;
    // Per-printer formatting + line toggles (bold, spacing, size, visible
    // lines). Threaded alongside chars_per_line into the renderer.
    const printSettings = p.print_settings ?? {};
    // Head width in dots — raster-font tickets clamp their columns to it.
    const paperDots = paperDotsForWidth(p.paper_width_mm);
    if (p.transport === "wifi") {
      if (!c.host) continue;
      printers.set(p.id, {
        restaurant_id: p.restaurant_id,
        transport: "wifi",
        name: p.name,
        host: c.host,
        port: Number(c.port) || 9100,
        chars_per_line: charsPerLine,
        paper_dots: paperDots,
        print_settings: printSettings,
        claimed_by: p.claimed_by_device_id ?? null,
      });
    } else if (p.transport === "usb_bridge") {
      if (!c.os_printer_name) continue;
      printers.set(p.id, {
        restaurant_id: p.restaurant_id,
        transport: "usb_bridge",
        name: p.name,
        os_printer_name: c.os_printer_name,
        chars_per_line: charsPerLine,
        paper_dots: paperDots,
        print_settings: printSettings,
        claimed_by: p.claimed_by_device_id ?? null,
      });
    }
  }
  const describe = (p) => p.transport === "wifi"
    ? `${p.name}@${p.host}:${p.port}`
    : `${p.name}@spooler:${p.os_printer_name}`;
  // Only announce when the tracked set actually changed — this runs on every
  // printers event and used to flood the console during setup.
  const signature = Array.from(printers.values()).map(describe).sort().join(", ") || "(none)";
  if (signature !== lastTrackedSignature) {
    lastTrackedSignature = signature;
    log(`tracking ${printers.size} printer(s):`, signature);
  }
  savePrintersForOfflineBoot();
  // A LAN ticket queued while its printer was unknown (cold offline boot) or
  // since removed: resume it now, or park it as failed.
  resumeLanQueue({ afterCloudReload: true });
}
let lastTrackedSignature = null;

// Offline boot (0.7.0): the list above is written to disk on every change and
// read back before sign-in, so a PC that boots without internet still prints
// what tablets send over the LAN.
let lastCachedJson = null;
function savePrintersForOfflineBoot() {
  if (!lanEnabled) return;
  const json = JSON.stringify([...printers.entries()]);
  if (json === lastCachedJson) return;
  try {
    savePrinterCache(PRINTER_CACHE_FILE, printers);
    lastCachedJson = json;
  } catch (e) {
    log(`ERROR guardando la lista de impresoras: ${e.message}`);
  }
}

function restorePrintersFromCache() {
  const cached = loadPrinterCache(PRINTER_CACHE_FILE);
  if (!cached) return;
  for (const { id, ...p } of cached.printers) {
    if (cfg.restaurantIds.includes(p.restaurant_id)) printers.set(id, p);
  }
  lastCachedJson = JSON.stringify([...printers.entries()]);
  log(`printers: ${printers.size} desde la caché local (guardada ${cached.savedAt ?? "?"})`);
}

async function claimPrinters() {
  // Atomically claim our printers to this bridge so the UI shows it's online.
  //
  // CRITICAL: only write for printers we don't already hold. A claim write is
  // itself a `printers` UPDATE, which realtime echoes back to our own
  // subscription, whose handler claims again — an unconditional claim turns
  // that echo into a self-sustaining write loop (0.4.2 field incident: the
  // console "went crazy" while printers were being added). Claiming only
  // not-mine rows makes the steady state write nothing, so the echo dies.
  const ids = Array.from(printers.entries())
    .filter(([, p]) => p.claimed_by !== DEVICE_ID)
    .map(([id]) => id);
  if (ids.length === 0) return;
  if (cfg.mode === "device") {
    // Devices have no UPDATE policy on printers (a compromised one must not
    // be able to rewrite `connection`); the SECURITY DEFINER RPC does the
    // claim with the same unclaimed-or-mine-or-stale guard (migration 200).
    const { data, error } = await supabase.rpc("bridge_claim_printers", {
      p_printer_ids: ids,
      p_version: VERSION,
    });
    if (error) log("ERROR claiming printers:", error.message);
    for (const id of data ?? []) {
      const p = printers.get(id);
      if (p) p.claimed_by = DEVICE_ID;
    }
    return;
  }
  const { data } = await supabase
    .from("printers")
    .update({
      claimed_by_device_id: DEVICE_ID,
      claimed_at: new Date().toISOString(),
      bridge_version: VERSION,
    })
    .in("id", ids)
    .or(`claimed_by_device_id.is.null,claimed_by_device_id.eq.${DEVICE_ID}`)
    .select("id");
  for (const row of data ?? []) {
    const p = printers.get(row.id);
    if (p) p.claimed_by = DEVICE_ID;
  }
}

async function heartbeat() {
  const ids = Array.from(printers.keys());
  // NOTE: no early return on zero printers in device mode — a freshly paired
  // bridge with no printers configured yet must still stamp
  // bridge_tokens.last_seen_at, or the settings page shows "nunca conectado"
  // for a bridge that is alive and waiting (0.4.1 field report).
  // bridge_version rides along on every heartbeat, not just the claim: an
  // upgraded binary restarting onto printers it already owns wouldn't
  // otherwise refresh the number until something re-claimed them.
  if (cfg.mode === "device") {
    // Also stamps bridge_tokens.last_seen_at — the CRM platform-health
    // "Bridge caído" rollups read it.
    const { error } = await supabase.rpc("bridge_heartbeat", {
      p_printer_ids: ids,
      p_version: VERSION,
    });
    if (error) log("ERROR heartbeat:", error.message);
    return;
  }
  if (ids.length === 0) return; // legacy mode has no bridge_tokens row to stamp
  await supabase
    .from("printers")
    .update({ last_seen_at: new Date().toISOString(), bridge_version: VERSION })
    .in("id", ids);
}

async function processJob(job) {
  if (inFlight.has(job.id)) return;
  // 0.7.0: a cloud row this bridge already printed (over the LAN, or its
  // `done` ack never landed) came back — via realtime, the poll, or the
  // 5-min reaper re-pending it. Ack it; never print it twice.
  if (!job.lan && lanStore?.isPrinted(job.id)) {
    await ackJournaled(job.id);
    return;
  }
  const printer = printers.get(job.printer_id);
  if (!printer) return; // not our printer
  inFlight.add(job.id);
  try {
    // The claim waits inside the chain, so a queued job stays 'pending'
    // (never reaped as stuck) and a poll re-delivery hits the guard above.
    return await serialized(job.printer_id, () => runJob(job, printer));
  } finally {
    inFlight.delete(job.id);
  }
}

/** ESC/POS bytes for a job on this printer (same renderers for every path). */
function renderJob(job, printer) {
  // caja_movement (240) = retiro/ingreso voucher — same section renderer as
  // the cierre report, so one branch covers both.
  // Raster font (print_settings.font = "raster:jetbrains-mono"): the
  // renderer only uses the atlas when the settings name it, so passing it
  // unconditionally is safe — ROM-font printers stay byte-identical.
  const renderOpts = { rasterFont: JETBRAINS_MONO, paperDots: printer.paper_dots };
  return job.kind === "caja_report" || job.kind === "caja_movement"
    ? renderCajaReport(job.payload, printer.chars_per_line, printer.print_settings, renderOpts)
    : renderKitchenTicket(job.payload, printer.chars_per_line, printer.print_settings, renderOpts);
}

async function sendToPrinter(printer, bytes) {
  if (printer.transport === "wifi") {
    await sendOverTcp(printer.host, printer.port, bytes);
  } else if (printer.transport === "usb_bridge") {
    await sendOverSpooler(printer.os_printer_name, bytes);
  } else {
    throw new Error(`unknown transport: ${printer.transport}`);
  }
}

function noteSendFailure(printer, e) {
  // A wifi printer that stopped answering may have moved to a new DHCP
  // address — rescan (debounced) so the app can suggest the fix.
  if (printer.transport === "wifi" && isConnectionError(e)) {
    discovery?.triggerFailureRescan();
  }
}

/** Resolves `fallback` if `p` hasn't settled within `ms`. */
function within(p, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

/** Signed in with a live session — claims/acks would otherwise run as anon
 *  and silently match 0 rows. Bounded: an expired token refreshes over the
 *  network, which must not stall a LAN print. */
async function hasCloudSession() {
  if (cfg.mode !== "device") return true;
  if (!cloudReady) return false;
  return within(
    supabase.auth.getSession().then(({ data }) => !!data?.session, () => false),
    2_000,
    false,
  );
}

/**
 * @returns {Promise<"printed" | "skipped" | "failed">}
 */
async function runJob(job, printer) {
  if (job.lan?.source === "offline") return runOfflineLanJob(job, printer);
  // A cloud print_jobs row: from realtime / the poll, or forwarded over the
  // LAN by the tablet that just created it (job.lan set).
  const lan = job.lan ?? null;
  let claimed = false;
  let blind = false;
  let claimedOrderId = null;
  try {
    if (lan && !(await hasCloudSession())) {
      blind = true;
    } else {
      // Atomic claim: only proceed if we were the one to flip pending→in_progress.
      let claim = supabase
        .from("print_jobs")
        .update({ status: "in_progress", claimed_at: new Date().toISOString() })
        .eq("id", job.id)
        .eq("status", "pending");
      // A LAN request names the row; pin it to what the token and the
      // request vouch for, so a mismatch reads as "not mine" (0 rows).
      if (lan) claim = claim.eq("restaurant_id", job.restaurant_id).eq("printer_id", job.printer_id).eq("kind", job.kind);
      // order_id rides along for the reprint archive (LAN-forwarded rows
      // don't carry it).
      const claimQuery = claim.select("id, order_id").maybeSingle();
      const { data: claimedRow, error: claimErr } = lan
        ? await within(claimQuery, 4_000, { data: null, error: { message: "timeout" } })
        : await claimQuery;
      if (claimErr) {
        if (!lan) throw claimErr;
        // Forwarded over the LAN and the cloud didn't answer: print anyway.
        // The journal acks the row once the cloud is back, and this bridge
        // never prints a journaled row twice.
        blind = true;
      } else if (!claimedRow) {
        // Printed by someone else, held, or cancelled — never journal it.
        log(`skip job ${job.id} (already claimed)`);
        return "skipped";
      } else {
        claimed = true;
        claimedOrderId = claimedRow.order_id ?? null;
      }
    }

    log(`printing job ${job.id} → ${printer.name} (${printer.transport})${lan ? " [red local]" : ""}${blind ? " [sin nube]" : ""}`);
    const bytes = renderJob(job, printer);
    await sendToPrinter(printer, bytes);
    archiveTicket({ ...job, order_id: job.order_id ?? claimedOrderId }, printer, lan ? "lan" : "cloud");
    if (blind) {
      lanStore?.markPrinted(job.id, { src: "cloud", pid: job.printer_id, kind: job.kind, acked: false });
      log(`ok job ${job.id} (${bytes.length} bytes, se confirma al volver la conexión)`);
      return "printed";
    }
    const acked = await markDone(job.id);
    // Journal LAN prints, and any print whose ack failed: the reaper would
    // re-pend that row in 5 min and the poll would print it again.
    if (lan || !acked) {
      lanStore?.markPrinted(job.id, { src: "cloud", pid: job.printer_id, kind: job.kind, acked });
    }
    log(`ok job ${job.id} (${bytes.length} bytes)`);
    return "printed";
  } catch (e) {
    log(`FAIL job ${job.id}: ${e.message}`);
    noteSendFailure(printer, e);
    // Never claimed (printed blind over the LAN): the row is still pending in
    // the cloud and this bridge picks it up from there when it reconnects.
    if (lan && !claimed) return "failed";
    // Bump attempts; mark failed when too many.
    const { data: cur } = await supabase
      .from("print_jobs")
      .select("attempts")
      .eq("id", job.id)
      .single();
    const attempts = (cur?.attempts ?? 0) + 1;
    const giveUp = attempts >= cfg.maxAttempts;
    const { error: requeueErr } = await supabase
      .from("print_jobs")
      .update({
        status: giveUp ? "failed" : "pending",
        attempts,
        error: e.message,
        claimed_at: null,
      })
      .eq("id", job.id);
    // Left in_progress — reapStuckJobs re-queues it within minutes.
    if (requeueErr) log(`ERROR requeueing job ${job.id}:`, requeueErr.message);
    return "failed";
  }
}

/**
 * Ack a printed job, retrying a failed write: a job left in_progress after it
 * printed would be re-queued by reapStuckJobs 5 min later and print twice.
 * @returns {Promise<boolean>} whether the ack landed
 */
async function markDone(jobId) {
  for (let attempt = 1; ; attempt++) {
    const { error } = await supabase
      .from("print_jobs")
      .update({ status: "done", completed_at: new Date().toISOString(), error: null })
      .eq("id", jobId);
    if (!error) return true;
    if (attempt === 3) {
      log(`ERROR marking job ${jobId} done:`, error.message);
      return false;
    }
    await new Promise((r) => setTimeout(r, 2_000 * attempt));
  }
}

// ── LAN print server (0.7.0) ─────────────────────────────────────────────

/**
 * An offline-created ticket (no print_jobs row exists, and none will: the
 * tablet reported the pair as printed once we accepted it). The durable
 * queue file is the only record, so failures retry locally and finally park
 * as "failed" for a manual reprint from Configuración > Impresoras.
 */
async function runOfflineLanJob(job, printer) {
  try {
    log(`printing LAN job ${job.id} → ${printer.name} (${printer.transport}, pedido sin conexión)`);
    const bytes = renderJob(job, printer);
    await sendToPrinter(printer, bytes);
    archiveTicket(job, printer, "offline");
    lanStore.markPrinted(job.id, { src: "offline", pid: job.printer_id, kind: job.kind, acked: true });
    log(`ok LAN job ${job.id} (${bytes.length} bytes)`);
    return "printed";
  } catch (e) {
    log(`FAIL LAN job ${job.id}: ${e.message}`);
    noteSendFailure(printer, e);
    const rec = lanStore.getJob(job.id);
    if (!rec) return "failed";
    const attempts = (rec.attempts ?? 0) + 1;
    if (attempts >= LAN_MAX_ATTEMPTS) {
      lanStore.saveJob({ ...rec, attempts, state: "failed", last_error: e.message, failed_at: Date.now() });
      log(`LAN job ${job.id} sin imprimir tras ${attempts} intentos — reimprímelo desde Configuración > Impresoras`);
    } else {
      lanStore.saveJob({ ...rec, attempts, last_error: e.message });
      scheduleLanRetry(job.id, lanRetryDelayMs(attempts));
    }
    return "failed";
  }
}

function lanJobFromRecord(rec) {
  return {
    id: rec.job_key,
    restaurant_id: rec.restaurant_id,
    printer_id: rec.printer_id,
    order_id: rec.order_id ?? null,
    kind: rec.kind,
    payload: rec.payload,
    status: "pending",
    lan: { source: "offline" },
  };
}

/** Keep a printed ticket in the day's archive (0.8.0). Never throws. */
function archiveTicket(job, printer, source, extra = {}) {
  if (!archive || job.kind === "test") return;
  archive.record({
    id: job.id,
    r: job.restaurant_id ?? printer.restaurant_id,
    kind: job.kind,
    printer_id: job.printer_id,
    printer_name: printer.name,
    order_id: job.order_id ?? null,
    payload: job.payload,
    source,
    reprint_of: extra.reprintOf ?? null,
    user_id: extra.userId ?? null,
  });
}

function submitLanJob(job) {
  processJob(job).catch((e) => log(`ERROR LAN job ${job.id}: ${e?.message ?? e}`));
}

function scheduleLanRetry(key, ms) {
  if (lanRetryTimers.has(key)) return;
  lanRetryTimers.set(key, setTimeout(() => {
    lanRetryTimers.delete(key);
    const rec = lanStore?.getJob(key);
    if (rec && rec.state === "queued") submitLanJob(lanJobFromRecord(rec));
  }, ms));
}

/**
 * Re-submit queued offline tickets: at boot (the queue survives restarts)
 * and after each cloud printer reload. A ticket whose printer the cloud no
 * longer lists (deleted / deactivated) is parked as failed.
 */
function resumeLanQueue({ afterCloudReload = false } = {}) {
  if (!lanStore || lanPort === null) return;
  for (const rec of lanStore.queuedJobs()) {
    if (inFlight.has(rec.job_key) || lanRetryTimers.has(rec.job_key)) continue;
    if (printers.has(rec.printer_id)) {
      submitLanJob(lanJobFromRecord(rec));
    } else if (afterCloudReload) {
      lanStore.saveJob({ ...rec, state: "failed", last_error: "impresora no encontrada", failed_at: Date.now() });
      log(`LAN job ${rec.job_key}: la impresora ya no existe — marcado como fallido`);
    }
  }
}

/** Ack a journaled cloud row (printed here, `done` never confirmed). */
async function ackJournaled(jobId) {
  if (!lanStore || !(await hasCloudSession())) return;
  const { error } = await supabase
    .from("print_jobs")
    .update({ status: "done", completed_at: new Date().toISOString(), error: null })
    .eq("id", jobId)
    .in("status", ["pending", "in_progress"]);
  if (error) {
    log(`ERROR confirmando job ${jobId}:`, error.message);
    return;
  }
  // 0 rows is fine too: already done, cancelled or purged — nothing to fix.
  lanStore.markAcked(jobId);
}

let flushingAcks = false;
async function flushJournalAcks() {
  if (!lanStore || flushingAcks) return;
  const keys = lanStore.unackedCloudKeys();
  if (keys.length === 0) return;
  flushingAcks = true;
  try {
    for (const key of keys) await ackJournaled(key);
    const left = lanStore.unackedCloudKeys().length;
    log(`lan: ${keys.length - left} impresión(es) confirmada(s) en la nube${left ? `, ${left} pendiente(s)` : ""}`);
  } finally {
    flushingAcks = false;
  }
}

function verifyLanRequestToken(token) {
  const peek = peekLanTokenClaims(token);
  if (!peek) return { ok: false, reason: "malformed" };
  const sec = lanSecrets.get(peek.t);
  if (!sec) return { ok: false, reason: "unknown_pairing" };
  if (sec.restaurantId !== peek.r || !cfg.restaurantIds.includes(peek.r)) {
    return { ok: false, reason: "restaurant" };
  }
  return verifyLanToken(sec.secret, token);
}

function lanHello(claims) {
  const list = [...printers.entries()]
    .filter(([, p]) => p.restaurant_id === claims.r)
    .map(([id, p]) => ({ id, name: p.name, transport: p.transport, claimed_by_me: p.claimed_by === DEVICE_ID }));
  const failed = (lanStore?.failedJobs({ restaurantId: claims.r }) ?? []).map((j) => ({
    job_key: j.job_key,
    printer_id: j.printer_id,
    kind: j.kind,
    order: j.payload?.order_number ?? null,
    error: j.last_error ?? null,
    at: j.failed_at ? new Date(j.failed_at).toISOString() : null,
  }));
  const features = [];
  if (relayBoard) features.push("relay", "seq");
  if (relayBoard && opsStore) features.push("ops");
  if (archive) features.push("archive");
  return {
    device_id: DEVICE_ID,
    now: new Date().toISOString(),
    restaurant_id: claims.r,
    cloud: cloudReady,
    printers: list,
    failed,
    // 0.8.0 — what the app may use on this bridge, and how much offline work
    // it holds for this restaurant.
    features,
    ...(relayBoard ? { relay: relayBoard.stats(claims.r) } : {}),
    ...(opsStore ? { ops: opsStore.stats(claims.r) } : {}),
    ...(archive ? { archive: { today: archive.countToday(claims.r) } } : {}),
  };
}

function lanPrint(claims, job) {
  const printer = printers.get(job.printer_id);
  if (!printer || printer.restaurant_id !== claims.r) {
    return { status: 404, body: { ok: false, error: "unknown_printer" } };
  }
  if (lanStore.isPrinted(job.job_key)) return { status: 200, body: { ok: true, status: "duplicate" } };
  const existing = lanStore.getJob(job.job_key);
  if (existing) {
    return existing.state === "failed"
      ? { status: 200, body: { ok: false, status: "failed", error: existing.last_error ?? null } }
      : { status: 200, body: { ok: true, status: "duplicate" } };
  }
  if (inFlight.has(job.job_key)) return { status: 200, body: { ok: true, status: "in_progress" } };

  if (job.source === "offline") {
    // "accepted" = durably queued: the tablet reports this pair as printed and
    // the server will never create a cloud job for it.
    try {
      lanStore.saveJob({
        job_key: job.job_key,
        source: "offline",
        restaurant_id: claims.r,
        printer_id: job.printer_id,
        kind: job.kind,
        payload: job.payload,
        order_id: job.order_id ?? null,
        user_id: claims.u,
        accepted_at: Date.now(),
        attempts: 0,
        state: "queued",
        last_error: null,
      });
    } catch (e) {
      log(`ERROR guardando LAN job ${job.job_key}: ${e.message}`);
      return { status: 503, body: { ok: false, error: "disk" } };
    }
  }
  log(`lan: ${job.kind} → ${printer.name} (${job.source === "offline" ? "pedido sin conexión" : "red local"}, ${job.job_key.slice(0, 12)})`);
  submitLanJob({
    id: job.job_key,
    restaurant_id: claims.r,
    printer_id: job.printer_id,
    order_id: job.order_id ?? null,
    kind: job.kind,
    payload: job.payload,
    status: "pending",
    lan: { source: job.source },
  });
  return { status: 202, body: { ok: true, status: "accepted" } };
}

function lanRetry(claims, key) {
  const rec = lanStore.getJob(key);
  if (!rec || rec.restaurant_id !== claims.r) return { status: 404, body: { ok: false, error: "unknown_job" } };
  if (rec.state !== "failed") return { status: 200, body: { ok: true, status: "queued" } };
  lanStore.saveJob({ ...rec, state: "queued", attempts: 0, last_error: null, failed_at: null });
  log(`lan: reimprimiendo ${key} (pedido desde Configuración)`);
  submitLanJob(lanJobFromRecord(rec));
  return { status: 202, body: { ok: true, status: "accepted" } };
}

// ── 0.8.0: relay board, store-and-forward, ticket archive ───────────────

const NOT_FOUND = { status: 404, body: { ok: false, error: "not_found" } };

function relayPush(claims, push) {
  if (!relayBoard) return NOT_FOUND;
  let op = "none";
  if (push.envelope && opsStore) {
    // A token for restaurant A must not queue operations for restaurant B.
    if (push.envelope.restaurant_id !== claims.r) {
      return { status: 400, body: { ok: false, error: "envelope_restaurant" } };
    }
    if (relayBoard.isResolved(push.envelope.key)) {
      op = "known";
    } else {
      try {
        op = opsStore.add(claims.r, push.envelope);
      } catch (e) {
        log(`ops: no se pudo guardar ${push.envelope.key} (${e.message})`);
        return { status: 503, body: { ok: false, error: "disk" } };
      }
      if (op === "queued") uploader?.kick();
    }
  }
  const { v } = relayBoard.push(claims.r, push);
  return { status: 200, body: { ok: true, v, epoch: relayBoard.epoch, op } };
}

async function relayPull(claims, pull, signal) {
  if (!relayBoard) return NOT_FOUND;
  const current = relayBoard.version(claims.r);
  // Another board's cursor (store wiped, new PC) or one from the future:
  // the device starts over from 0.
  if ((pull.epoch && pull.epoch !== relayBoard.epoch) || pull.since > current) {
    return { status: 200, body: { ok: true, reset: true, epoch: relayBoard.epoch, ...relayBoard.pull(claims.r, 0) } };
  }
  if (current <= pull.since && pull.wait_ms > 0) {
    await relayBoard.waitForChange(claims.r, pull.since, pull.wait_ms, signal);
  }
  return { status: 200, body: { ok: true, epoch: relayBoard.epoch, ...relayBoard.pull(claims.r, pull.since) } };
}

function relayAck(claims, ack) {
  if (!relayBoard) return NOT_FOUND;
  if (opsStore) {
    for (const [list, how] of [[ack.synced, "synced"], [ack.dropped, "dropped"], [ack.failed, "failed"]]) {
      for (const key of list) {
        if (opsStore.get(key)?.r === claims.r) opsStore.markDevice(key, how);
      }
    }
  }
  relayBoard.ack(claims.r, { synced: ack.synced, dropped: ack.dropped });
  return { status: 200, body: { ok: true } };
}

function relaySeq(claims, seq) {
  if (!relayBoard) return NOT_FOUND;
  return { status: 200, body: { ok: true, n: relayBoard.nextSeq(claims.r, seq.day, seq.min) } };
}

function ticketsList(claims, q) {
  if (!archive) return NOT_FOUND;
  const tickets = archive.list(claims.r, { orderId: q.order_id, sinceMs: q.since_ms, limit: q.limit, kinds: q.kinds });
  return { status: 200, body: { ok: true, tickets } };
}

/**
 * Print an archived ticket again, with the «REIMPRESION» banner. Answers
 * printed / failed when the printer settles within a few seconds (the
 * person is waiting at the screen), else accepted.
 */
async function ticketReprint(claims, req) {
  if (!archive) return NOT_FOUND;
  const rec = archive.get(req.id);
  if (!rec || rec.r !== claims.r) return { status: 404, body: { ok: false, error: "unknown_ticket" } };
  const printerId = req.printer_id ?? rec.printer_id;
  const printer = printers.get(printerId);
  if (!printer || printer.restaurant_id !== claims.r) return { status: 404, body: { ok: false, error: "unknown_printer" } };
  const payload = rec.payload && typeof rec.payload === "object" ? rec.payload : {};
  const job = {
    id: `reprint-${crypto.randomUUID()}`,
    restaurant_id: claims.r,
    printer_id: printerId,
    order_id: rec.order_id ?? null,
    kind: rec.kind,
    payload: { ...payload, meta: { ...(payload.meta ?? {}), reprint: true } },
  };
  inFlight.add(job.id);
  const run = serialized(printerId, async () => {
    const bytes = renderJob(job, printer);
    await sendToPrinter(printer, bytes);
    archiveTicket(job, printer, "reprint", { reprintOf: rec.id, userId: claims.u });
    log(`lan: reimpresión de ${rec.kind} → ${printer.name} (${rec.order_number ?? rec.label ?? rec.id.slice(0, 8)})`);
  }).finally(() => inFlight.delete(job.id));
  const outcome = await within(
    run.then(
      () => "printed",
      (e) => {
        log(`lan: falló la reimpresión → ${printer.name}: ${e.message}`);
        noteSendFailure(printer, e);
        return { error: e.message };
      },
    ),
    8_000,
    "accepted",
  );
  if (outcome === "printed") return { status: 200, body: { ok: true, status: "printed" } };
  if (outcome === "accepted") return { status: 202, body: { ok: true, status: "accepted" } };
  return { status: 200, body: { ok: false, status: "failed", error: outcome.error } };
}

async function startLanServer() {
  if (!lanEnabled) {
    log(cfg.mode === "device"
      ? "lan: desactivado por config (disable_lan_server)"
      : "lan: desactivado en modo legacy (service role) — re-pareá con: print-bridge pair <CODIGO>");
    return;
  }
  if (!lanStore) return;
  lanStore.compact();
  const server = createLanServer({
    version: VERSION,
    allowedOrigins: buildAllowedOrigins({
      appOrigin: cfg.appOrigin,
      extra: cfg.allowedOrigins,
      dev: VERSION === "dev",
    }),
    verify: verifyLanRequestToken,
    hello: lanHello,
    print: lanPrint,
    retry: lanRetry,
    ...(relayBoard ? { relayPush, relayPull, relayAck, relaySeq } : {}),
    ...(archive ? { ticketsList, ticketReprint } : {}),
    log,
  });
  try {
    lanPort = await server.listen(cfg.lanPort);
  } catch (e) {
    log(`lan: no se pudo abrir el puerto ${cfg.lanPort} (${e.code ?? e.message}) — impresión por red local desactivada`);
    return;
  }
  const addrs = lanAddresses();
  log(`lan: escuchando en ${addrs.length ? addrs.map((a) => `${a}:${lanPort}`).join(", ") : `puerto ${lanPort} (sin red)`}`);
  if (lanSecrets.size === 0) log("lan: aún sin claves — se descargan al conectar con la nube");
  setInterval(() => lanStore.compact(), 24 * 60 * 60_000);
  // 0.8.0 housekeeping: purge settled relay orders every minute, rewrite the
  // append-only files hourly.
  relayBoard?.sweep();
  relayBoard?.compact();
  opsStore?.compact();
  setInterval(() => relayBoard?.sweep(), 60_000);
  setInterval(() => {
    relayBoard?.compact();
    opsStore?.compact();
    archive?.compact();
  }, 60 * 60_000);
  process.on("SIGINT", () => { void server.close(); });
  resumeLanQueue();
}

/** Fetch this device's LAN token keys (one per pairing row) and persist them,
 *  so tokens verify on an offline boot too. */
async function refreshLanSecrets() {
  if (!lanEnabled) return;
  const { data, error } = await supabase.rpc("bridge_lan_secrets");
  if (error) {
    // Migration 277 not applied yet, or a blip: tokens keep verifying with
    // the persisted keys, and the next refresh tries again.
    log(`lan: no se pudieron leer las claves (${error.message})`);
    return;
  }
  const list = (Array.isArray(data) ? data : []).map((r) => ({
    bridge_token_id: r.bridge_token_id,
    restaurant_id: r.restaurant_id,
    lan_secret: r.lan_secret,
  }));
  lanSecrets = new Map(parseLanSecrets(list).map((x) => [x.bridgeTokenId, x]));
  updateConfigRaw((raw) => {
    if (JSON.stringify(raw.lan_secrets ?? null) === JSON.stringify(list)) return false;
    raw.lan_secrets = list;
    return true;
  });
}

/** Cloud-side LAN chores, once signed in. Never throws. */
async function lanAfterSignIn(userId) {
  if (!lanEnabled) return;
  updateConfigRaw((raw) => {
    if (raw.device_user_id === userId) return false;
    raw.device_user_id = userId;
    return true;
  });
  await refreshLanSecrets();
  setInterval(() => { void refreshLanSecrets(); }, 30 * 60_000);
  if (lanPort !== null && !lanEndpoints) {
    lanEndpoints = startLanEndpointsReporter({
      supabase,
      log,
      port: lanPort,
      version: VERSION,
      deviceId: () => DEVICE_ID,
    });
  }
  await flushJournalAcks();
  setInterval(() => { void flushJournalAcks(); }, 60_000);
  // Store-and-forward (0.8.0): operations devices left here go up now.
  if (opsStore && !uploader) {
    uploader = createOpsUploader({
      store: opsStore,
      onSynced: (key) => relayBoard?.opSynced(key),
      getAccessToken: async () => {
        const { data } = await supabase.auth.getSession();
        return data?.session?.access_token ?? null;
      },
      appOrigin: cfg.appOrigin || DEFAULT_APP_ORIGIN,
      version: VERSION,
      log,
    });
    uploader.start();
    const { queued } = opsStore.stats();
    if (queued > 0) log(`ops: ${queued} operación(es) de las tablets por subir`);
  }
}

// Stuck-claim reaper (0.6.8). A job can be left in_progress with nobody
// printing it — the claim committed but its response was lost in a network
// blip, and the requeue write above failed the same way. Only the startup
// reset in main() recovered those, and the browsers' reaper never runs where
// every printer is on a bridge: a Pronto Gourmet precuenta waited 4.7 h
// (2026-10-01) with a bridge restart as its only way back to the queue.
// Same RPC the browsers call: in_progress for 5+ min → pending, attempts + 1.
// Its other half (cancel jobs held 30+ min) is the browsers' rule too; a
// device account can't touch held rows, so for it that half matches nothing.
// Every 5 min rather than the browsers' 1: each call is a billed API log line
// (see drain-poll.mjs), and a stuck job is still back within 10 min.
const REAPER_INTERVAL_MS = 5 * 60_000;

async function reapStuckJobs() {
  for (const rid of cfg.restaurantIds) {
    const { data, error } = await supabase.rpc("reset_stuck_print_jobs", { p_restaurant_id: rid });
    if (error) {
      log("ERROR reaper:", error.message);
    } else if (data > 0) {
      log(`reaper: re-queued ${data} stuck job(s)`);
      scheduleSiblingDrain();
    }
  }
}

// Adaptive poll state (0.6.7, see drain-poll.mjs). Times are performance.now()
// — monotonic, so a wall-clock jump can't stall the poll.
const channelStatus = new Map(); // restaurant id -> last realtime subscribe status
const realtimeJobIds = new Set(); // pending jobs realtime delivered, oldest evicted
let lastDrainAt = null;
let lastMissAt = null;

function noteRealtimeJob(job) {
  if (job.status === "pending") {
    realtimeJobIds.add(job.id);
    // 500 ≫ the jobs a restaurant queues between two drains.
    if (realtimeJobIds.size > 500) realtimeJobIds.delete(realtimeJobIds.values().next().value);
  } else if (job.status === "held" && printers.has(job.printer_id)) {
    // Manual print mode: the job is released by an UPDATE held→pending,
    // which this INSERT-only channel never sees — the poll is its only path.
    lastMissAt = performance.now();
  }
}

async function drainPending() {
  const ids = Array.from(printers.keys());
  if (ids.length === 0) return;
  const startedAt = performance.now();
  const { data, error } = await supabase
    .from("print_jobs")
    .select("*")
    .in("restaurant_id", cfg.restaurantIds)
    .in("printer_id", ids)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) {
    log("ERROR draining:", error.message);
    return;
  }
  lastDrainAt = Math.max(lastDrainAt ?? 0, startedAt); // overlapping drains
  // A pending job realtime never handed us: it is dropping (or lagging on)
  // events, so poll fast for a while. A job seen here a moment before its
  // event lands counts too — conservative, not wrong.
  if ((data ?? []).some((j) => !realtimeJobIds.has(j.id))) lastMissAt = startedAt;
  await startJobs(data ?? [], processJob);
}

// Columns that change what/how the bridge prints. Heartbeat/claim writes
// (claimed_*, last_seen_at, bridge_version, updated_at) are deliberately NOT
// here: those are our own echoes coming back through realtime, and reacting
// to them is what fed the reload/claim write loop.
const PRINTER_CONFIG_COLS = [
  "name", "transport", "connection", "is_active", "chars_per_line", "paper_width_mm", "print_settings",
];

function printerEventMatters(payload) {
  if (payload.eventType !== "UPDATE") return true; // INSERT / DELETE always
  const o = payload.old;
  const n = payload.new;
  // Defensive: without the full old row (REPLICA IDENTITY not FULL) we can't
  // tell, so err on reloading.
  if (!o || !n || o.id === undefined) return true;
  return PRINTER_CONFIG_COLS.some((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
}

// One pending sweep max: a realtime job event arrived, so any siblings whose
// events were dropped are sitting pending — pick them up in seconds, not at
// the next poll (up to 15s away). processJob's atomic claim makes
// double-processing safe.
let siblingDrainTimer = null;
function scheduleSiblingDrain() {
  if (siblingDrainTimer) return;
  siblingDrainTimer = setTimeout(() => {
    siblingDrainTimer = null;
    void drainPending();
  }, 2_000);
}

// Coalesce bursts (adding several printers/stations fires many events in
// seconds) into one reload+claim, and never run them concurrently.
let printersRefreshTimer = null;
function schedulePrintersRefresh() {
  if (printersRefreshTimer) return;
  printersRefreshTimer = setTimeout(() => {
    printersRefreshTimer = null;
    void (async () => {
      await reloadPrinters();
      await claimPrinters();
    })().catch((e) => log("ERROR refreshing printers:", e.message));
  }, 1_000);
}

async function main() {
  log(`fujun-bridge v${VERSION} starting (label=${cfg.label}, mode=${cfg.mode}, restaurants=${cfg.restaurantIds.join(", ")})`);
  // Self-update runs in BOTH auth modes — it's what carries legacy installs
  // forward too. Applies only between prints, never mid-ticket (LAN tickets
  // included: they share inFlight, and queued ones survive the restart).
  // Started before sign-in so a bridge stuck signing in can still update.
  const selfUpdate = startSelfUpdate({
    log,
    isBusy: () => inFlight.size > 0,
    repo: cfg.updateRepo,
    disabled: cfg.disableAutoUpdate,
  });
  process.on("SIGINT", () => selfUpdate.stop());

  if (cfg.mode === "device") {
    // Offline-first boot (0.7.0): cached printers + the LAN server come up
    // before the sign-in, which retries forever without internet.
    if (lanEnabled) restorePrintersFromCache();
    await startLanServer();
    const userId = await signInDevice();
    DEVICE_ID = `bridge:${userId}`;
    cloudReady = true;
    log(`signed in as device ${userId}`);
    // If the session ever dies (refresh failed after a long offline stretch),
    // sign in again — the queries below would otherwise 401 forever. Guarded:
    // our own re-sign-in fires SIGNED_IN, which must not loop.
    let reauthing = false;
    supabase.auth.onAuthStateChange((_event, session) => {
      if (session || reauthing) return;
      reauthing = true;
      void signInDevice().then(() => { reauthing = false; });
    });
    await reloadPrinters();
    await claimPrinters();
    await lanAfterSignIn(userId);
  } else {
    await startLanServer(); // logs why it's off in legacy mode
    await reloadPrinters();
    await claimPrinters();
  }

  if (cfg.mode === "device" && !cfg.disableDiscovery) {
    discovery = startDiscovery({ supabase, log, label: cfg.label, version: VERSION });
  } else if (cfg.disableDiscovery) {
    log("discovery: desactivado por config (disable_discovery)");
  } else {
    log("discovery: desactivado en modo legacy (service role) — requiere cuenta de dispositivo; re-pareá con: print-bridge pair <CODIGO>");
  }
  await drainPending();

  // One channel per restaurant: postgres_changes filters only support a
  // single eq per subscription, and separate channels keep each sucursal's
  // stream independent.
  const channels = cfg.restaurantIds.map((rid) =>
    supabase
      .channel(`bridge-${rid}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "print_jobs",
          filter: `restaurant_id=eq.${rid}`,
        },
        (payload) => {
          noteRealtimeJob(payload.new);
          void processJob(payload.new);
          // Realtime drops some rows of a multi-job burst (field report:
          // an order's kitchen ticket arrived, its receipts didn't and sat
          // until the next poll). At least one sibling almost always lands,
          // so any arrival also sweeps for stragglers a moment later.
          scheduleSiblingDrain();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "printers",
          filter: `restaurant_id=eq.${rid}`,
        },
        (payload) => { if (printerEventMatters(payload)) schedulePrintersRefresh(); },
      )
      .subscribe((status) => {
        channelStatus.set(rid, status);
        log(`realtime[${rid.slice(0, 8)}]:`, status);
      }),
  );

  // Reset any in_progress jobs that belong to us but predate this process —
  // they were probably interrupted by a crash/restart. Mark them pending so
  // we'll retry them. Rows this bridge already printed (journaled, ack still
  // pending) are left alone: lanAfterSignIn acked them above, and any that
  // failed to ack are acked — not printed — when the poll sees them.
  const journaledUnacked = lanStore?.unackedCloudKeys() ?? [];
  let resetQuery = supabase
    .from("print_jobs")
    .update({ status: "pending", claimed_at: null })
    .eq("status", "in_progress")
    .in("printer_id", Array.from(printers.keys()));
  if (journaledUnacked.length > 0 && journaledUnacked.length <= 100) {
    resetQuery = resetQuery.not("id", "in", `(${journaledUnacked.join(",")})`);
  }
  await resetQuery;

  if (cfg.pollIntervalMs) {
    log(`poll: fixed every ${cfg.pollIntervalMs / 1000}s (poll_interval_ms)`);
    setInterval(() => { void drainPending(); }, cfg.pollIntervalMs);
  } else {
    let pollMs = null; // only for the mode-change log line
    setInterval(() => {
      const state = {
        now: performance.now(),
        lastDrainAt,
        lastMissAt,
        allSubscribed: cfg.restaurantIds.every((rid) => channelStatus.get(rid) === "SUBSCRIBED"),
      };
      const ms = drainIntervalMs(state);
      if (ms !== pollMs) {
        pollMs = ms;
        const why = ms === DRAIN_SLOW_MS ? "realtime healthy"
          : state.allSubscribed ? "recent job missed by realtime" : "realtime not subscribed";
        log(`poll: every ${ms / 1000}s (${why})`);
      }
      if (!drainDue(state)) return;
      // Stamp the attempt too: a failing or hung query must retry at the
      // interval, not on every 1s tick.
      lastDrainAt = state.now;
      void drainPending();
    }, DRAIN_TICK_MS);
  }
  setInterval(() => { void heartbeat(); }, 30_000);
  setInterval(() => { void reloadPrinters(); }, 5 * 60_000);
  setInterval(() => { void reapStuckJobs(); }, REAPER_INTERVAL_MS);

  process.on("SIGINT", async () => {
    log("shutting down…");
    discovery?.stop();
    lanEndpoints?.stop();
    uploader?.stop();
    for (const channel of channels) {
      try { await supabase.removeChannel(channel); } catch {}
    }
    process.exit(0);
  });
}

// Crash loudly and exit so the service manager (launchd/systemd/the Windows
// wrapper) restarts us — a silently wedged bridge means no tickets print
// until someone notices.
process.on("unhandledRejection", (e) => {
  console.error("FATAL unhandledRejection", e);
  process.exit(1);
});
process.on("uncaughtException", (e) => {
  console.error("FATAL uncaughtException", e);
  process.exit(1);
});

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
