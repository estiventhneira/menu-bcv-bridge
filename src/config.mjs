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
    console.error("Create it with: { supabase_url, service_role_key, restaurant_id }");
    process.exit(2);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`Invalid JSON in ${p}: ${e.message}`);
    process.exit(2);
  }
  const required = ["supabase_url", "service_role_key", "restaurant_id"];
  for (const k of required) {
    if (!raw[k] || typeof raw[k] !== "string") {
      console.error(`Missing/invalid ${k} in ${p}`);
      process.exit(2);
    }
  }
  return {
    supabaseUrl: raw.supabase_url,
    serviceRoleKey: raw.service_role_key,
    restaurantId: raw.restaurant_id,
    label: raw.label ?? `bridge@${os.hostname()}`,
    pollIntervalMs: Number(raw.poll_interval_ms ?? 30_000),
    maxAttempts: Number(raw.max_attempts ?? 3),
  };
}
