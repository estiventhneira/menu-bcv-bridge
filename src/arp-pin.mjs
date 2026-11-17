// Pin a wifi printer's IP to its MAC on this PC (0.9.4).
//
// WHY: Xing Wah, 2026-11-17. «Cocina» had 172.16.0.22 as a fixed IP and the
// router gave the same address to another device. Windows kept sending the
// printer's tickets to that device, which refused them, and 30+ comandas
// expired in two hours. Following by MAC (printer-follow.mjs) can't help: the
// printer never moved, it's hidden behind the other device's ARP entry.
//
// A static neighbor entry (IP → the printer's MAC) makes this PC talk to the
// printer whatever else answers at that IP. Windows only lets an
// administrator write one and the bridge runs as a normal user, so the
// installer (public/bridge/install.ps1, run as administrator) registers a
// small task that runs as SYSTEM every minute and applies what the bridge
// asks for in a file:
//
//   %ProgramData%\FujunPrintBridge\arp\pins.txt     one "ip mac" per line
//
// The file is the whole wanted state: no file, nothing pinned. The helper
// checks every line again (an address on one of this PC's networks, never
// the router or the PC itself, a unicast MAC) and only removes entries it
// added. Nothing here is permanent: the entries are not persistent (a PC
// restart clears them), and the helper drops them when the file is 15 min
// old, so the bridge rewrites it every few minutes while it wants a pin and
// a pin never outlives the bridge that asked for it.
//
// Windows only. Without the helper (installer not run as administrator,
// macOS, Linux) available() is false and nothing changes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Under %ProgramData%. The installer creates it; its helper reads PIN_FILE. */
export const PIN_DIR_PARTS = ["FujunPrintBridge", "arp"];
export const PIN_FILE = "pins.txt";
/** Rewrite the file this often while a pin is wanted (the helper drops pins
 *  whose file is 15 min old). */
export const KEEPALIVE_MS = 5 * 60_000;
/** A write that failed (the helper had the file open) is tried again. */
export const RETRY_MS = 10_000;
export const MAX_PINS = 16;

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;

/** @param {Record<string, string | undefined>} [env] */
export function defaultPinDir(env = process.env) {
  const base = env.ProgramData ?? env.PROGRAMDATA ?? env.ALLUSERSPROFILE ?? "C:\\ProgramData";
  return path.win32.join(base, ...PIN_DIR_PARTS);
}

/** The file's content for these pins (IP → MAC): "ip aa-bb-cc-dd-ee-ff" per
 *  line, "" for none. Anything that isn't an IPv4 and a MAC is left out. */
export function formatPins(pins) {
  const lines = [];
  for (const [ip, mac] of [...pins].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (typeof ip !== "string" || typeof mac !== "string") continue;
    if (!IPV4_RE.test(ip) || !MAC_RE.test(mac)) continue;
    lines.push(`${ip} ${mac.replace(/:/g, "-")}`);
    if (lines.length >= MAX_PINS) break;
  }
  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

/**
 * @param {{
 *   platform?: string,
 *   dir?: string,
 *   fsImpl?: Pick<typeof fs, "statSync" | "writeFileSync" | "renameSync" | "unlinkSync">,
 *   log?: (msg: string) => void,
 * }} [opts]
 */
export function createArpPins({
  platform = os.platform(),
  dir = defaultPinDir(),
  fsImpl = fs,
  log = () => {},
} = {}) {
  const supported = platform === "win32";
  const file = path.join(dir, PIN_FILE);
  let wanted = ""; // what the file should hold ("" = no file)
  let onDisk = null; // what the last good write left (null = not known yet)
  let timer = null;
  let lastError = null;

  /** The installer's folder is there: the helper is installed on this PC. */
  function available() {
    if (!supported) return false;
    try {
      return fsImpl.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }

  function write(content) {
    if (content === "") {
      try {
        fsImpl.unlinkSync(file);
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
      }
      return;
    }
    // Whole file at once: the helper never reads half a list.
    const tmp = `${file}.tmp`;
    fsImpl.writeFileSync(tmp, content);
    fsImpl.renameSync(tmp, file);
  }

  function arm() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (onDisk !== wanted) timer = setTimeout(flush, RETRY_MS);
    else if (wanted !== "") timer = setTimeout(flush, KEEPALIVE_MS);
    timer?.unref?.();
  }

  function flush() {
    try {
      write(wanted);
      onDisk = wanted;
      lastError = null;
    } catch (e) {
      // Said once per cause: a retry every 10 s must not fill the log.
      if (e.message !== lastError) log(`arp-pin: no se pudo escribir ${file} (${e.message})`);
      lastError = e.message;
    }
    arm();
  }

  return {
    /** Windows: the only system the helper exists for. */
    supported,
    available,
    file,

    /**
     * Make `pins` (IP → MAC) the wanted state. Returns whether the file now
     * says so; a failed write is retried in the background.
     */
    sync(pins) {
      if (!available()) {
        wanted = "";
        onDisk = "";
        if (timer) clearTimeout(timer);
        timer = null;
        return false;
      }
      const next = formatPins(pins);
      if (next === wanted && onDisk === wanted) return true;
      wanted = next;
      flush();
      return onDisk === wanted;
    },

    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
