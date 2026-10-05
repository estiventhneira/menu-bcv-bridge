// Printer list cache (bridge 0.7.0).
//
// Up to 0.6.x the printer list lived only in memory and was loaded after the
// Supabase sign-in, so a PC that booted without internet printed nothing
// until the connection came back. The LAN server needs the list from the
// first second: every successful reload writes it here, and boot reads it
// before signing in. Nothing in it is secret (names, addresses, render
// settings) — the same data any staff member sees in Configuración.

import fs from "node:fs";
import path from "node:path";

const CACHE_VERSION = 1;

/**
 * @param {string} file
 * @param {Map<string, object>} printers  id -> in-memory printer entry
 */
export function savePrinterCache(file, printers) {
  const body = JSON.stringify({
    v: CACHE_VERSION,
    saved_at: new Date().toISOString(),
    printers: [...printers.entries()].map(([id, p]) => ({ id, ...p })),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * @param {string} file
 * @returns {{ savedAt: string | null, printers: Array<{ id: string } & Record<string, unknown>> } | null}
 */
export function loadPrinterCache(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw || raw.v !== CACHE_VERSION || !Array.isArray(raw.printers)) return null;
  const printers = raw.printers.filter(
    (p) =>
      p &&
      typeof p.id === "string" &&
      (p.transport === "wifi" || p.transport === "usb_bridge") &&
      typeof p.restaurant_id === "string",
  );
  return { savedAt: typeof raw.saved_at === "string" ? raw.saved_at : null, printers };
}
