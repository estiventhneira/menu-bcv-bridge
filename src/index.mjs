#!/usr/bin/env node
/**
 * fujun-bridge — local WiFi print bridge.
 *
 * Connects to Supabase, watches `print_jobs` for the configured restaurants,
 * and forwards any pending job whose target printer has transport='wifi'
 * to that printer over TCP:9100.
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
import { loadConfig } from "./config.mjs";
import { runPair } from "./pair.mjs";
import { startDiscovery, isConnectionError } from "./discover.mjs";
import { VERSION } from "./version.mjs";
import { renderKitchenTicket } from "./template.mjs";
import { renderCajaReport } from "./caja-report.mjs";
import { sendOverTcp } from "./printer-tcp.mjs";
import { sendOverSpooler } from "./printer-spooler.mjs";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
if (argv[0] === "pair") {
  await runPair(argv.slice(1));
  process.exit(0);
}

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

// Device mode: assigned after sign-in as `bridge:<auth user id>` (stable
// across label edits, and what the claim/heartbeat RPCs stamp server-side).
// Legacy mode keeps the historical label-hash id.
let DEVICE_ID = `bridge:${crypto.createHash("sha1").update(cfg.label).digest("hex").slice(0, 16)}`;

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

// id -> { transport: 'wifi' | 'usb_bridge', name, host?, port?, os_printer_name? }
const printers = new Map();
const inFlight = new Set();
// Discovery reporter (device mode only) — see discover.mjs.
let discovery = null;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function reloadPrinters() {
  const { data, error } = await supabase
    .from("printers")
    .select("id, name, transport, connection, is_active, chars_per_line, print_settings, claimed_by_device_id")
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
    if (p.transport === "wifi") {
      if (!c.host) continue;
      printers.set(p.id, {
        transport: "wifi",
        name: p.name,
        host: c.host,
        port: Number(c.port) || 9100,
        chars_per_line: charsPerLine,
        print_settings: printSettings,
        claimed_by: p.claimed_by_device_id ?? null,
      });
    } else if (p.transport === "usb_bridge") {
      if (!c.os_printer_name) continue;
      printers.set(p.id, {
        transport: "usb_bridge",
        name: p.name,
        os_printer_name: c.os_printer_name,
        chars_per_line: charsPerLine,
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
}
let lastTrackedSignature = null;

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
  const printer = printers.get(job.printer_id);
  if (!printer) return; // not our printer
  inFlight.add(job.id);
  try {
    // Atomic claim: only proceed if we were the one to flip pending→in_progress.
    const { data: claimed, error: claimErr } = await supabase
      .from("print_jobs")
      .update({ status: "in_progress", claimed_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claimed) {
      log(`skip job ${job.id} (already claimed)`);
      return;
    }

    log(`printing job ${job.id} → ${printer.name} (${printer.transport})`);
    const bytes = job.kind === "caja_report"
      ? renderCajaReport(job.payload, printer.chars_per_line, printer.print_settings)
      : renderKitchenTicket(job.payload, printer.chars_per_line, printer.print_settings);
    if (printer.transport === "wifi") {
      await sendOverTcp(printer.host, printer.port, bytes);
    } else if (printer.transport === "usb_bridge") {
      await sendOverSpooler(printer.os_printer_name, bytes);
    } else {
      throw new Error(`unknown transport: ${printer.transport}`);
    }
    await supabase
      .from("print_jobs")
      .update({ status: "done", completed_at: new Date().toISOString(), error: null })
      .eq("id", job.id);
    log(`ok job ${job.id} (${bytes.length} bytes)`);
  } catch (e) {
    log(`FAIL job ${job.id}: ${e.message}`);
    // A wifi printer that stopped answering may have moved to a new DHCP
    // address — rescan (debounced) so the app can suggest the fix.
    if (printer.transport === "wifi" && isConnectionError(e)) {
      discovery?.triggerFailureRescan();
    }
    // Bump attempts; mark failed when too many.
    const { data: cur } = await supabase
      .from("print_jobs")
      .select("attempts")
      .eq("id", job.id)
      .single();
    const attempts = (cur?.attempts ?? 0) + 1;
    const giveUp = attempts >= cfg.maxAttempts;
    await supabase
      .from("print_jobs")
      .update({
        status: giveUp ? "failed" : "pending",
        attempts,
        error: e.message,
        claimed_at: null,
      })
      .eq("id", job.id);
  } finally {
    inFlight.delete(job.id);
  }
}

async function drainPending() {
  const ids = Array.from(printers.keys());
  if (ids.length === 0) return;
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
  for (const j of data ?? []) await processJob(j);
}

// Columns that change what/how the bridge prints. Heartbeat/claim writes
// (claimed_*, last_seen_at, bridge_version, updated_at) are deliberately NOT
// here: those are our own echoes coming back through realtime, and reacting
// to them is what fed the reload/claim write loop.
const PRINTER_CONFIG_COLS = [
  "name", "transport", "connection", "is_active", "chars_per_line", "print_settings",
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
  if (cfg.mode === "device") {
    const userId = await signInDevice();
    DEVICE_ID = `bridge:${userId}`;
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
  }
  await reloadPrinters();
  await claimPrinters();
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
        (payload) => { void processJob(payload.new); },
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
      .subscribe((status) => log(`realtime[${rid.slice(0, 8)}]:`, status)),
  );

  // Reset any in_progress jobs that belong to us but predate this process —
  // they were probably interrupted by a crash/restart. Mark them pending so
  // we'll retry them.
  await supabase
    .from("print_jobs")
    .update({ status: "pending", claimed_at: null })
    .eq("status", "in_progress")
    .in("printer_id", Array.from(printers.keys()));

  setInterval(() => { void drainPending(); }, cfg.pollIntervalMs);
  setInterval(() => { void heartbeat(); }, 30_000);
  setInterval(() => { void reloadPrinters(); }, 5 * 60_000);

  process.on("SIGINT", async () => {
    log("shutting down…");
    discovery?.stop();
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
