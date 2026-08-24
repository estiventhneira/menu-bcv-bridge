// Printer discovery (0.4.0): scan the LAN for TCP:9100 responders and
// enumerate OS-spooler printers, then report findings via the
// bridge_report_discoveries RPC (migration 201). The app turns the report
// into wifi-form prefill chips, DHCP-drift suggestions, and a spooler-name
// dropdown — a human always clicks to apply; the bridge only observes.
//
// Device mode only: the RPC writes to bridge_tokens rows keyed off
// auth.uid(), which legacy service-role bridges don't have.
//
// Every path in here is log-and-continue. Discovery must never take down
// printing.

import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";

const PROBE_PORT = 9100; // RAW/JetDirect — the only port the bridge prints to
const CONNECT_TIMEOUT_MS = 750; // LAN RTT is <10ms; tolerates sleepy wifi printers
const SCAN_CONCURRENCY = 32; // 254 SYNs at once trips cheap routers; 32 doesn't
const SCAN_DEADLINE_MS = 20_000; // hard stop across all subnets
const MAX_HOSTS_PER_SCAN = 1024;
const MAX_SUBNETS = 8;
const MAX_NET_PRINTERS = 50;
const MAX_OS_PRINTERS = 50;
const MAX_STR = 128;
const SPOOLER_CMD_TIMEOUT = 10_000;
const SPOOLER_OUT_CAP = 256 * 1024;
const PERIODIC_MS = 15 * 60_000;
const FAILURE_DELAY_MS = 10_000; // coalesce a burst of failing jobs
const FAILURE_COOLDOWN_MS = 5 * 60_000; // dead printer retried every 30s must not scan continuously

// ------------------------------------------------------------
// Connection-error classifier (used by index.mjs to decide when a
// failed wifi job should trigger a rescan). Matches the raw net error
// codes sendOverTcp surfaces, plus its synthetic timeout Error which
// carries no .code (printer-tcp.mjs).
// ------------------------------------------------------------

const CONN_ERR_CODES = new Set([
  "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT",
  "EHOSTDOWN", "ECONNRESET", "EPIPE", "EADDRNOTAVAIL", "ENOTFOUND",
]);

export function isConnectionError(e) {
  return CONN_ERR_CODES.has(e?.code) || /^Timeout connecting to /.test(e?.message ?? "");
}

// ------------------------------------------------------------
// LAN scan
// ------------------------------------------------------------

function ipToUint(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function uintToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function maskToPrefix(netmask) {
  const n = ipToUint(netmask ?? "");
  if (n === null) return null;
  let prefix = 0;
  let seenZero = false;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) {
      if (seenZero) return null; // non-contiguous mask
      prefix++;
    } else {
      seenZero = true;
    }
  }
  return prefix;
}

function prefixMask(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** Subnets worth scanning. Prefix computed from netmask (never `cidr` —
 *  unreliable across runtimes, Bun included); anything wider than /24 is
 *  clamped to the /24 containing the interface address. */
function subnetsToScan() {
  const own = new Set(); // the bridge's own IPs — pointless to probe
  const subnets = new Map(); // "192.168.1.0/24" -> { base, prefix }
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      try {
        if (a.internal) continue;
        if (a.family !== "IPv4" && a.family !== 4) continue;
        if (a.address.startsWith("169.254.")) continue; // link-local
        const addr = ipToUint(a.address);
        if (addr === null) continue;
        own.add(a.address);
        let prefix = maskToPrefix(a.netmask);
        if (!prefix || prefix < 8) continue; // bogus mask
        if (prefix < 24) prefix = 24;
        if (prefix > 30) continue; // /31,/32: no scannable neighbors
        const base = (addr & prefixMask(prefix)) >>> 0;
        if (subnets.size < MAX_SUBNETS) {
          subnets.set(`${uintToIp(base)}/${prefix}`, { base, prefix });
        }
      } catch {
        // One bad interface never kills the scan.
      }
    }
  }
  return { subnets, own };
}

/** TCP-connect probe. Resolves {host, port, rtt_ms} on connect, null
 *  otherwise — a miss is data, not an error. External setTimeout like
 *  printer-tcp.mjs (not socket.setTimeout — less exercised under Bun). */
function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (hit) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve(hit);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.once("error", () => finish(null));
    sock.connect(port, host, () => finish({ host, port, rtt_ms: Date.now() - start }));
  });
}

