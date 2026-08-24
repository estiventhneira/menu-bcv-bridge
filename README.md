# fujun-bridge

Local print bridge for ESC/POS thermal printers. Runs on any PC inside the
restaurant. Watches the `print_jobs` table for the restaurant and forwards
each job to its target printer. Supports two transports:

- **WiFi / Ethernet** (`wifi`) — bytes go to the printer's IP on TCP:9100.
- **USB via OS spooler** (`usb_bridge`) — bytes go to a printer installed
  in the OS (`winspool.drv` on Windows, `lp` on macOS / Linux). Use this
  for **USB printers on Windows**, where the browser's WebUSB cannot talk
  to a USB-class printer because `usbprint.sys` exclusively claims the
  device for the print spooler.

> **You only need this bridge for WiFi printers and for USB printers on
> Windows.** Bluetooth and USB on macOS/Linux are driven directly by the
> browser — no bridge needed for those.

---

## Install (recommended: one-line installer + pairing code)

Since 0.3.0 the whole setup is one command. In the app, go to
**Configuración → Impresoras → Vincular bridge**, generate a pairing code,
and paste the command it shows into the restaurant PC:

```powershell
# Windows (PowerShell)
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://<app>/bridge/install.ps1))) -Code XXXX-XXXX -Url https://<app>"
```

```bash
# macOS / Linux
curl -fsSL https://<app>/bridge/install.sh | sh -s -- --code XXXX-XXXX --url https://<app>
```

That downloads the latest binary, exchanges the code for **scoped device
credentials** (no Supabase keys involved), writes the config itself, and
registers the bridge to start on boot (Task Scheduler / launchd / systemd).
Codes are single-use and expire in 15 minutes.

**One PC serving several restaurants (sucursales):** generate a code in each
restaurant and run the same command once per code — the pairings accumulate
onto the same bridge.

The sections below cover manual installation.

## Manual install (prebuilt binary)

The bridge is shipped as a single-file executable — no Node, no npm, no
dependencies to install.

### 1. Download

Pick your operating system:

