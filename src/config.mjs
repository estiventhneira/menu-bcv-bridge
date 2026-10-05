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
//        "poll_interval_ms": 30000,            // optional — fixed; default adaptive 5-15 s
//        "max_attempts":     3,                // optional
//        // LAN print server (0.7.0) — all optional:
//        "lan_port":         7373,
//        "disable_lan_server": false,
//        "app_origin":       "https://andescocina.com",   // written by `pair`
//        "allowed_origins":  ["http://localhost:3000"],   // extra CORS origins
//        "device_user_id":   "<uuid>"          // written after the first sign-in
//      }
//    plus "lan_secrets": [{ bridge_token_id, restaurant_id, lan_secret }] —
//    the HMAC keys for LAN tokens, written by `pair` and replaced from
//    bridge_lan_secrets() on every online start.
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

/**
 * Read-modify-write of the raw config for values the bridge learns at runtime
 * (device user id, LAN secrets). `mutate` returns true when it changed
 * something; nothing is written otherwise. Never throws — a read-only disk
 * must not take printing down.
 * @param {(raw: Record<string, any>) => boolean} mutate
 */
export function updateConfigRaw(mutate) {
  try {
    const raw = readConfigRaw();
    if (!raw) return false;
    if (!mutate(raw)) return false;
    saveConfigRaw(raw);
    return true;
  } catch (e) {
    console.error(`No se pudo actualizar ${configPath()}: ${e.message}`);
    return false;
  }
}

/** Directory for the bridge's runtime state (printer cache, LAN journal):
 *  next to config.json, so PRINT_BRIDGE_CONFIG relocates it too. */
export function stateDir() {
  return path.dirname(configPath());
}

/**
 * @param {unknown} list raw `lan_secrets`
 * @returns {Array<{ bridgeTokenId: string, restaurantId: string, secret: string }>}
 */
export function parseLanSecrets(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (x) =>
        x &&
        typeof x.bridge_token_id === "string" &&
        typeof x.restaurant_id === "string" &&
        typeof x.lan_secret === "string" &&
        x.lan_secret.length >= 16,
    )
    .map((x) => ({ bridgeTokenId: x.bridge_token_id, restaurantId: x.restaurant_id, secret: x.lan_secret }));
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
    // The drain poll is the printing latency CEILING. Field data showed
    // realtime postgres_changes degrading to 15-30s (or dropping events
    // outright) exactly during service hours, so the poll is the real
    // latency guarantee and realtime is just the fast path. The query is a
    // narrow indexed SELECT, cheap for the DB — but Supabase bills Log
    // Ingestion per API-gateway request, and a fixed 5s poll is 720
    // requests/hour per bridge, all day, busy or not.
    //
    // So the default (null) is adaptive (0.6.7, drain-poll.mjs): 5s while
    // realtime is unproven (a channel not SUBSCRIBED, or a drain found a job
    // realtime missed in the last 10 min), 15s once realtime has been
    // carrying every job. An explicit poll_interval_ms is honored as a fixed
    // interval, the pre-0.6.7 behavior.
    pollIntervalMs: Number(raw.poll_interval_ms) > 0 ? Number(raw.poll_interval_ms) : null,
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
    // LAN print server (0.7.0): tablets hand tickets to the bridge over the
    // restaurant network, with or without internet (lan-server.mjs).
    lanPort: Number.isInteger(raw.lan_port) && raw.lan_port > 0 && raw.lan_port < 65536
      ? raw.lan_port
      : 7373,
    disableLanServer: raw.disable_lan_server === true,
    appOrigin: typeof raw.app_origin === "string" ? raw.app_origin : null,
    allowedOrigins: Array.isArray(raw.allowed_origins)
      ? raw.allowed_origins.filter((o) => typeof o === "string")
      : [],
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
      // LAN tokens name the pairing (bridge_tokens row) they were minted
      // for; that row's secret checks them.
      lanSecrets: parseLanSecrets(raw.lan_secrets),
      deviceUserId: typeof raw.device_user_id === "string" && raw.device_user_id ? raw.device_user_id : null,
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
