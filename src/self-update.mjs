// Self-update (0.5.0): keep the fleet current without touching restaurant
// PCs. Every ~6h (and shortly after start) the bridge compares the SHA-256
// of its OWN running binary against the published checksum of the latest
// release; on mismatch it downloads the binary, verifies the checksum, swaps
// itself, and exits — the restart wrapper (run-bridge.bat / launchd
// KeepAlive / systemd Restart=always) brings up the new build in seconds.
//
// Design notes:
//  * Hash comparison, not version parsing — correct even across re-tagged
//    or rolled-back releases, and the .sha256 files the release workflow
//    already publishes double as the integrity gate.
//  * The swap waits until no print job is in flight, and never runs in dev
//    (VERSION === "dev" — there is no compiled binary to replace).
//  * Windows can't overwrite a running exe but CAN rename it: rename the
//    running binary aside, move the new one into place, exit. The leftover
//    .old is deleted on the next start (ignoring failures while it's still
//    briefly locked).
//  * Jitter staggers the fleet so a release doesn't restart every
//    restaurant in the same minute.
//  * config.json escape hatches: "disable_auto_update": true, and
//    "update_repo" to point a test PC at a fork.

import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { VERSION } from "./version.mjs";

const DEFAULT_REPO = "estiventhneira/menu-bcv-bridge";
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const STARTUP_DELAY_MS = 90_000;
const JITTER_MS = 30 * 60_000; // 0-30min added per cycle
const BUSY_RETRY_MS = 60_000; // printer busy — try the swap again shortly
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_BINARY_BYTES = 200 * 1024 * 1024;

/** Release asset name for this machine, or null when unsupported. */
export function assetForPlatform(platform = os.platform(), arch = os.arch()) {
  if (platform === "win32" && arch === "x64") return "print-bridge-win-x64.exe";
  if (platform === "darwin" && arch === "arm64") return "print-bridge-macos-arm64";
  if (platform === "darwin" && arch === "x64") return "print-bridge-macos-x64";
  if (platform === "linux" && arch === "x64") return "print-bridge-linux-x64";
  return null;
}

/** First hex token of a `sha256sum` output line ("<hash>  <file>"). */
export function parseSha256File(text) {
  const token = String(text).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

function sha256OfFile(path) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(path));
  return hash.digest("hex");
}

async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

export function startSelfUpdate({ log, isBusy, repo, disabled }) {
  const asset = assetForPlatform();
  if (disabled) {
    log("update: desactivado por config (disable_auto_update)");
    return { stop() {} };
  }
  if (VERSION === "dev" || !asset) {
    log(`update: desactivado (${VERSION === "dev" ? "corriendo desde código" : "plataforma sin builds"})`);
    return { stop() {} };
  }

  const binPath = process.execPath;
  const base = `https://github.com/${repo || DEFAULT_REPO}/releases/latest/download`;
  let stopped = false;
  let pendingTimer = null;

  // A previous update leaves the old binary aside on Windows; clean it up
  // (ignore failures — it can stay locked for a moment after the swap).
  try { fs.unlinkSync(`${binPath}.old`); } catch {}

  async function applyDownloaded(tmpPath) {
    if (isBusy()) {
      log("update: nueva versión lista, esperando a que no haya impresiones en curso…");
      pendingTimer = setTimeout(() => { void applyDownloaded(tmpPath); }, BUSY_RETRY_MS);
      pendingTimer.unref?.();
      return;
    }
    // Windows: can't overwrite a running exe, but renaming it is allowed.
    try { fs.renameSync(binPath, `${binPath}.old`); } catch {}
    fs.renameSync(tmpPath, binPath);
    try { fs.chmodSync(binPath, 0o755); } catch {}
    log("update: binario actualizado — reiniciando (el servicio lo relanza solo)");
    process.exit(0);
  }

  async function checkOnce() {
    if (stopped) return;
    try {
      const shaRes = await fetchWithTimeout(`${base}/${asset}.sha256`, 30_000);
      if (!shaRes.ok) {
        log(`update: no se pudo consultar la última versión (${shaRes.status})`);
        return;
      }
      const published = parseSha256File(await shaRes.text());
      if (!published) {
        log("update: checksum publicado ilegible — se omite");
        return;
      }
      const current = sha256OfFile(binPath);
      if (current === published) return; // up to date — the common, silent case

      log("update: hay una versión nueva — descargando…");
      const binRes = await fetchWithTimeout(`${base}/${asset}`, DOWNLOAD_TIMEOUT_MS);
      if (!binRes.ok) {
        log(`update: descarga falló (${binRes.status})`);
        return;
      }
      const bytes = Buffer.from(await binRes.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_BINARY_BYTES) {
        log(`update: tamaño de descarga inválido (${bytes.length} bytes) — se omite`);
        return;
      }
      const got = crypto.createHash("sha256").update(bytes).digest("hex");
      if (got !== published) {
        // Corrupted or tampered download — NEVER install it.
        log("update: checksum no coincide — descarga descartada");
        return;
      }
      const tmpPath = `${binPath}.new`;
      fs.writeFileSync(tmpPath, bytes, { mode: 0o755 });
      await applyDownloaded(tmpPath);
    } catch (e) {
      log(`update: ${e.message}`);
    }
  }

  function scheduleNext(delayMs) {
    if (stopped) return;
    const timer = setTimeout(() => {
      void checkOnce().then(() => scheduleNext(CHECK_INTERVAL_MS + Math.random() * JITTER_MS));
    }, delayMs);
    timer.unref?.();
  }

  scheduleNext(STARTUP_DELAY_MS + Math.random() * 30_000);

  return {
    stop() {
      stopped = true;
      if (pendingTimer) clearTimeout(pendingTimer);
    },
  };
}
