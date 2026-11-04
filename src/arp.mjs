// ARP table reader (0.9.2): which MAC address answers at each LAN IP.
//
// The bridge follows a wifi printer by its MAC address (printer-follow.mjs):
// the router can hand the printer another IP, but its network card keeps its
// MAC. The PC already knows the MAC of every LAN host it just talked to — the
// printer after a print, every responder after a discovery scan — so reading
// the table costs no network traffic.
//
// One parser for the three formats the fleet produces (only the IP and the
// MAC are read; the localized type column — "dinámico" on Spanish Windows —
// never is):
//   Windows `arp -a`     "  172.16.0.22           00-11-62-aa-bb-cc     dynamic"
//   macOS   `arp -an`    "? (172.16.0.22) at 0:11:62:aa:bb:cc on en0 ifscope [ethernet]"
//   Linux /proc/net/arp  "172.16.0.22  0x1  0x2  00:11:62:aa:bb:cc  *  eth0"
//
// Like discovery, every path is log-and-continue for the caller: a missing
// `arp` binary means "no MACs known", never a failed print.

import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

const ARP_CMD_TIMEOUT_MS = 5_000;
const ARP_OUT_CAP = 512 * 1024;

const IP_RE = /(?:^|[\s(])(\d{1,3}(?:\.\d{1,3}){3})(?=[\s)]|$)/;
const MAC_RE = /(?:^|\s)([0-9a-f]{1,2}(?:[-:][0-9a-f]{1,2}){5})(?=\s|$)/i;

/** "0-11-62-A-b-C" / "00:11:62:0a:0b:0c" → "00:11:62:0a:0b:0c"; null if not a MAC. */
export function normalizeMac(raw) {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().split(/[-:]/);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-f]{1,2}$/i.test(p))) return null;
  return parts.map((p) => p.padStart(2, "0").toLowerCase()).join(":");
}

/** A unicast hardware address: not empty (an unresolved Linux entry), not
 *  broadcast, not multicast (Windows lists 224.0.0.x as 01-00-5e-…). */
export function isUsableMac(mac) {
  if (!mac || mac === "00:00:00:00:00:00") return false;
  return (parseInt(mac.slice(0, 2), 16) & 1) === 0;
}

function isIpv4(ip) {
  const parts = ip.split(".");
  return parts.length === 4 && parts.every((p) => Number(p) <= 255);
}

/** IP → MAC for every resolved unicast entry. The first one wins when an IP
 *  shows up under two interfaces. */
export function parseArpTable(text) {
  const table = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = IP_RE.exec(line);
    const ip = m?.[1];
    if (!ip || !isIpv4(ip)) continue;
    const mac = normalizeMac(MAC_RE.exec(line.slice(m.index + m[0].length))?.[1]);
    if (!isUsableMac(mac) || table.has(ip)) continue;
    table.set(ip, mac);
  }
  return table;
}

/** stdout of a short command. Manual setTimeout + SIGKILL — no AbortSignal
 *  (buggy in Bun), like discover.mjs. */
function capture(cmd, args) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      reject(new Error(`${cmd}: ${e.message}`));
      return;
    }
    let out = "";
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out);
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      finish(new Error(`${cmd}: timed out after ${ARP_CMD_TIMEOUT_MS}ms`));
    }, ARP_CMD_TIMEOUT_MS);
    proc.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > ARP_OUT_CAP) {
        try { proc.kill("SIGKILL"); } catch {}
        finish(new Error(`${cmd}: output too large`));
      }
    });
    proc.on("error", (e) => finish(new Error(`${cmd}: ${e.message}`)));
    // `arp -a` exits 1 on an empty table on some systems: the output decides.
    proc.on("close", () => finish());
  });
}

/** The OS ARP table as IP → MAC. Throws when it can't be read. */
export async function readArpTable(platform = os.platform()) {
  if (platform === "linux") return parseArpTable(fs.readFileSync("/proc/net/arp", "utf8"));
  return parseArpTable(await capture("arp", platform === "win32" ? ["-a"] : ["-an"]));
}
