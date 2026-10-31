# Setting up Afey POS in one shop (no internet needed)

Everything runs on one computer in the shop. The tills are browsers on the same network, or that same
computer. There is no monthly hosting, no domain, and the shop keeps selling when the internet is down.

Use the other guide, **[SETUP-VPS-AND-LOCAL.md](SETUP-VPS-AND-LOCAL.md)**, if you have more than one shop,
or you want to see the business from home.

---

## 1. What you need

| | |
|---|---|
| **The shop computer** | Windows 10/11, or Ubuntu/Debian. 8 GB memory, 100 GB disk. It stays on while the shop is open. |
| **Network** | A router (Wi-Fi or cable). No internet needed for selling, only for M-Pesa, SMS and KRA. |
| **Tills** | Any computer, tablet or phone with Chrome or Edge on the same network. |
| **Printer** (optional) | A thermal receipt printer plugged into the shop computer, or a network one. |

Pick one computer to be **the server**. Everything is stored there, so back it up (see step 7).

---

## 2. Install (Windows)

1. Open **Start → Windows PowerShell → Run as administrator**.
2. Paste this one line and press Enter:

   ```powershell
   irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-online.ps1 | iex
   ```

   To use a different port than 9999:

   ```powershell
   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-online.ps1))) -Port 8080
   ```

It takes 5–15 minutes the first time and does everything: installs Node.js and MongoDB, builds Afey POS,
creates the database, writes the settings with fresh secrets, opens the port in Windows Firewall, schedules a
daily backup at 22:30, and sets Afey POS to **start with Windows and restart itself if it ever stops**.

When it finishes it prints the address to open.

## 2b. Install (Ubuntu / Debian)

```bash
curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh | sudo bash
```

A different port:

```bash
curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh | sudo bash -s -- --port 8080
```

---

## 3. Create the business

1. On the shop computer open **http://localhost:9999** (or your port).
2. Choose the business type, then fill in the business name, your name, email and password. That account is
   the **owner** and can do everything.
3. Settings → Business settings: name, KRA PIN, phone, address, currency, timezone, and the **logo**
   (the logo also becomes the icon of the installed app).

---

## 4. Let the other tills reach it

1. On the shop computer, find its address on the network:
   - Windows: `ipconfig` → "IPv4 Address", e.g. `192.168.1.50`
   - Linux: `hostname -I`
2. On each till, open `http://192.168.1.50:9999` (your address and port).
3. In Chrome or Edge: **⋮ → Cast, save and share → Install page as app**. Afey POS then opens like a normal
   program, with your logo as its icon.

**Give the server a fixed address.** In the router, reserve that IP for the shop computer (often
"DHCP reservation" or "Static lease"), so the tills always find it.

---

## 5. Set the shop up

In this order:

1. **Administration → Branches & tills** — one branch, one till per counter (give each a short code: T1, T2).
2. **Administration → Users** — one account per person, with a role (cashier, supervisor, branch manager).
   Each can have a **username** for signing in instead of the email, and a **staff card** or **fingerprint**.
3. **Administration → Checkout rules** — what cashiers may do alone, which ways to pay are shown, whether the
   till asks for the customer's phone for loyalty, and how M-Pesa behaves at the till.
4. **Inventory → Units, Categories, Brands** — then **Products**, one by one or with
   **Products → Import products** (download the Excel template, fill it in, upload it, review and import).
5. **Inventory → Receive stock** — scan everything on the shelf to put the stock in.
6. **Administration → Receipts** — the receipt layout, header and footer.

---

## 6. Printing receipts by themselves

**Hardware → This computer → receipt printer**, on each till:

- **"Printer on the Afey POS computer"** — the easiest: pick one of the printers installed on the shop
  computer. Press **Print test**, then receipts print by themselves after each sale, with the drawer opening on
  cash sales. Nothing else to install.
- **"Network printer of this till"** — a printer with its own IP address; add it under **Hardware devices**.
- **"Device bridge"** — for a USB printer, scale or fingerprint reader plugged into *that* till.
- **"Browser print window"** — works with any printer, but someone must press Print.

The choice is remembered per device, so each till can use its own printer.

---

## 7. Backups (do not skip this)

- Afey POS backs itself up every day (Windows: a task at 22:30; Linux: a timer) into the data folder, keeping
  the last 14.
- **Copy those backups off the computer** — a flash disk or an external drive, weekly at least. A stolen or
  burnt computer takes the shop's records with it.
- **Back up `server/.env` once** and keep it somewhere safe. Without its `ENCRYPTION_KEY` the stored
  secrets (M-Pesa keys and the rest) cannot be read, even from a good backup.
  - Windows: `C:\AfeyPOS\app\server\.env`
  - Linux: `/opt/afeypos/app/server/.env`
- To restore: **Settings → Backups & support**, or `installer\windows\restore.ps1 -BackupFile <file>`.

---

## 8. M-Pesa, SMS and KRA (need internet)

These are optional, and only these parts need the internet.

- **M-Pesa:** Settings → Integrations → M-Pesa. Paybill or Buy Goods, with the keys from the Daraja portal.
  - **Prompts on the customer's phone (STK) need Afey POS to be reachable from the internet**, because
    Safaricom sends its answer back to a public `https://` address. A shop-only installation does not have
    one, so use **"Customer pays Paybill/Till"**: the till watches for the payment and finishes the sale by
    itself. For prompts, host head office online (the other guide).
- **SMS / email:** Settings → Integrations, for receipts, statements and campaigns.
- **KRA eTIMS:** Settings → Integrations → KRA eTIMS. OSCU (online) or VSCU (on your network). A device can be
  set for the whole business, for a branch or for one till, and the cashier can pick one at checkout when a
  shop has several.

---

## 9. Everyday use

| | |
|---|---|
| **Start a shift** | At the till, the cashier enters the opening float. |
| **Sell** | Scan or search, choose how it is paid, done. |
| **End the day** | End shift, count the drawer, the Z report prints. |
| **Watch the money** | Reports → Daily summary, Cash Flow Movement, Drawer calculations. |
| **Order stock** | Reports → Stock analysis → Stock prediction (days). |

---

## 10. If something goes wrong

| What you see | What to do |
|---|---|
| A till cannot reach the server | Check the address and that both are on the same network. Windows: the firewall rule is "Afey POS". |
| The server is not running | It restarts itself within seconds. Windows: `installer\windows\status.ps1`, which also prints the last starts and stops. Linux: `systemctl status afeypos`. |
| Nothing opens after a restart | Give it a minute: the database starts first. Then check the log, Windows: `C:\AfeyPOS\app\logs\keeper.log`. |
| Receipts do not print | Hardware → This computer → **Print test**. If the printer was unplugged, choose it again. |
| An M-Pesa payment did not arrive | Finance → M-Pesa shows every message from Safaricom. At the till, "Enter M-Pesa code" finds a payment by its code. |

More: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## 11. Updating

Run the same install command again. Data, settings and secrets are kept, and the previous version stays for
rollback.

- Windows: `irm https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/windows/install-online.ps1 | iex`
- Linux: `curl -fsSL https://raw.githubusercontent.com/Muzamilafey/afeypos/HEAD/AfeyPOS/installer/install.sh | sudo bash`

Update when the shop is closed, and take a backup first.