async function scanLan() {
  const { subnets, own } = subnetsToScan();
  const hosts = [];
  outer: for (const { base, prefix } of subnets.values()) {
    const size = 2 ** (32 - prefix);
    for (let i = 1; i < size - 1; i++) { // skip network + broadcast
      const ip = uintToIp((base + i) >>> 0);
      if (!own.has(ip)) hosts.push(ip);
      if (hosts.length >= MAX_HOSTS_PER_SCAN) break outer;
    }
  }
  const found = [];
  const deadline = Date.now() + SCAN_DEADLINE_MS;
  let next = 0;
  const worker = async () => {
    while (next < hosts.length && Date.now() < deadline) {
      const host = hosts[next++];
      const hit = await probe(host, PROBE_PORT, CONNECT_TIMEOUT_MS);
      if (hit) found.push(hit);
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  found.sort((a, b) => a.rtt_ms - b.rtt_ms);
  return {
    subnets: [...subnets.keys()],
    network_printers: found.slice(0, MAX_NET_PRINTERS),
  };
}

// ------------------------------------------------------------
// OS spooler enumeration
// ------------------------------------------------------------

// UTF-8 forced on the console: printer names here carry accents, and the
// machine's OEM codepage (CP850/CP1252) would mangle them in the pipe.
const WIN_LIST_SCRIPT = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-Printer | Select-Object Name,DriverName | ConvertTo-Json -Compress
`;
const WIN_LIST_ENCODED = Buffer.from(WIN_LIST_SCRIPT, "utf16le").toString("base64");

/** Like printer-spooler.mjs run(), but captures stdout (capped) and takes
 *  no stdin. Manual setTimeout + SIGKILL — no AbortSignal (buggy in Bun). */
function runCapture(cmd, args, env, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(new Error(`${label}: failed to spawn ${cmd}: ${e.message}`));
    }

    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ stdout });
    };

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      finish(new Error(`${label}: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > SPOOLER_OUT_CAP) {
        try { proc.kill("SIGKILL"); } catch {}
        finish(new Error(`${label}: output too large`));
      }
    });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (e) => finish(new Error(`${label}: ${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(
        `${label}: exit ${code}${stderr ? ` — ${stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`
      ));
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end();
  });
}

/** ConvertTo-Json returns a bare object when there is exactly one printer. */
export function parseWindowsPrinterJson(stdout) {
  const v = JSON.parse(stdout.trim() || "null");
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list
    .filter((p) => p && typeof p.Name === "string" && p.Name.trim())
    .slice(0, MAX_OS_PRINTERS)
    .map((p) => ({
      name: String(p.Name).slice(0, MAX_STR),
      ...(p.DriverName ? { driver: String(p.DriverName).slice(0, MAX_STR) } : {}),
    }));
}

/** lpstat -e: one queue name per line, locale-independent (unlike -p,
 *  whose output is localized — Spanish CUPS says "la impresora X…"). */
export function parseLpstatOutput(stdout) {
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_OS_PRINTERS)
    .map((name) => ({ name: name.slice(0, MAX_STR) }));
}

async function listOsPrinters(log) {
  try {
    if (os.platform() === "win32") {
      const { stdout } = await runCapture(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-EncodedCommand", WIN_LIST_ENCODED],
        process.env,
        SPOOLER_CMD_TIMEOUT,
        "Get-Printer",
      );
      return parseWindowsPrinterJson(stdout);
    }
    const { stdout } = await runCapture(
      "lpstat",
      ["-e"],
      { ...process.env, LC_ALL: "C" },
      SPOOLER_CMD_TIMEOUT,
      "lpstat -e",
    );
    return parseLpstatOutput(stdout);
  } catch (e) {
    // "lpstat: No destinations added" exits nonzero — an empty list is a
    // valid answer, never an error worth surfacing beyond the log.
    log(`discovery: os printers: ${e.message}`);
    return [];
  }
}

// ------------------------------------------------------------
// Orchestration
// ------------------------------------------------------------

function buildPayload(lanResult, ospResult, label, version) {
  const lan = lanResult.status === "fulfilled"
    ? lanResult.value
    : { subnets: [], network_printers: [] };
  const osp = ospResult.status === "fulfilled" ? ospResult.value : [];
  return {
    scanned_at: new Date().toISOString(),
    platform: os.platform(),
    version: String(version).slice(0, 32),
    label: String(label).slice(0, MAX_STR),
    subnets: lan.subnets.slice(0, MAX_SUBNETS),
    network_printers: lan.network_printers.slice(0, MAX_NET_PRINTERS).map((p) => ({
      host: String(p.host).slice(0, 45),
      port: p.port | 0,
      rtt_ms: Math.max(0, Math.round(p.rtt_ms)),
    })),
    os_printers: osp.slice(0, MAX_OS_PRINTERS),
  };
}

export function startDiscovery({ supabase, log, label, version }) {
  let scanning = false;
  let lastScanAt = 0;
  let pendingTimer = null;
  let stopped = false;

  async function runOnce(reason) {
    if (scanning || stopped) return;
    scanning = true;
    try {
      log(`discovery: scan (${reason})`);
      const [lan, osp] = await Promise.allSettled([scanLan(), listOsPrinters(log)]);
      const payload = buildPayload(lan, osp, label, version);
      const { error } = await supabase.rpc("bridge_report_discoveries", {
        p_discoveries: payload,
      });
      if (error) log(`discovery: report failed: ${error.message}`);
      else log(`discovery: ${payload.network_printers.length} lan, ${payload.os_printers.length} os`);
    } catch (e) {
      log(`discovery: ${e.message}`);
    } finally {
      scanning = false;
      lastScanAt = Date.now();
    }
  }

  // Startup scan is fire-and-forget so it never delays printing.
  void runOnce("startup");
  const interval = setInterval(() => { void runOnce("periodic"); }, PERIODIC_MS);
  interval.unref?.();

  /** First failure scans after 10s (fresh data right when staff opens the
   *  settings page); later failures are absorbed until 5 min after the last
   *  scan. One pending rescan max. */
  function triggerFailureRescan() {
    if (pendingTimer || stopped) return;
    const earliest = lastScanAt + FAILURE_COOLDOWN_MS;
    const delay = Math.max(FAILURE_DELAY_MS, earliest - Date.now());
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void runOnce("failure");
    }, delay);
    pendingTimer.unref?.();
  }

  function stop() {
    stopped = true;
    clearInterval(interval);
    if (pendingTimer) clearTimeout(pendingTimer);
  }

  return { triggerFailureRescan, stop };
}
