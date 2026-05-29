// Send raw ESC/POS bytes to an OS-installed printer (USB or otherwise),
// going *through* the OS print spooler instead of fighting it.
//
//   Windows: PowerShell + winspool.drv WritePrinter (RAW datatype).
//   macOS / Linux: lp -d <name> -o raw -
//
// On Windows this is the supported way to talk to a USB-class thermal
// printer. WebUSB cannot do it because usbprint.sys exclusively claims
// the device for spoolsv.exe — we just hand the bytes to that same
// spooler instead. Requires the user to install the printer once in
// "Settings → Printers" (the Generic / Text Only driver works for
// raw ESC/POS — no vendor driver needed).

import { spawn } from "node:child_process";
import os from "node:os";

const PLATFORM = os.platform();

// PowerShell script that reads RAW bytes from stdin and hands them to
// winspool.drv via P/Invoke. Printer name comes from $env:PRINTER_NAME
// so we don't have to quote-escape arbitrary names into the script.
const WIN_PS_SCRIPT = `
$ErrorActionPreference = "Stop"
$name = $env:PRINTER_NAME
if ([string]::IsNullOrEmpty($name)) { throw "PRINTER_NAME env var is empty" }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr def);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool StartDocPrinter(IntPtr h, int level, [In] DOCINFOW di);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
}
"@ | Out-Null

# Slurp stdin as raw binary. PowerShell's pipeline mangles bytes, so we
# go straight to the underlying handle.
$in = [System.Console]::OpenStandardInput()
$ms = New-Object System.IO.MemoryStream
$buf = New-Object byte[] 8192
while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) }
$bytes = $ms.ToArray()
if ($bytes.Length -eq 0) { throw "no bytes on stdin" }

$h = [IntPtr]::Zero
if (-not [RawPrinter]::OpenPrinter($name, [ref]$h, [IntPtr]::Zero)) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "OpenPrinter('$name') failed: Win32 error $err"
}
try {
  $di = New-Object RawPrinter+DOCINFOW
  $di.pDocName  = "fujun-bridge"
  $di.pDatatype = "RAW"
  if (-not [RawPrinter]::StartDocPrinter($h, 1, $di)) {
    throw "StartDocPrinter failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  try {
    if (-not [RawPrinter]::StartPagePrinter($h)) {
      throw "StartPagePrinter failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $written = 0
    if (-not [RawPrinter]::WritePrinter($h, $bytes, $bytes.Length, [ref]$written)) {
      throw "WritePrinter failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    if ($written -ne $bytes.Length) { throw "short write: $written of $($bytes.Length)" }
    [void][RawPrinter]::EndPagePrinter($h)
  } finally { [void][RawPrinter]::EndDocPrinter($h) }
} finally { [void][RawPrinter]::ClosePrinter($h) }
`;

// PowerShell -EncodedCommand expects base64 of UTF-16LE.
const WIN_PS_ENCODED = Buffer.from(WIN_PS_SCRIPT, "utf16le").toString("base64");

export function sendOverSpooler(printerName, bytes, timeoutMs = 15_000) {
  if (PLATFORM === "win32") return sendWindows(printerName, bytes, timeoutMs);
  return sendUnix(printerName, bytes, timeoutMs);
}

function sendWindows(printerName, bytes, timeoutMs) {
  return run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
     "-EncodedCommand", WIN_PS_ENCODED],
    { ...process.env, PRINTER_NAME: printerName },
    bytes,
    timeoutMs,
    `spooler '${printerName}'`,
  );
}

function sendUnix(printerName, bytes, timeoutMs) {
  // CUPS: send raw bytes to the named printer. Requires the CUPS
  // raw filter — on macOS this works out of the box for any installed
  // printer; on Linux, `lpadmin -p name -o raw` if your distro doesn't.
  return run(
    "lp",
    ["-d", printerName, "-o", "raw", "-"],
    process.env,
    bytes,
    timeoutMs,
    `lp '${printerName}'`,
  );
}

function run(cmd, args, env, stdinBytes, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(new Error(`${label}: failed to spawn ${cmd}: ${e.message}`));
    }

    let stderr = "";
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      finish(new Error(`${label}: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (e) => finish(new Error(`${label}: ${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(
        `${label}: exit ${code}${stderr ? ` — ${stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`
      ));
    });

    proc.stdin.on("error", (e) => finish(new Error(`${label}: stdin: ${e.message}`)));
    proc.stdin.end(Buffer.isBuffer(stdinBytes) ? stdinBytes : Buffer.from(stdinBytes));
  });
}
