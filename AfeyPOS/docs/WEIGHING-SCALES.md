# Weighing scales

Afey POS works with two kinds of scale:

| Kind | What it does | How Afey POS talks to it |
|---|---|---|
| **Counter scale** | Weighs at the till; the weight goes straight onto the sale line. | Serial (RS-232 or USB-serial) output read by the **device bridge** on the till PC, or a scale that **types the weight** like a keyboard. |
| **Label scale** | Weighs at the deli/butchery counter and prints a price label with a barcode. The till reads the barcode. | A **PLU file** (number, name, price, weighed/counted) that you import with the scale maker's own PLU software. |

Settings → **Weighing scales** (`/settings/hardware/scales`) is where scales are added, tested and sent prices.

## What Afey POS does not do

- It does **not** program any brand's scale over that brand's own network protocol. No such protocol is
  implemented, and none is claimed. Prices reach label scales through the PLU file and **you confirm the import**.
- A scale is never marked as working because it was saved. It is **verified** only after:
  - **counter scales:** a stable reading within 1% (at least 5 g) of a known test weight, or
  - **label scales:** a confirmed PLU import.
- Changing a scale's port, baud rate, connection or role puts it back to **unverified**.
- The **Simulator** brand is for training and automated tests. It is always labelled "simulated" and is never
  used to weigh real sales.

## Brands

| Brand | Weight to the till | PLU list (label scales) |
|---|---|---|
| CAS | Serial or keyboard output (model dependent) | PLU file → CAS PLU software |
| DIGI | Serial (model / interface option dependent) | PLU file → DIGI PC software |
| Avery Berkel | Serial where the model has it | PLU file → maker's software |
| Bizerba | Serial where the model has it | PLU file → maker's software |
| Mettler Toledo | Serial (continuous or on request) on many models | PLU file → maker's software |
| Ishida | Serial where supported | PLU file → maker's software |
| Adam Equipment | Serial / USB or keyboard | Weight only |
| OHAUS | Serial / USB or keyboard | Weight only |
| Other | Most counter scales send a plain weight line | PLU file |

Output formats differ between models, so always run the test.

## Set up a counter scale (serial, through the device bridge)

1. Install the device bridge on the till PC ([DEVICE-BRIDGE.md](DEVICE-BRIDGE.md)) and pair it
   (Hardware → This computer).
2. Connect the scale. Find its port: **Device Manager → Ports (COM & LPT)** on Windows (e.g. `COM3`),
   `/dev/ttyUSB0` on Linux.
3. On the scale, set the output to **continuous** or **on request**, with the baud rate from its manual (often 9600).
4. In the bridge's `config.json` on that PC, add:
   ```json
   "scale": { "port": "COM3", "baud": 9600 }
   ```
   If the scale's manual gives a tare or zero command, add it too, e.g. `"tareCommand": "T\r\n"`.
   Without one, the cashier presses TARE on the scale itself. Restart the bridge.
5. In Afey POS: **Weighing scales → Add scale**. Choose the brand, the **Serial / USB-serial** connection, the
   **Counter** role, the port, and the tills that weigh on it.
6. **Test**: zero the scale, put a known weight on it (a sealed 1 kg bag of sugar), type that weight, press
   **Read the scale**, then **Check reading**.

The bridge understands lines such as `ST,GS,+  1.250kg` (stable, gross), `ST,NT,+  1.000kg` (net),
`ST,TR,+  0.250kg` (tare), `US,...` (unstable), and plain `1.250 kg` or `350 g`.

## Keyboard-output scales

Choose the **Keyboard output** connection. When testing, click the box and press the scale's send/print key.

## At the till

Products marked **sold by weight** open a **Weigh** window when they are scanned or picked, if the till has a
verified counter scale. The window shows gross, tare and net weight. **Add** (or Enter) is possible only when the
weight is **stable**, more than zero, and within the scale's minimum and capacity. The server prices the line;
the amount shown is only an estimate.

A barcode printed by a label scale skips the window: its weight or price comes from the barcode.

## Label scales: sending prices

1. **Add scale** with the **Label-printing scale: file for the maker's software** connection and the **Label** role.
   Choose whether it receives every product with a PLU, or only products assigned to it (product wizard,
   Hardware & labels step).
2. Give weighed products a **PLU** (product wizard: **Next free**, or Products → select → **Assign PLUs**).
3. **Send prices → Prepare PLU file**. Download the CSV (`PLU,Name,Unit price,Type`), import it with the scale
   maker's PLU software (map the columns on its import screen), and check one price on the scale.
4. Press **Confirm import**. The scale now shows **prices current (vN)**.

Every send is a numbered version. A newer send replaces an unfinished older one. When a price or PLU changes
in Afey POS, the scale shows **PLUs to send** until the next confirmed send. Direct sends (simulator only)
retry by themselves with increasing waits; after the last attempt they show **failed** with a **Retry** button.

## Scale label barcodes

On the same page, **Scale label barcodes** sets how the till reads a label's barcode. Copy the layout from the
scale's barcode settings. Ready-made layouts:

| Layout | Example | Meaning |
|---|---|---|
| Weight: 2 + item 5 + weight 5 (g) | `21 00123 01255 C` | PLU 123, 1.255 kg |
| Price: 2 + item 5 + price 5 (cents) | `22 00123 00450 C` | PLU 123, 4.50 |
| Price: 2 + item 4 + price 6 (cents) | `23 0012 000450 C` | PLU 12, 4.50 |
| Weight: 2 + item 6 + weight 4 (g) | `24 000123 1255 C` | PLU 123, 1.255 kg |

Layouts are checked so that positions stay inside the code, the item and value don't overlap, and prefixes
don't clash with each other or with internal barcodes (`04`). The older single setting in Business settings
still applies until layouts are saved here.

## Tests

`server/tests/scales.test.ts` and `web/e2e/zz-scales.spec.ts` use the **simulator** and the **keyboard** adapter.
No physical scale is attached in CI; check real hardware with the Test button before use.
