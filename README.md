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

## Install (recommended: prebuilt binary)

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

### 4. Configure

Create the config file at `~/.fujun-bridge/config.json` (Windows:
`C:\Users\<you>\.fujun-bridge\config.json`):

```json
{
  "supabase_url":     "https://<project>.supabase.co",
  "service_role_key": "eyJ...",
  "restaurant_ids":   ["00000000-0000-0000-0000-000000000000"],
  "label":            "bridge@cocina",
  "poll_interval_ms": 30000,
  "max_attempts":     3
}
```

Where to get the values:

- `supabase_url`, `service_role_key` → Supabase Dashboard → **Project Settings → API**
- `restaurant_ids` → the app's settings → Impresoras page shows the restaurant slug; the UUID is in your dashboard URL or `restaurants` table.
- `label` → free-form, helps you tell bridges apart in logs.

**One PC serving several restaurants (sucursales):** one bridge process can
drive the printers of multiple restaurants — add each restaurant's UUID to
the `restaurant_ids` array and restart the bridge. **Do not** create a
second config file over the first one: overwriting the config with only the
new sucursal's id silently stops printing for the original restaurant.
The legacy single-restaurant form `"restaurant_id": "uuid"` is still
accepted for existing installs.

**Security:** the service-role key has full project access. Lock the file
down:

```bash
chmod 600 ~/.fujun-bridge/config.json   # macOS / Linux
```

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

## Security note

The bridge currently authenticates with the **service-role key** pasted into
its local config file. The service-role key has full admin access to your
Supabase project. Mitigations in place:

- The config file is documented to be `chmod 600`.
- The `bridge_tokens` table is in the schema and reserved for a future
  hardening pass that will swap service-role for scoped tokens via RPC
  functions, limiting what a compromised bridge can do.

If this is a concern in your environment, treat each restaurant's bridge PC
as you would any other endpoint holding admin credentials: physical
security, no shared logins, no exposed RDP/SSH, automatic updates on the
OS.
