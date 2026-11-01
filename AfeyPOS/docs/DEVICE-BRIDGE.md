# The Afey device bridge: printer, cash drawer, scale and fingerprint on a till PC

Afey POS runs in the browser, and a browser cannot talk to a USB printer, a cash drawer, a scale or a fingerprint
reader. The **device bridge** is a small program on the till PC that does it for the browser. It listens only on
that PC (`http://127.0.0.1:9123`), and only Afey POS with its pairing token can use it.

## 1. Do you need it?

| Your setup | Bridge needed? |
|---|---|
| The receipt printer is plugged into **the Afey POS computer itself** (the shop server) | **No.** Use *Hardware → This computer → "Printer on the Afey POS computer"*. |
| The receipt printer is a **network printer** (has its own IP, port 9100) and Afey POS runs in the shop | **No.** Use *"Network printer of this till"*. |
| The printer is plugged into **another till PC** by USB | **Yes**, on that till PC. |
| Tills use the **online** address (e.g. `https://walalaha.afey.co.ke`) and print to a local printer | **Yes**, on each till PC. |
| A **scale**, **customer display** or **fingerprint reader** on a till PC | **Yes**, on that till PC. |

The cash drawer is plugged into the receipt printer (the RJ11/RJ12 "DK" port). Whatever reaches the printer also
opens the drawer.

---

## 2. Find the IP address of the Afey POS server

The bridge needs the address the tills open Afey POS on.

**The shop server (a computer in the shop):**

1. On the **Afey POS computer**, open PowerShell (or Command Prompt) and run:

   ```powershell
   ipconfig
   ```

2. Under your network adapter ("Wi-Fi" or "Ethernet"), read **IPv4 Address**, for example `192.168.1.50`.
   Skip addresses starting with `127.` or `169.254.`.
3. The server address is then `http://192.168.1.50:9999` (your port, if you changed it).
4. Check it from the till PC: open that address in Chrome or Edge. Afey POS must load.

> **Reserve that IP in the router**, so it never changes: in the router's page (often `http://192.168.1.1`), look
> for *DHCP reservation*, *Static lease* or *Address reservation* and fix the address for the Afey POS computer.
> If the IP changes, the tills and the bridge cannot find the server.

Other ways to see it:

| Where | How |
|---|---|
| Linux server | `hostname -I` |
| From a till already using Afey POS | the address in the browser bar, e.g. `http://192.168.1.50:9999/pos` |
| Online (VPS) | your domain, e.g. `https://walalaha.afey.co.ke` |

---

## 3. Install the bridge on the till PC (Windows)

On **the till PC the printer is plugged into**, first install the printer in Windows (its own driver, or
"Generic / Text Only") and print a Windows test page.

Then open **Start → Windows PowerShell → Run as administrator** and paste one line, with your server address.

**Tills open the shop server:**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-bridge.ps1))) -ServerUrl http://192.168.1.50:9999
```

**Tills open the online address:**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-bridge.ps1))) -ServerUrl https://walalaha.afey.co.ke
```

**Both (some days the shop server, some days online):**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-bridge.ps1))) -ServerUrl http://192.168.1.50:9999 -ExtraOrigins https://walalaha.afey.co.ke
```

> Until the newest version is merged into the main branch, use the branch name instead of `HEAD` in the URL and
> add `-Ref claude/determined-maxwell-1zzhxx` at the end.

It takes a few minutes and:

- installs Node.js 22 if the PC does not have it;
- builds the bridge in `C:\AfeyBridge`;
- makes a **pairing token** (a long random password for the bridge);
- starts the bridge **with Windows**, and restarts it if it stops;
- prints what to type in Afey POS:

```
The Afey device bridge is running.

In Afey POS on THIS PC: Hardware > This computer: device bridge
  Bridge address : http://127.0.0.1:9123
  Pairing token  : 8kQ2…(48 characters)
Afey POS server : http://192.168.1.50:9999
This PC's IP    : 192.168.1.61
```

Keep this window open for the next step.

---

## 4. Pair Afey POS with the bridge

On **the same till PC**, in Afey POS:

1. Go to **Administration → Hardware**.
2. In the card **This computer: device bridge**:
   - **Bridge address:** `http://127.0.0.1:9123`. It is always `127.0.0.1`, the PC itself, never the server's IP.
   - **Pairing token:** paste the token from step 3.
   - Press **Test connection**. You should see **Bridge connected**.
