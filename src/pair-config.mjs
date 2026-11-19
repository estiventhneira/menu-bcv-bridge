// The config.json that `print-bridge pair` writes (pure, for tests).
//
// Two cases:
//  * The PC's device account still signs in: the new restaurant is appended
//    to the existing config (multi-sucursal PC), everything else kept.
//  * It doesn't (the pairing was revoked from the app, which deletes the
//    device account, or this is a first install): new credentials. The PC's
//    own settings are kept, and so is the máquina fiscal saved by «Conectar
//    máquina» for the restaurant being paired. Before 0.9.7 the re-pair after
//    a revoke wrote the config from scratch and the bridge forgot the
//    machine: Roraima 2026-11-19, a factura went to the thermal printer.

/** Settings that belong to this PC, not to a pairing. */
const DEVICE_LOCAL_KEYS = [
  "lan_port",
  "disable_lan_server",
  "allowed_origins",
  "poll_interval_ms",
  "max_attempts",
  "disable_discovery",
  "disable_auto_update",
  "update_repo",
];

/**
 * @param {Record<string, any> | null} existing current config.json (null = none)
 * @param {Record<string, any>} body /api/public/bridge/pair response
 * @param {{ label: string, appOrigin: string | null, reuseDevice: boolean }} opts
 *   reuseDevice: the existing device account signed in and the server reused it
 */
export function buildPairedConfig(existing, body, { label, appOrigin, reuseDevice }) {
  const withLan = (cfg) => {
    const out = { ...cfg, ...(appOrigin ? { app_origin: appOrigin } : {}) };
    if (typeof body.lan_secret === "string" && body.lan_secret) {
      const others = (Array.isArray(cfg.lan_secrets) ? cfg.lan_secrets : [])
        .filter((x) => x?.bridge_token_id !== body.bridge_token_id);
      out.lan_secrets = [
        ...others,
        { bridge_token_id: body.bridge_token_id, restaurant_id: body.restaurant_id, lan_secret: body.lan_secret },
      ];
    }
    return out;
  };

  if (existing && reuseDevice) {
    const restaurants = Array.isArray(existing.restaurants) ? [...existing.restaurants] : [];
    if (!restaurants.some((r) => r?.id === body.restaurant_id)) {
      restaurants.push({ id: body.restaurant_id, bridge_token_id: body.bridge_token_id });
    }
    return withLan({ ...existing, restaurants });
  }

  const local = {};
  for (const key of DEVICE_LOCAL_KEYS) {
    if (existing && existing[key] !== undefined) local[key] = existing[key];
  }
  // Only this restaurant's machine: the old device account (and with it any
  // other restaurant this PC served) is gone.
  const machines = (Array.isArray(existing?.fiscal_machines) ? existing.fiscal_machines : [])
    .filter((m) => m && typeof m === "object" && m.restaurant_id === body.restaurant_id);
  return withLan({
    ...local,
    supabase_url: body.supabase_url,
    anon_key: body.anon_key,
    device_email: body.device_email,
    device_password: body.device_password,
    restaurants: [{ id: body.restaurant_id, bridge_token_id: body.bridge_token_id }],
    label,
    ...(machines.length > 0 ? { fiscal_machines: machines } : {}),
  });
}
