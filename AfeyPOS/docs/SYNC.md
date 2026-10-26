# Branch ↔ head-office sync

Afey POS is one business per installation. A chain runs one online **head-office (HQ)** server and, for branches
that must keep selling without internet, a **branch server** each with its own MongoDB. Tills always talk to the
server in their own building.

## Who owns what

| Data | Edited on | Direction |
|---|---|---|
| Business settings and modules, branches, stores, tills, staff (incl. password/PIN hashes), categories, brands, products, prices, customer prices, promotions, suppliers, notification templates, integrations for the branch | HQ | HQ → branches |
| Sales, returns, voids, sales documents, shifts, cash movements, expenses, M-Pesa/gateway payments, stock levels/movements/batches/serials of the branch's own stores, adjustments, stocktakes, goods received, supplier returns, customer/supplier ledger entries, attendance, audit log | the branch | branch → HQ |
| Customers, stock transfers, supplier quotations, purchase orders, fingerprint templates | either | both (newest edit wins) |
| Other branches' stock | owning branch | HQ → branches, read-only (to see stock elsewhere) |

On a branch server, head-office data is read-only (editing returns `MANAGED_AT_HQ`). Stock in a store can only change
on the server that owns it (`STOCK_OWNED_ELSEWHERE` otherwise): a branch's own stores on its server; at HQ, the stores
of branches without their own server. This avoids merging concurrent stock edits altogether.

## How it works

- Every ~20 s while online (`SYNC_INTERVAL_SECONDS`) and on **Settings → Branch sync → Sync now**, the branch:
  1. says hello (checks the token, `BRANCH_CODE`, the protocol version and that `ENCRYPTION_KEY` matches HQ);
  2. downloads HQ-owned data changed since its cursor;
  3. on first contact only, downloads its own stores' stock as HQ last knew it;
  4. uploads everything it changed since its cursor, collection by collection;
  5. downloads shared records (customers, transfers…) and other branches' stock, then deletions (tombstones);
  6. reports its pending count and last error for the HQ dashboard.
- Records are copied whole in Extended JSON (ids and dates preserved), ordered by `updatedAt` (or `at` for
  append-only records), and applied **newest wins**, so retries and repeats are harmless. Each step resumes from a
  stored cursor: a run interrupted by a network drop, or a week offline, continues where it stopped.
- Records younger than a few seconds (`SYNC_SETTLE_MS`, default 5000) wait for the next run so a transaction still
  committing is never skipped.
- HQ only accepts records that belong to the sending branch (its branch id, tills or stores). Others are rejected.
- **Balances**: several branches change the same customer's or supplier's balance, so HQ recomputes balances from the
  ledger entries rather than copying them. A branch keeps its own figure for a customer while its newer ledger entries
  are still waiting to upload.
- **Document numbers** on a branch server carry the branch code (`RCP-MSA01-000123`, `TRF-MSA01-000004`,
  customer `C-MSA01-00012`) so they never collide after sync.
- **Transfers between branches**: dispatched on the sender's server (stock leaves there); the receiver's server
  counts it as in transit when the transfer arrives by sync, and receiving happens there (stock arrives there);
  the result flows back to the sender and HQ.

## Limits

- Credit limits and loyalty points are checked against each server's latest figures, so a customer buying on credit
  at two offline branches at the same time could exceed the limit until they sync.
- M-Pesa: a branch confirms its STK payments with Safaricom's status query while online (callbacks go to HQ's public
  address). Paybill/Till payments received while a branch is offline appear once it syncs.
- If a record cannot be applied (for example a unique code clash), it is listed under **Branch sync → Records that
  need attention** on the side that refused it, for an administrator to fix.
- **Resync** (owner) resets the cursors and resends/redownloads everything; this is safe because of newest-wins.

## Tests

`server/tests/sync.test.ts` runs HQ in the test process and two real branch server processes with their own
databases: bootstrap, read-only HQ data, selling at a branch, HQ blocked from branch stock, price changes,
customers and credit balances, HQ → branch and branch → branch transfers, and the HQ dashboard.