3. In the card **This computer: receipt printer**:
   - Choose **Straight to the receipt printer (device bridge)**.
   - Under **Printer**, pick your receipt printer, press **Print test**, then **Use this printer**.
   - Choose the paper (58 mm or 80 mm) and tick **Print the receipt automatically after each sale**.
4. In **Cash drawer** (same card):
   - Keep **Open the cash drawer on cash sales** ticked.
   - Press **Open drawer now**. The drawer must open.

These settings are kept on this PC only, so each till can have its own printer.

**Every day:**

- A **cash sale** opens the drawer straight away, then prints the receipt.
- **More → Open drawer** opens it without a sale (for change, for example). It is recorded in the audit trail.

---

## 5. Useful commands (PowerShell as administrator, on the till PC)

| What | Command |
|---|---|
| Is it running? | `irm http://127.0.0.1:9123/status -Headers @{ 'X-Afey-Bridge-Token' = (Get-Content C:\AfeyBridge\app\bridge\config.json -Raw \| ConvertFrom-Json).pairingToken }` |
| Show the pairing token again | `(Get-Content C:\AfeyBridge\app\bridge\config.json -Raw \| ConvertFrom-Json).pairingToken` |
| See the log | `Get-Content C:\AfeyBridge\logs\bridge.log -Tail 50` |
| Restart it | `Get-CimInstance Win32_Process -Filter "Name='node.exe'" \| ? { $_.CommandLine -like '*AfeyBridge*' } \| % { Stop-Process -Id $_.ProcessId -Force }` (it starts again within 5 seconds) |
| This PC's IP address | `ipconfig` (IPv4 Address) |
| Update the bridge | Run the install line from step 3 again. The token and printer are kept. |
| Change the server address | Run the install line again with the new `-ServerUrl`. |
| Remove it | `Unregister-ScheduledTask AfeyBridge -Confirm:$false`, then delete `C:\AfeyBridge` |

The settings are in `C:\AfeyBridge\app\bridge\config.json`. After editing it by hand, restart the bridge.

---

## 6. If something goes wrong

| What you see | What to do |
|---|---|
| **Test connection**: "Failed to fetch" / cannot reach | The bridge is not running: check the log (step 5). Is the address exactly `http://127.0.0.1:9123`? |
| **Origin not allowed** | Afey POS was opened on an address the bridge does not know (e.g. `http://localhost:9999` vs `http://192.168.1.50:9999`). Run the install line again with `-ExtraOrigins <that address>`. |
| **Invalid pairing token** | Paste the token again (step 5, "Show the pairing token"). |
| The printer is not in the list | Install it in Windows first and print a Windows test page, then press **Look again** / reopen Hardware. |
| It prints strange characters | Choose a thermal (ESC/POS) printer. If needed, set its Windows driver to **Generic / Text Only**. |
| The drawer does not open | Check that the drawer cable goes into the printer's **DK** port (not the phone or network port). Press **Open drawer now**. Some drawers only open from the printer's own driver setting. |
| It stopped after Windows restarted | It starts at boot by itself; give it a minute. Check the task: `Get-ScheduledTask AfeyBridge`. |
| The server's IP changed | Reserve the IP in the router (step 2), then run the install line again with the new `-ServerUrl`. |

---

## 7. Linux or macOS till

```bash
# Node.js 22 must be installed (https://nodejs.org)
git clone https://github.com/Muzamilafey/afeypos.git ~/afeypos
cd ~/afeypos/AfeyPOS/bridge
npm install --no-save --no-package-lock typescript@5.9.3 @types/node@22.18.8
npx tsc -p tsconfig.json
cp config.example.json config.json
nano config.json   # pairingToken: 24+ random characters; allowedOrigins and server.url: your Afey POS address
node dist/index.js
```

To make a random token: `openssl rand -base64 36`. To start it at boot, add a systemd user service or a login item
that runs `node dist/index.js` in that folder.
