// The máquina fiscal's COM port, without native modules (bridge 0.9.0).
//
// The bridge ships as a single `bun build --compile` binary that updates
// itself; the `serialport` npm package is a native addon that complicates
// both (the reason the 2026-09-26 design first rejected the bridge). So the
// port is driven by a small helper child process, the same trick
// printer-spooler.mjs uses for USB printers:
//
//   Windows   powershell.exe + inline C# System.IO.Ports.SerialPort
//             (9600 8E1, DTR/RTS on), raw bytes over stdin/stdout. Needs
//             the stock usbser driver: the port must show up as COMn
//             (a Zadig WinUSB swap removes it).
//   macOS /   sh: open the device, stty on that same descriptor (macOS
//   Linux     resets termios when the last descriptor closes), then one cat
//             each way.
//
// The helper prints READY on stderr once the port is open; until then the
// link isn't handed out. Its stdout carries ONLY port bytes.
//
// FUJUN_FISCAL_SIMULATOR=<RIF>[:<registro>] adds a "SIMULADOR" port backed
// by hka-simulator.mjs, for trying the whole flow without a machine.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHkaSimulator } from "./hka-simulator.mjs";

const PLATFORM = os.platform();
export const SIMULATOR_PORT = "SIMULADOR";

const WIN_PIPE_SCRIPT = `
$ErrorActionPreference = "Stop"
$name = $env:FUJUN_SERIAL_PORT
if ([string]::IsNullOrEmpty($name)) { throw "FUJUN_SERIAL_PORT is empty" }
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.IO.Ports;
using System.Threading;
public static class FujunSerialPipe {
  public static int Run(string name) {
    SerialPort port = new SerialPort(name, 9600, Parity.Even, 8, StopBits.One);
    port.Handshake = Handshake.None;
    port.ReadTimeout = SerialPort.InfiniteTimeout;
    port.WriteTimeout = 10000;
    port.ReadBufferSize = 8192;
    port.Open();
    port.DtrEnable = true;
    port.RtsEnable = true;
    Stream outp = Console.OpenStandardOutput();
    Stream inp = Console.OpenStandardInput();
    Console.Error.WriteLine("READY");
    Console.Error.Flush();
    Thread reader = new Thread(delegate () {
      byte[] buf = new byte[512];
      try {
        while (true) {
          int n = port.BaseStream.Read(buf, 0, buf.Length);
          if (n <= 0) break;
          outp.Write(buf, 0, n);
          outp.Flush();
        }
      } catch (Exception e) {
        Console.Error.WriteLine("READ " + e.Message);
      }
      Environment.Exit(3);
    });
    reader.IsBackground = true;
    reader.Start();
    byte[] wbuf = new byte[512];
    while (true) {
      int n = inp.Read(wbuf, 0, wbuf.Length);
      if (n <= 0) break;
      port.BaseStream.Write(wbuf, 0, n);
      port.BaseStream.Flush();
    }
    port.Close();
    return 0;
  }
}
"@
exit [FujunSerialPipe]::Run($name)
`;

const WIN_LIST_SCRIPT = `
$ErrorActionPreference = "SilentlyContinue"
$names = [System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object -Unique
$pnp = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "Name LIKE '%(COM%'")
$out = @(foreach ($n in $names) {
  $dev = $pnp | Where-Object { $_.Name -match ("\\(" + [regex]::Escape($n) + "\\)") } | Select-Object -First 1
  [pscustomobject]@{ path = $n; name = $(if ($dev) { $dev.Name } else { $n }); pnp = $(if ($dev) { $dev.PNPDeviceID } else { $null }) }
})
ConvertTo-Json -Compress -InputObject $out
`;

const POSIX_PIPE_SCRIPT = `
dev="$FUJUN_SERIAL_PORT"
exec 3<>"$dev" || exit 2
stty 9600 cs8 parenb -parodd -cstopb raw -echo -ixon -ixoff -crtscts clocal <&3 2>/dev/null \\
  || stty 9600 cs8 parenb -parodd -cstopb raw -echo -ixon -ixoff clocal <&3 || exit 2
echo READY >&2
cat <&3 &
reader=$!
trap 'kill $reader 2>/dev/null' EXIT INT TERM
cat >&3
`;

const encodePs = (script) => Buffer.from(script, "utf16le").toString("base64");

/** "USB\\VID_0483&PID_5740\\…" → { vid: "0483", pid: "5740" } */
export function parseUsbIds(pnp) {
  const m = typeof pnp === "string" ? /VID_([0-9A-F]{4}).*PID_([0-9A-F]{4})/i.exec(pnp) : null;
  return m ? { vid: m[1].toUpperCase(), pid: m[2].toUpperCase() } : null;
}

// ── simulator (dev / end-to-end without a machine) ──────────────────────

let simulator = null;
function simulatorFromEnv() {
  const spec = process.env.FUJUN_FISCAL_SIMULATOR;
  if (!spec) return null;
  if (!simulator) {
    const [rif, registro] = spec.split(":");
    simulator = createHkaSimulator({
      rif: rif || "J000000000",
      registro: registro || "ZZP0000001",
      lastFactura: 1,
      printDelayMs: 300,
    });
  }
  return simulator;
}

/** The simulator, if this process runs with one (tests and dev). */
export function activeSimulator() {
  return simulatorFromEnv();
}

// ── listing ─────────────────────────────────────────────────────────────