| OS | File |
| --- | --- |
| Windows (64-bit) | [print-bridge-win-x64.exe](https://github.com/estiventhneira/menu-bcv-bridge/releases/latest/download/print-bridge-win-x64.exe) |
| macOS Apple Silicon (M1/M2/M3) | [print-bridge-macos-arm64](https://github.com/estiventhneira/menu-bcv-bridge/releases/latest/download/print-bridge-macos-arm64) |
| macOS Intel | [print-bridge-macos-x64](https://github.com/estiventhneira/menu-bcv-bridge/releases/latest/download/print-bridge-macos-x64) |
| Linux (64-bit) | [print-bridge-linux-x64](https://github.com/estiventhneira/menu-bcv-bridge/releases/latest/download/print-bridge-linux-x64) |

The settings page in the app also exposes these download buttons.

### 2. Verify integrity (optional but recommended)

Each release publishes a `.sha256` next to the binary. Match it before running:

```bash
# macOS / Linux
shasum -a 256 -c print-bridge-macos-arm64.sha256

# Windows PowerShell
Get-FileHash print-bridge-win-x64.exe -Algorithm SHA256
```

### 3. Make executable (macOS / Linux only)

```bash
chmod +x print-bridge-macos-arm64
```

On **macOS**, the first run may be blocked by Gatekeeper. Right-click the
file in Finder → **Open** → confirm. Or via terminal:

```bash
xattr -d com.apple.quarantine print-bridge-macos-arm64
```

### 4. Pair

Generate a pairing code in the app (**Configuración → Impresoras →
Vincular bridge**) and run:

```bash
./print-bridge-macos-arm64 pair XXXX-XXXX --url https://<app>
```

That writes `~/.fujun-bridge/config.json` (Windows:
`C:\Users\<you>\.fujun-bridge\config.json`) with the device credentials —
an anon key plus a per-device auth account that RLS confines to this
restaurant's printers and print jobs:

```json
{
  "supabase_url":    "https://<project>.supabase.co",
  "anon_key":        "sb_publishable_...",
  "device_email":    "bridge-<id>@devices.andescocina.com",
  "device_password": "<random>",
  "restaurants":     [{ "id": "<uuid>", "bridge_token_id": "<uuid>" }],
  "label":           "bridge@cocina"
}
```

Optional keys: `"poll_interval_ms": 30000`, `"max_attempts": 3`.

**One PC serving several restaurants (sucursales):** generate a code in each
restaurant and run `pair` once per code — restaurants accumulate in the
existing config, on the same device account.

**Legacy configs** (`service_role_key` + `restaurant_ids`) still run, with a
deprecation warning. Re-pair to migrate: the service-role key is scheduled
to be rotated, at which point old configs stop working.

### 5. Run

```bash
# macOS / Linux
./print-bridge-macos-arm64

# Windows — double-click the .exe, or:
print-bridge-win-x64.exe
```

You should see:

```
[2026-05-21T18:42:01.000Z] fujun-bridge v0.2.0 starting (label=bridge@cocina, restaurants=…)
[2026-05-21T18:42:01.500Z] tracking 1 wifi printer(s): Cocina@192.168.1.100:9100
[2026-05-21T18:42:01.700Z] realtime: SUBSCRIBED
```

Triggering a print from the app should produce a line like:

```
printing job <uuid> → Cocina
ok job <uuid> (470 bytes)
```

---

## USB printers on Windows (the `usb_bridge` transport)

If you've hit `Otro programa está usando la impresora` when trying to print
to a USB POS-80 from the browser on Windows, this is the supported fix.
The bridge sends raw ESC/POS bytes through the Windows print spooler —
the same spooler that was blocking WebUSB — using `winspool.drv`'s
`WritePrinter` API. No Zadig, no driver replacement, the printer keeps
working normally for every other Windows app.

**One-time setup on the Windows PC where the printer is plugged in:**

1. Plug the printer in and let Windows install whatever default driver it
   wants. Or, for cleanest behavior, manually install it using the
   **Generic / Text Only** driver:
   *Settings → Bluetooth & devices → Printers & scanners → Add device → The
   printer I want isn't listed → Add a local printer → Use existing port:
   `USB001` (or whatever it's on) → Generic / Generic / Text Only*.
2. Give it a memorable name when prompted — e.g. `POS-80`.
3. Right-click → **Printer properties** → **Print Test Page**. Confirm a
   blank page (or garbled text) prints — this just proves the spooler can
   reach the device. We'll be sending raw ESC/POS over the same channel.
4. Install and run the bridge on this PC (see below).
5. In the app → **Configuración → Impresoras → Agregar**, pick
   **"USB en Windows/Mac (vía bridge local)"** and paste the printer name
   from step 2 *exactly*.
6. Send a test print from the app.

The same transport works on macOS/Linux too: install the printer in CUPS,
mark it as raw (`lpadmin -p POS-80 -E -v usb://... -o raw`), and use the
CUPS queue name in the app.

---

## Run as a background service

You'll want the bridge to start automatically at boot so kitchen staff
never have to think about it.

### Windows (Task Scheduler)

1. Save the binary somewhere stable, e.g. `C:\fujun-bridge\print-bridge-win-x64.exe`.
2. Open **Task Scheduler** → **Create Basic Task…**
3. Trigger: **When the computer starts**
4. Action: **Start a program** → browse to the .exe
5. Finish → open the task's properties → **Run whether user is logged on or not**, **Run with highest privileges**, **Restart on failure**.

Alternatively use [NSSM](https://nssm.cc/) to register it as a true
Windows service.

### macOS (launchd)

Save the binary to `/usr/local/bin/print-bridge`. Create
`~/Library/LaunchAgents/com.fujun.print-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.fujun.print-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/print-bridge</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/fujun-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/fujun-bridge.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.fujun.print-bridge.plist
```

### Linux (systemd)

Save the binary to `/usr/local/bin/print-bridge`. Create
`/etc/systemd/system/fujun-bridge.service`:

```ini
[Unit]
Description=Fujun print bridge
After=network.target

[Service]
ExecStart=/usr/local/bin/print-bridge
Restart=always
User=fujun
Environment=PRINT_BRIDGE_CONFIG=/etc/fujun-bridge/config.json

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now fujun-bridge
journalctl -u fujun-bridge -f   # follow logs
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `No config file at …` | Config not created or wrong path. Use `$PRINT_BRIDGE_CONFIG=/path/to/config.json` to override the default location. |
| `tracking 0 printer(s)` | No active `wifi` or `usb_bridge` printer rows in the database for this restaurant. Add one at `/<slug>/settings/printers`. |
| `spooler 'POS-80': exit 1 — OpenPrinter('POS-80') failed: Win32 error 1801` | Printer name doesn't match what's installed on this PC. Open *Settings → Printers* and copy the name exactly (case-sensitive). |
| `spooler 'POS-80': exit 1 — Win32 error 5` | "Access denied." The bridge process can't see the printer because it's installed for a different Windows user. Either reinstall the printer as "Share this printer" → "Render print jobs on client computers", or run the bridge as the same user who installed the printer. |
| Garbled text prints | The OS printer is configured with a vendor driver that intercepts the bytes. Reinstall it with the **Generic / Text Only** driver. |
| `realtime: CONNECTING` (never SUBSCRIBED) | No internet, wrong `supabase_url`, or wrong key. |
| `ECONNREFUSED` / `ETIMEDOUT` on print | Printer powered off, wrong IP, or printer on a different LAN than the bridge PC. Verify: `nc -vz <printer-ip> 9100`. |
| Jobs queue but never print | Bridge isn't running, or printer is `is_active=false` in the DB. |
| App shows `bridge desactualizado` / an old version on a printer | That PC is running an older binary. Downloads never auto-update: re-download from the table above, replace the file, and restart the service. The running version is also printed on the bridge's first log line. |
| macOS: "cannot be opened because the developer cannot be verified" | `xattr -d com.apple.quarantine print-bridge-macos-arm64`, then run again. |

---

## Develop / build from source

Only needed if you're modifying the bridge code itself.

```bash
# Run from source (requires Node 20+):
npm install
node src/index.mjs

# Build single-file binaries for all 4 targets (requires Bun):
./build.sh

# Build one target only:
./build.sh macos-arm64
```

Output is in `dist/`. Cross-compilation works from any host — Bun bundles
the right runtime for the target.

## Test against the simulator instead of a real printer

In one terminal:

```bash
node ../scripts/print-simulate.mjs    # listens on tcp://127.0.0.1:9100
```

Then configure a WiFi printer in the app with `host=127.0.0.1 port=9100`,
run the bridge, and trigger a print from the app. The simulator decodes
the bytes and dumps them to stdout.

---

## Printer discovery (0.4.0)

In device mode the bridge periodically scans its local subnets for printers
answering on TCP:9100 and enumerates the PC's installed spooler printers
(`Get-Printer` / `lpstat -e`), reporting the findings to the app (RPC
`bridge_report_discoveries`, migration 201). The app uses them to prefill
the WiFi printer form, suggest a one-click fix when a printer's DHCP
address changes, and offer a dropdown of exact spooler names. Scans run at
startup, every 15 minutes, and (debounced) after a wifi print fails with a
connection error. The scan is light: ≤32 concurrent connection probes,
port 9100 only, /24 max per interface, done in a few seconds. Legacy
service-role configs don't report (no device identity to attach it to).

## Security note

Since 0.3.0 the bridge authenticates as a **per-device auth account**
provisioned through the pairing flow (migration 200). What that means:

- The config file holds the public anon key plus device credentials that RLS
  confines to the paired restaurants' `printers` (read-only) and
  `print_jobs` (read + status transitions). Printer claims/heartbeats go
  through two `SECURITY DEFINER` RPCs, so a compromised device cannot
  rewrite printer connection settings, deactivate printers, or read anything
  else in the database.
- Revoking a bridge in the app (Configuración → Impresoras → Bridges
  vinculados) cuts it off immediately — the RLS helper re-checks
  `revoked_at` on every query and every realtime event.
- The pair CLI writes the config with `chmod 600`.

Legacy configs carried the **service-role key** (full project access). They
still run during the migration window; once the fleet is re-paired, that key
gets rotated and old configs stop authenticating entirely.
