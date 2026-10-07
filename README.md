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

On Windows the installer also drops a **Print Bridge** shortcut on the
Desktop: if someone closes the bridge window by accident, double-clicking it
brings the bridge back (it refuses to start a second copy while one is
running).

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

Optional keys: `"poll_interval_ms": 30000`, `"max_attempts": 3`. Leave
`poll_interval_ms` out unless you need a fixed pending-job poll: the default
(0.6.7+) is adaptive — every 5 s while realtime is unproven, every 15 s once
it is delivering every job.

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
| Windows: jobs queue for hours, then everything prints the moment you press **Enter** in the bridge window (`CHANNEL_ERROR` → `SUBSCRIBED`) | Someone clicked inside the console: QuickEdit "Select" mode blocks every console write, which freezes the whole process. 0.5.3+ turns QuickEdit off on its own console at start. On older builds: right-click the title bar → *Propiedades* → untick *Modo de edición rápida*, or `reg add HKCU\Console /v QuickEdit /t REG_DWORD /d 0 /f`. |
| App shows `bridge desactualizado` / an old version on a printer | That PC is running an older binary. Builds ≥ 0.5.0 self-update within ~6 h of a release (see Self-update below); older ones don't: re-download from the table above, replace the file, and restart the service. The running version is also printed on the bridge's first log line. |
| `lan: no se pudo abrir el puerto 7373 (EADDRINUSE)` | Another bridge process (or a second copy run by hand) already holds the port. End every `print-bridge` process and start one. Printing through the cloud keeps working either way. |
| Impresoras page: «No responde desde este dispositivo» | The tablet can't reach the PC on port 7373: different network / guest WiFi with client isolation, or the Windows firewall. Re-run the installer as administrator (adds the rule), or allow it in *Firewall de Windows Defender → Permitir una aplicación*. Check from the tablet's browser: `http://<pc-ip>:7373/` must say «red local OK». |
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

Without a printer or the app at all, render a sample straight through this
bridge's templates (add `--png` to see the paper as an image):

```bash
node ../scripts/print-simulate.mjs --sample --recibo
node ../scripts/print-simulate.mjs --sample --settings '{"font":"raster:jetbrains-mono"}' --png ../tmp/recibo.png
```

---

## Raster font (0.6.0)

A printer whose `print_settings.font` is `raster:jetbrains-mono` gets its
text rendered by the bridge into 1-bit images (`GS v 0`, the same command the
receipt logo uses) instead of code-page text, so every printer prints the
same typeface (JetBrains Mono) regardless of its ROM font or firmware quirks.
The glyph atlas is `src/fonts/jetbrains-mono.atlas.mjs`, generated from the
OFL-licensed TTFs by `scripts/print-font-atlas/build.mjs` in the app repo;
the composer is `src/raster-text.mjs` — the same file the app's WebUSB path
imports, so both print identical bytes.

Raster tickets are 30–50× larger than text tickets (tens of KB). TCP sends
above 4 KB hold the socket open after the last byte (about 1 s per 6 KB, up
to 20 s, or until the printer closes first) so the Wi-Fi module can forward
everything to the printer before it sees the close — some modules discard
what they have not forwarded yet. Bridges older than 0.6.0 print such
printers in Font A.

**0.6.3 — "CAMBIO DE TIPO" notices.** Staff can now change an order's type
(Mesa ⇄ Para llevar ⇄ Delivery). The kitchen notice for that change rides on
the existing `table_changed` modification plus a new `previous_order_type`
field, and 0.6.3 prints it as `CAMBIO DE TIPO` / new header / `ANTES:
DELIVERY` (the header prints even when the layout hides the order type).
Older bridges print the same job as `CAMBIO DE MESA` with the new header — a
safe degraded read, never `AGREGADO` (which would make the kitchen cook the
dishes again).

0.6.3 also honors the new `otras_estaciones` line toggle, which hides the
`+ N artículos en otras estaciones` hint on station-split comandas and keeps
the `ESTACIÓN: X` header. Older bridges ignore the toggle and still print the
hint.

**0.6.4 — thousands dots on Bs/COP.** Recibo amounts in Bs and COP print
grouped (`12.432 Bs`, `1.539.300 $`); USD is unchanged. Where the dots would
not fit — the double-width TOTAL on 58mm paper, or a TOTAL EN MONEDAS column
narrowed by letter spacing — that figure (or the whole table) prints plain
instead of being cut. Older bridges keep printing plain figures.

0.6.4 also honors the new `total` line toggle, which hides the big
double-width `TOTAL` headline on the recibo (the `Incluye IVA` rows under it
still print). Older bridges ignore the toggle and always print it.

**0.6.5 — "Servicio" instead of "Propina".** Honors the new `tip_label`
print setting: with `"servicio"` every tip label on the recibo says
`Servicio` (`Servicio (sugerido)`, `SERVICIO SUGERIDO (OPCIONAL)`,
`TOTAL CON SERVICIO`, `SIN / CON SERVICIO`). Older bridges ignore it and
print `Propina`.

