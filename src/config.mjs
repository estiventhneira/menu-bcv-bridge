// Reads and validates the bridge config from ~/.fujun-bridge/config.json
// or the path in $PRINT_BRIDGE_CONFIG.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_PATH = path.join(os.homedir(), ".fujun-bridge", "config.json");

export function loadConfig() {
  const p = process.env.PRINT_BRIDGE_CONFIG ?? DEFAULT_PATH;
  if (!fs.existsSync(p)) {
    console.error(`No config file at ${p}.`);
    console.error("Create it with: { supabase_url, service_role_key, restaurant_ids }");
    process.exit(2);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`Invalid JSON in ${p}: ${e.message}`);
    process.exit(2);
  }
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
  return {
    supabaseUrl: raw.supabase_url,
    serviceRoleKey: raw.service_role_key,
    restaurantIds,
    label: raw.label ?? `bridge@${os.hostname()}`,
    pollIntervalMs: Number(raw.poll_interval_ms ?? 30_000),
    maxAttempts: Number(raw.max_attempts ?? 3),
  };
}