function runCapture(cmd, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let proc;
    try {
      proc = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      reject(new Error(`${cmd}: tiempo agotado`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd}: exit ${code} ${err.trim().split("\n").slice(-2).join(" | ")}`));
    });
  });
}

/**
 * Serial ports on this PC, for the «Conectar máquina» picker.
 * @returns {Promise<Array<{ path: string, name: string, vid: string | null, pid: string | null }>>}
 */
export async function listSerialPorts() {
  const out = [];
  if (simulatorFromEnv()) out.push({ path: SIMULATOR_PORT, name: "Simulador PP9-PLUS (pruebas)", vid: null, pid: null });
  try {
    if (PLATFORM === "win32") {
      const json = await runCapture(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePs(WIN_LIST_SCRIPT)],
        process.env,
        20_000,
      );
      const rows = JSON.parse(json.trim() || "[]");
      for (const r of Array.isArray(rows) ? rows : [rows]) {
        if (!r || typeof r.path !== "string") continue;
        const ids = parseUsbIds(r.pnp);
        out.push({ path: r.path, name: typeof r.name === "string" ? r.name : r.path, vid: ids?.vid ?? null, pid: ids?.pid ?? null });
      }
    } else {
      const names = fs.readdirSync("/dev");
      const byId = new Map();
      try {
        for (const n of fs.readdirSync("/dev/serial/by-id")) {
          byId.set(path.resolve("/dev/serial/by-id", fs.readlinkSync(path.join("/dev/serial/by-id", n))), n);
        }
      } catch {}
      for (const n of names.sort()) {
        const ok =
          PLATFORM === "darwin"
            ? n.startsWith("cu.") && !/bluetooth|debug-console|wlan/i.test(n)
            : /^tty(ACM|USB)\d+$/.test(n);
        if (!ok) continue;
        const p = `/dev/${n}`;
        out.push({ path: p, name: byId.get(p) ?? n, vid: null, pid: null });
      }
    }
  } catch {
    // No PowerShell / no /dev access: the simulator (if any) is still listed.
  }
  return out;
}

// ── opening ─────────────────────────────────────────────────────────────

/**
 * Open the port through the helper. Resolves once the helper says READY.
 * @param {string} port  "COM3", "/dev/cu.usbmodem1101" or SIMULATOR_PORT
 * @param {{ log?: (...a: unknown[]) => void, openTimeoutMs?: number }} [opts]
 * @returns {Promise<import("./hka-session.mjs").SerialLink>}
 */
export function openSerialLink(port, opts = {}) {
  const log = opts.log ?? (() => {});
  const sim = port === SIMULATOR_PORT ? simulatorFromEnv() : null;
  if (port === SIMULATOR_PORT) {
    if (!sim) return Promise.reject(new Error("El simulador no está activo en este bridge"));
    return Promise.resolve(sim.reconnect());
  }
  if (typeof port !== "string" || !port || port.length > 200 || /[\0\r\n]/.test(port)) {
    return Promise.reject(new Error("Puerto inválido"));
  }

  return new Promise((resolve, reject) => {
    const env = { ...process.env, FUJUN_SERIAL_PORT: port };
    const proc =
      PLATFORM === "win32"
        ? spawn(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePs(WIN_PIPE_SCRIPT)],
            { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
          )
        : spawn("/bin/sh", ["-c", POSIX_PIPE_SCRIPT], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });

    let ready = false;
    let stderr = "";
    let closed = false;
    const dataListeners = [];
    const closeListeners = [];
    const timer = setTimeout(() => {
      if (!ready) {
        kill();
        reject(new Error(`No se pudo abrir ${port} (tiempo agotado)`));
      }
    }, opts.openTimeoutMs ?? 20_000);

    function kill() {
      try {
        if (PLATFORM !== "win32" && proc.pid) process.kill(-proc.pid, "SIGTERM");
        else proc.kill();
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
    }

    proc.stdout.on("data", (d) => {
      const bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      for (const cb of dataListeners) cb(bytes);
    });
    proc.stderr.on("data", (d) => {
      const text = d.toString();
      if (!ready && /READY/.test(text)) {
        ready = true;
        clearTimeout(timer);
        resolve(link);
        return;
      }
      stderr = (stderr + text).slice(-2000);
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      if (!ready) reject(new Error(`No se pudo abrir ${port}: ${e.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      closed = true;
      const why = stderr.trim().split("\n").slice(-2).join(" | ");
      if (!ready) {
        reject(new Error(`No se pudo abrir ${port}${why ? `: ${why}` : ` (exit ${code})`}`));
        return;
      }
      log(`fiscal: se cerró ${port}${why ? ` (${why})` : ""}`);
      for (const cb of closeListeners) cb(why || `exit ${code}`);
    });
    proc.stdin.on("error", () => {});

    const link = {
      write(bytes) {
        if (closed) throw new Error("puerto cerrado");
        proc.stdin.write(Buffer.from(bytes));
      },
      onData(cb) {
        dataListeners.push(cb);
      },
      onClose(cb) {
        closeListeners.push(cb);
      },
      async close() {
        if (closed) return;
        try {
          proc.stdin.end();
        } catch {}
        await new Promise((r) => {
          const t = setTimeout(() => {
            kill();
            r(undefined);
          }, 1_500);
          proc.once("close", () => {
            clearTimeout(t);
            r(undefined);
          });
        });
      },
    };
  });
}
