#!/usr/bin/env node
/**
 * fujun-bridge — local WiFi print bridge.
 *
 * Connects to Supabase, watches `print_jobs` for the configured restaurant,
 * and forwards any pending job whose target printer has transport='wifi'
 * to that printer over TCP:9100.
 *
 * One process can drive many printers in the same restaurant. To run multiple
 * restaurants, run multiple bridge processes with different configs.
 *
 * Config: ~/.fujun-bridge/config.json (or $PRINT_BRIDGE_CONFIG):
 *   {
 *     "supabase_url":      "https://xxxx.supabase.co",
 *     "service_role_key":  "eyJhbGc...",     // KEEP THIS SECRET
 *     "restaurant_id":     "uuid",
 *     "label":             "bridge@cocina",  // optional
 *     "poll_interval_ms":  30000,            // optional, fallback poll
 *     "max_attempts":      3                 // optional
 *   }
 */

import { createClient } from "@supabase/supabase-js";
import { loadConfig } from "./config.mjs";
import { renderKitchenTicket } from "./template.mjs";
import { sendOverTcp } from "./printer-tcp.mjs";
import { sendOverSpooler } from "./printer-spooler.mjs";
import crypto from "node:crypto";

const cfg = loadConfig();
const supabase = createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DEVICE_ID = `bridge:${crypto.createHash("sha1").update(cfg.label).digest("hex").slice(0, 16)}`;

// id -> { transport: 'wifi' | 'usb_bridge', name, host?, port?, os_printer_name? }
const printers = new Map();
const inFlight = new Set();

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function reloadPrinters() {
  const { data, error } = await supabase
    .from("printers")
    .select("id, name, transport, connection, is_active")
    .eq("restaurant_id", cfg.restaurantId)
    .in("transport", ["wifi", "usb_bridge"])
    .eq("is_active", true);
  if (error) {
    log("ERROR fetching printers:", error.message);
    return;
  }
  printers.clear();
  for (const p of data ?? []) {
    const c = p.connection ?? {};
    if (p.transport === "wifi") {
      if (!c.host) continue;
      printers.set(p.id, {
        transport: "wifi",
        name: p.name,
        host: c.host,
        port: Number(c.port) || 9100,
      });
    } else if (p.transport === "usb_bridge") {
      if (!c.os_printer_name) continue;
      printers.set(p.id, {
        transport: "usb_bridge",
        name: p.name,
        os_printer_name: c.os_printer_name,
      });
    }
  }
  const describe = (p) => p.transport === "wifi"
    ? `${p.name}@${p.host}:${p.port}`
    : `${p.name}@spooler:${p.os_printer_name}`;
  log(`tracking ${printers.size} printer(s):`,
    Array.from(printers.values()).map(describe).join(", ") || "(none)");
}

async function claimPrinters() {
  // Atomically claim our printers to this bridge so the UI shows it's online.
  const ids = Array.from(printers.keys());
  if (ids.length === 0) return;
  await supabase
    .from("printers")
    .update({ claimed_by_device_id: DEVICE_ID, claimed_at: new Date().toISOString() })
    .in("id", ids)
    .or(`claimed_by_device_id.is.null,claimed_by_device_id.eq.${DEVICE_ID}`);
}

async function heartbeat() {
  const ids = Array.from(printers.keys());
  if (ids.length === 0) return;
  await supabase
    .from("printers")
    .update({ last_seen_at: new Date().toISOString() })
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
    const bytes = renderKitchenTicket(job.payload);
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
    .eq("restaurant_id", cfg.restaurantId)
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

async function main() {
  log(`fujun-bridge starting (label=${cfg.label}, restaurant=${cfg.restaurantId})`);
  await reloadPrinters();
  await claimPrinters();
  await drainPending();

  const channel = supabase
    .channel(`bridge-${cfg.restaurantId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "print_jobs",
        filter: `restaurant_id=eq.${cfg.restaurantId}`,
      },
      (payload) => { void processJob(payload.new); },
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "printers",
        filter: `restaurant_id=eq.${cfg.restaurantId}`,
      },
      async () => { await reloadPrinters(); await claimPrinters(); },
    )
    .subscribe((status) => log("realtime:", status));

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
    try { await supabase.removeChannel(channel); } catch {}
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
