# Hardware and peripherals

Afey POS uses standard protocols and does **not** claim universal compatibility. The table shows what is implemented and how it was verified.

| Device | How it connects | Status |
|---|---|---|
| USB / Bluetooth barcode scanner | Keyboard (HID) mode, sends Enter after each code; checkout search box is always focused; scans are queued | Implemented; tested with simulated rapid keyboard input (Playwright) |
| Network barcode scanner | Same as above via its keyboard-wedge driver | Not verified |
| Receipt printer, network (port 9100) | Server sends ESC/POS (local installation only) or via bridge | Implemented; tested against a TCP test server |
| Receipt printer, USB | Browser printing (80 mm HTML receipt) or bridge (`windows-share` raw printing or `/dev/usb/lp0`) | Implemented; not verified on physical printers |
| Cash drawer | Printer DK port, ESC/POS kick `ESC p 0 25 250` on cash sales | Implemented; not verified on hardware |
| A4 printer | Browser printing of invoices, quotations, delivery notes | Implemented |
| Label printer | Browser labels (50×30 mm, Code 128) or ZPL/TSPL output (`POST /hardware/labels`) | Implemented; not verified on Zebra/TSC hardware |
| Customer pole display | Bridge, serial (`\\.\COMx`), 2×20 characters | Implemented; not verified |
| Weighing scale | (a) price/weight-embedded EAN-13 scale labels parsed at checkout (prefixes 20-29, configurable), (b) bridge serial read (CAS/generic frames) | (a) implemented and tested; (b) not verified |
| RFID reader | Keyboard-wedge readers work like scanners | Not verified |
| Fingerprint reader | See BIOMETRICS.md | Protocol implemented; vendor SDKs not integrated |

## Configuration

*Settings → Hardware* stores device definitions per till (type, connection, IP/port, bridge URL, drawer option) with a **Test** button and status. *Settings → This device* chooses the till, receipt width and auto-print.

## The device bridge

`bridge/` runs on the till PC and exposes an authenticated API on `http://127.0.0.1:9123`:

```bash
cd bridge && cp config.example.json config.json   # set pairingToken, allowedOrigins, server.url, printers
npm run build && npm start
```

Every request needs the `X-Afey-Bridge-Token` header and must come from an allowed origin, so other websites in the browser cannot use your devices. Endpoints: `GET /status`, `POST /print/raw {base64, printer}`, `POST /drawer/open`, `POST /display {line1,line2}`, `GET /scale/weight`, `POST /fingerprint/enroll-capture`, `POST /fingerprint/verify`. Run it at login with Task Scheduler (`node dist\index.js`, working directory `bridge`).

Raw receipt bytes for the bridge come from `GET /api/v1/sales/:id/receipt?format=escpos`.

## Troubleshooting

- Scanner types into the wrong field: click the checkout search box (F2). Configure the scanner suffix to *Enter*.
- Prints garbage: the printer is not in ESC/POS mode or the Windows driver is not *Generic / Text Only* for raw printing.
- Network printer test fails: check the IP, that port 9100 is open, and that the server and printer are on the same network. Cloud installations cannot print to LAN printers from the server; use the browser or the bridge.
- Drawer does not open: check the RJ11/RJ12 cable goes to the printer's DK port; some drawers need pin 1 (`openDrawer(1)`).
