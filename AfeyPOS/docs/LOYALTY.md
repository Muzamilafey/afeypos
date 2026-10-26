# Loyalty program and gift vouchers

## Loyalty program (Customers & marketing → Loyalty program)

Customers earn points on every purchase and pay with them later. It needs the **Loyalty** module.

**Program rules** (people who can change settings):
- **Spend for 1 point** and **value of 1 point**, e.g. 1 point per KES 100, worth KES 1.
- **Fewest points per payment**, and **most of a sale paid with points** (%).
- **Welcome bonus**: points given once, when the customer gets a card.
- **Tiers earn faster**: a multiplier for each CRM spend tier (last 12 months), e.g. Gold × 1.5.

**Members**:
- **Give card** assigns a card number (`LC` + 10 digits) and adds the welcome bonus. **Card** prints it, credit-card sized, with a barcode.
- Open a member to see every point change (earned, paid with, bonus, adjusted, reversed) with the sale number.
- Users with *Run the loyalty program* (`loyalty.manage`, branch manager and above) can add or remove points with a reason. Every change is in the audit trail.

**At the till**: **Loyalty Card** → scan the card (or type the card number or phone). The customer is put on the sale. With points available, the payment opens on **Points** with the most the rules allow already filled in. Points paid with never earn points. A voided sale reverses its points.

## Gift vouchers (Customers & marketing → Gift vouchers)

A voucher has a value and can be spent in parts until its balance runs out. It needs *Issue, sell and cancel gift vouchers* (`vouchers.manage`).

- **Issue vouchers**: value, how many (up to 200 at once), type and expiry date.
  - **Sold**: say how it was paid. Cash goes into the open shift of this computer's till as cash in.
  - **Promotion** or **goodwill**: given away free.
  - Codes look like `GV-ABCD2345`, with no 0/O or 1/I. Vouchers print with a barcode, on the receipt printer or several on A4.
- **At the till**: **Voucher** → scan or type the code → **Check voucher** shows the balance → **Pay with this voucher**. The rest of the sale can be paid any other way, and any leftover balance stays on the voucher. The server takes the amount off atomically, so a voucher cannot be spent twice. A voided sale puts the amount back.
- **Cancel** a lost or stolen voucher (with a reason); it can no longer be used.
- The **Voucher** button also takes **discount coupons** (codes set up under Promotions).

Accounting: vouchers paid at the till are debited to *2310 Gift vouchers outstanding*.

Limitation: branch servers working offline cannot see a voucher spent at another branch until they sync. A voucher used twice while offline shows up at head office.