**0.6.6 — hide the "Propina X%" row.** Honors the new
`propina_sugerida_monto` line toggle, which drops only the `Propina 10%`
amount row from the `PROPINA SUGERIDA (OPCIONAL)` block on the recibo; the
heading and `TOTAL CON PROPINA` keep printing. Older bridges ignore the
toggle and always print the row.

**0.6.7 — adaptive pending-job poll.** The poll that catches jobs realtime
missed ran every 5 s all day (720 requests/hour per bridge, each one a billed
Supabase API log line). It now runs every 5 s only while realtime is unproven
— a channel not `SUBSCRIBED`, or a poll in the last 10 minutes found a job
realtime never delivered (manual print mode's confirmed jobs count, since
their release is an UPDATE the bridge doesn't subscribe to) — and every 15 s
otherwise; any sweep restarts the clock. The log prints `poll: every Ns (…)`
on each change. An explicit `poll_interval_ms` keeps the old fixed poll.

**0.6.8 — one dead printer no longer stalls the others; stuck jobs come
back.** A sweep of pending jobs (the poll, or the backlog after the PC's
internet drops) printed them one at a time across all printers, so a printer
that stopped answering (10 s connect timeout, three attempts) held every other
station's comanda behind it. Jobs from a sweep now start together; each
printer still prints its own jobs in order. Also: a job whose claim went
through but whose acknowledgement was lost in a network blip stayed
`in_progress` until the bridge restarted (one precuenta waited 4.7 h). Every
5 minutes the bridge now runs the same `reset_stuck_print_jobs` sweep the
browsers run, which re-queues anything stuck for 5+ minutes, and it retries
the "done" acknowledgement so a printed ticket is not re-queued and printed
twice. The log shows `reaper: re-queued N stuck job(s)` when it recovers
something.

**0.6.9 — fiado receipts carry a signature line.** A recibo settled on
crédito prints `Cuenta por cobrar a: <cliente>` as its `FORMA DE PAGO` row
and, under it, a line for the customer's signature with `Firma del cliente`
and the name. Older bridges print the row (the label travels in the payload)
but not the signature line.

**0.6.2 — no more blank paper below the rule.** 0.6.0 held the socket for
only `bytes / 32` ms (a 35 KB comanda: 1.1 s). A module that feeds the
printer over a serial link drains nearer 6–11 bytes/ms, so it had forwarded
the header and the rule when the bridge closed, and dropped the item lines:
the ticket came out as `ORDEN # / MESA / Mesero / Hora / ------` and then
nothing. The hold now assumes 6 bytes/ms, and the send has its own timeout
(≥ 30 s) separate from the 10 s connect timeout, so a slow module can apply
back-pressure for the whole drain without the socket being reset mid-job.
Update every bridge that drives a raster-font printer to 0.6.2.

**0.6.1 — overflow no longer disappears.** A ROM-font line wider than the head
was reflowed by the printer itself; a raster block has no such rule, so 0.6.0
drew what fit and threw the rest away. Two fixes, both in `raster-text.mjs`:
the column budget is now the cell PITCH (12 dots **plus** `char_spacing`, which
used to push every full-width line off the paper), and a line still too wide
wraps onto a continuation block instead of being cut. Symptoms on 0.6.0: the
rightmost column of TOTAL EN MONEDAS (COP on a three-currency ticket) losing
digits, right-aligned amounts truncated on the recibo and the cierre, and long
`ESTACIÓN:` headers cut short on comandas. Update to 0.6.1 to fix them.

## Self-update (0.5.0)

The bridge keeps itself current: ~90s after start and every ~6 hours
(jittered so a release doesn't restart the whole fleet at once) it compares
its own binary's SHA-256 against the published checksum of the latest
release. On mismatch it downloads the new binary, verifies the checksum,
swaps itself (Windows: rename-aside, since a running exe can't be
overwritten), and exits — the restart wrapper / launchd / systemd relaunches
the new build in seconds. Updates never apply while a ticket is printing.

Config escape hatches: `"disable_auto_update": true` turns it off;
`"update_repo": "owner/repo"` points a test PC at a fork's releases.
Bridges run from source (`node src/index.mjs`) never self-update.

## LAN print server (0.7.0)

The bridge also listens on the restaurant network (`0.0.0.0:7373`,
`lan-server.mjs`) so the app's tablets and PCs can hand it tickets
directly — LAN-first while online, and the only way to reach the WiFi /
USB-bridge printers while the internet is down. Chrome / Edge 142+ allow
an HTTPS page to call `http://<private IP>:7373` after a one-time "red
local" permission (the app's **Permitir** pill asks for it); Safari and
Firefox keep printing through the cloud.

- **Offline boot.** Every successful printer reload is cached in
  `~/.fujun-bridge/cache/printers.json`; the bridge starts the LAN server
  from it BEFORE signing in, so a PC that boots without internet still
  prints what tablets send.
- **Auth.** Every print carries a LAN token the app signed for a staff
  member (`lan-token.mjs`, HMAC with the pairing's `bridge_tokens.lan_secret`,
  migration 277). The bridge verifies it offline with the keys it keeps in
  `config.json` (`lan_secrets`, refreshed from `bridge_lan_secrets()` on
  every online start). Guests on the WiFi can't print.
- **Two kinds of LAN ticket.** `source: "offline"` = an order created
  without internet: the bridge answers `202 accepted` only once the payload
  is fsynced to `~/.fujun-bridge/lan/jobs/`, retries up to 5 times
  (5 s → 2 min), and parks it as failed for a manual **Reimprimir** from the
  app. `source: "cloud"` = a print_jobs row the app just inserted: the
  bridge claims the cloud row atomically before printing (realtime/poll
  can't print it twice), or prints it "blind" when its own internet is down
  and acks it from `lan/journal.jsonl` when the cloud is back.
- **Addresses.** The bridge reports its IPv4 addresses + port with
  `bridge_report_lan_endpoints` (at sign-in, on change, every 30 min).
- **Config.** `"lan_port": 7373`, `"disable_lan_server": true`,
  `"allowed_origins": ["http://localhost:3000"]` (dev). CORS answers only
  the app's origins (`app_origin` from `pair`, andescocina.com,
  `*.vercel.app`).
- **Firewall.** `install.ps1` run as administrator adds an inbound rule for
  the binary on every profile (restaurant WiFi is usually "Public"); without
  it, accept Windows' "Permitir acceso" alert. Human check from any device on
  the network: `http://<pc-ip>:7373/` → «Fujun Print Bridge vX — red local OK».

## Offline hub: order relay, store-and-forward, ticket archive (0.8.0)

0.8.0 turns the LAN server into the restaurant's meeting point while the
internet is down. Every feature is advertised in the hello reply
(`features: ["relay", "seq", "ops", "archive"]`); an app talking to an older
bridge simply doesn't use them, and a 0.8.0 bridge talking to an older app
behaves exactly like 0.7.x. All state lives under `~/.fujun-bridge/lan/`.

- **Order relay** (`lan-relay.mjs`, `lan/relay/board.jsonl`). Devices push
  the rows their offline work produced (orders, order_items — what the app
  keeps in IndexedDB) with `POST /lan/v1/relay/push`, and long-poll
  everybody else's with `POST /lan/v1/relay/pull` (`since` cursor, held up
  to 8 s — under Bun's 10 s idle timeout). Rows merge last-writer-wins; each
  order tracks which outbox operations still have to reach the cloud and is
  **settled** once they all synced (devices ack with `/lan/v1/relay/ack`, or
  the bridge uploaded them itself). Settled orders are purged after 1 h,
  unsettled ones after 72 h. A wiped store gets a new `epoch` and devices
  resync from 0. `in_cloud` tells devices when an order's create synced, so
  a payment taken on another tablet never reaches the server first.
- **Shared temporary numbers** (`POST /lan/v1/relay/seq`). One «T-NNN»
  counter per restaurant and day for every tablet, so two offline orders
  never both print as T-001.
- **Store-and-forward** (`lan-ops.mjs` + `lan-upload.mjs`, `lan/ops/`).
  A push may carry a signed copy of the operation (orders, payments, item
  status, caja movements). The bridge fsyncs it before answering and, as
  soon as it has a cloud session, posts it to the app
  (`POST <app_origin>/api/public/bridge/ops`, Bearer = the device token).
  The app checks the device signature — made with a key derived from a
  server-only secret, which the bridge never sees, so it can neither forge
  nor alter operations — and runs each one as the staff member who made
  it, through the same server action and idempotency key as the tablet's
  own replay. Results: synced / retry (backoff 5 s → 1 h) / failed / skip
  (the tablet syncs it itself). Gives up after 72 h. An app without the
  route answers 404 and the bridge waits an hour before asking again.
- **Ticket archive** (`lan-archive.mjs`, `lan/archive/<day>.jsonl`). Every
  ticket the bridge prints (cloud, LAN-first, offline, reprints — not test
  pages) is kept for today and yesterday (PC local date), payload not
  bytes. `POST /lan/v1/tickets` lists them (newest first, filter by
  `order_id` / kinds); `POST /lan/v1/tickets/reprint` renders one again with
  the «REIMPRESION» banner on the same or another printer of the restaurant
  and answers printed / failed when the printer settles within 8 s. A day
  file stops growing at 64 MB.
- **Housekeeping.** Relay sweep every minute; board, ops and archive
  compaction hourly and at boot.

## Printer discovery (0.4.0)

In device mode the bridge periodically scans its local subnets for printers
answering on TCP:9100 and enumerates the PC's installed spooler printers
(`Get-Printer` / `lpstat -e`), reporting the findings to the app (RPC
`bridge_report_discoveries`, migration 201). The app uses them to prefill
the WiFi printer form, suggest a one-click fix when a printer's DHCP
address changes, and offer a dropdown of exact spooler names. Scans run at
startup, every 6 hours, and (debounced, at most once per 15 min) after a
wifi print fails with a connection error. The scan is deliberately gentle
since 0.4.1 (a router's port-scan protection throttled a whole LAN at 32
probes): 4 concurrent probes with 150 ms gaps, port 9100 only, /24 max per
interface. Legacy service-role configs don't report (no device identity to
attach it to).

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
