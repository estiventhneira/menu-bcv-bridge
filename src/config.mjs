// Reads and validates the bridge config from ~/.fujun-bridge/config.json
// or the path in $PRINT_BRIDGE_CONFIG.
//
// Two shapes exist:
//
//  * Device config (0.3.0+, written by `print-bridge pair <CODE>`): anon key
//    + a per-device auth account. RLS confines the device to its restaurants.
//      {
//        "supabase_url":    "https://xxxx.supabase.co",
//        "anon_key":        "sb_publishable_...",
//        "device_email":    "bridge-<id>@devices.andescocina.com",
//        "device_password": "<random>",
//        "restaurants":     [{ "id": "<uuid>", "bridge_token_id": "<uuid>" }],
//        "label":           "bridge@cocina",   // optional
//        "poll_interval_ms": 30000,            // optional
//        "max_attempts":     3                 // optional
//      }
//
//  * Legacy config (service_role_key + restaurant_ids). Still runs, with a
//    loud deprecation warning — re-pair to migrate. The service key will be
//    rotated out of existence once the fleet is off it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_PATH = path.join(os.homedir(), ".fujun-bridge", "config.json");

export function configPath() {
  return process.env.PRINT_BRIDGE_CONFIG ?? DEFAULT_PATH;
}

/** Raw parsed JSON, or null if the file doesn't exist. Exits on bad JSON —
 *  a corrupt config should never be silently treated as "not configured". */
export function readConfigRaw() {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`Invalid JSON in ${p}: ${e.message}`);
    process.exit(2);
  }
}

/** Writes the config with owner-only permissions (it holds credentials). */
export function saveConfigRaw(raw) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600); // writeFileSync mode is ignored if the file existed
  } catch {}
  return p;
}

export function loadConfig() {
  const p = configPath();
  const raw = readConfigRaw();
  if (!raw) {
    console.error(`No config file at ${p}.`);
    console.error("Run: print-bridge pair <CODE> --url <app-url>  (get the code in Configuración > Impresoras)");
    process.exit(2);
  }

  const common = {
    label: raw.label ?? `bridge@${os.hostname()}`,
    // 5s poll = the printing latency CEILING. Field data showed realtime
    // postgres_changes degrading to 15-30s (or dropping events outright)
    // exactly during service hours, so the poll is the real latency
    // guarantee and realtime is just the fast path. The query is a narrow
    // indexed SELECT — negligible load even across a large fleet.
    pollIntervalMs: Number(raw.poll_interval_ms ?? 5_000),
    maxAttempts: Number(raw.max_attempts ?? 3),
    // Escape hatch for routers that dislike even the slow scan:
    // { "disable_discovery": true } turns network discovery off entirely.
    disableDiscovery: raw.disable_discovery === true,
    // Self-update (0.5.0) escape hatches: turn it off entirely, or point a
    // test PC at a fork's releases.
    disableAutoUpdate: raw.disable_auto_update === true,
    updateRepo: typeof raw.update_repo === "string" && raw.update_repo.trim()
      ? raw.update_repo.trim()
      : null,
  };

  // Device shape (0.3.0+)
  if (raw.anon_key || raw.device_email) {
    for (const k of ["supabase_url", "anon_key", "device_email", "device_password"]) {
      if (!raw[k] || typeof raw[k] !== "string") {
        console.error(`Missing/invalid ${k} in ${p}`);
        process.exit(2);
      }
    }
    const restaurants = Array.isArray(raw.restaurants)
      ? raw.restaurants.filter((r) => r && typeof r.id === "string" && r.id.trim())
      : [];
    if (restaurants.length === 0) {
      console.error(`Missing/invalid restaurants in ${p} — re-run: print-bridge pair <CODE> --url <app-url>`);
      process.exit(2);
    }
    return {
      mode: "device",
      supabaseUrl: raw.supabase_url,
      anonKey: raw.anon_key,
      deviceEmail: raw.device_email,
      devicePassword: raw.device_password,
      restaurantIds: restaurants.map((r) => r.id),
      ...common,
    };
  }

  // Legacy shape (service role key)
  for (const k of ["supabase_url", "service_role_key"]) {
    if (!raw[k] || typeof raw[k] !== "string") {
      console.error(`Missing/invalid ${k} in ${p}`);
      process.exit(2);
    }
  }
  // One bridge process can serve several restaurants (e.g. sucursales sharing
  // a PC): `restaurant_ids` is an array; the older single `restaurant_id`
  // string keeps working.
  let restaurantIds;
  if (Array.isArray(raw.restaurant_ids)) {
    restaurantIds = raw.restaurant_ids.filter((id) => typeof id === "string" && id.trim());
  } else if (typeof raw.restaurant_id === "string" && raw.restaurant_id.trim()) {
    restaurantIds = [raw.restaurant_id];
  }
  if (!restaurantIds || restaurantIds.length === 0) {
    console.error(`Missing/invalid restaurant_ids (or legacy restaurant_id) in ${p}`);
    process.exit(2);
  }
  console.warn("╔══════════════════════════════════════════════════════════════════╗");
  console.warn("║ AVISO: este bridge usa la service role key (config antigua).     ║");
  console.warn("║ Migrá con:  print-bridge pair <CODIGO> --url <url de la app>     ║");
  console.warn("║ (el código se genera en Configuración > Impresoras).             ║");
  console.warn("║ La key vieja será rotada — el config antiguo dejará de servir.   ║");
  console.warn("╚══════════════════════════════════════════════════════════════════╝");
  return {
    mode: "legacy",
    supabaseUrl: raw.supabase_url,
    serviceRoleKey: raw.service_role_key,
    restaurantIds,
    ...common,
  };
}
