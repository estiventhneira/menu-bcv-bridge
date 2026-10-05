// LAN endpoint reporting (bridge 0.7.0).
//
// Tablets find the bridge's LAN server through the app: the bridge reports
// its own IPv4 addresses + port with bridge_report_lan_endpoints (migration
// 277), and the app hands them to staff devices with a LAN token. Only IPv4
// literals are useful — Chrome relaxes mixed content for private IP literals,
// never for hostnames — and RFC 1918 ranges go first so a VPN or virtual
// adapter address never shadows the real LAN one.

import os from "node:os";

const MAX_ADDRESSES = 4;
const CHECK_EVERY_MS = 60_000;
const REPORT_EVERY_MS = 30 * 60_000;

function rank(ip) {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 2;
  return 3;
}

/**
 * The PC's usable LAN addresses, best first.
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces]
 * @returns {string[]}
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = new Set();
  for (const addrs of Object.values(interfaces ?? {})) {
    for (const a of addrs ?? []) {
      if (!a || a.internal) continue;
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (typeof a.address !== "string" || a.address.startsWith("169.254.")) continue;
      out.add(a.address);
    }
  }
  return [...out].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ADDRESSES);
}

/**
 * Reports at start, whenever the address set changes (checked every 60 s —
 * DHCP renewals and WiFi/cable swaps move the PC), and every 30 min anyway so
 * `lan_endpoints_at` doubles as a liveness hint.
 *
 * @param {{
 *   supabase: { rpc: (fn: string, args: object) => PromiseLike<{ error: { message: string } | null }> },
 *   log: (...a: unknown[]) => void,
 *   port: number,
 *   version: string,
 *   deviceId: () => string,
 *   addresses?: () => string[],
 * }} opts
 */
export function startLanEndpointsReporter({ supabase, log, port, version, deviceId, addresses = lanAddresses }) {
  let lastSignature = null;
  let lastReportAt = 0;
  let stopped = false;

  async function tick(force = false) {
    if (stopped) return;
    let addrs;
    try {
      addrs = addresses();
    } catch {
      return;
    }
    const signature = addrs.join(",");
    if (!force && signature === lastSignature && Date.now() - lastReportAt < REPORT_EVERY_MS) return;
    const payload = {
      port,
      addresses: addrs,
      hostname: os.hostname().slice(0, 64),
      version,
      device_id: deviceId(),
      reported_at: new Date().toISOString(),
    };
    const { error } = await supabase.rpc("bridge_report_lan_endpoints", { p_endpoints: payload });
    if (error) {
      // Migration 277 not applied yet, or a network blip: retried next tick.
      log(`lan: no se pudo reportar la dirección (${error.message})`);
      return;
    }
    if (signature !== lastSignature) log(`lan: dirección reportada ${addrs.map((a) => `${a}:${port}`).join(", ") || "(ninguna)"}`);
    lastSignature = signature;
    lastReportAt = Date.now();
  }

  void tick(true);
  const timer = setInterval(() => void tick(false), CHECK_EVERY_MS);
  return {
    reportNow: () => tick(true),
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
