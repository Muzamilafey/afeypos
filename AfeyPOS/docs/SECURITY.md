# Security

## Authentication

- Passwords hashed with **scrypt** (N=16384, r=8, p=1, 16-byte salt); password policy: 8+ characters with letters and numbers.
- Access token: HS256 JWT, 15 minutes, held in memory by the web app. Each request re-checks the session and user status, so disabling a user or revoking a session takes effect immediately.
- Refresh token: random 256-bit value in an httpOnly, SameSite=Strict cookie (Secure over HTTPS), stored hashed, **rotated on every use**; presenting an old token after the 30 s grace window revokes the session (theft detection).
- Account lockout after 5 failed attempts (15 minutes); generic error messages; rate limits on login, MFA, PIN, password reset and registration.
- Optional **TOTP two-factor** (RFC 6238, verified against RFC test vectors) for staff accounts.
- Password reset and email verification use single-use, hashed, expiring tokens; reset revokes all sessions. Forgot-password responds identically whether or not the account exists.
- Cashier PIN sign-in for shared tills (disabled for users with 2FA).
- Supervisor overrides: short-lived (2 minutes), single-use tokens bound to the permission, the business and the requesting cashier.

## Authorisation

Permissions are enforced on the server; the web app only hides what a user cannot use.

**Roles.** Built-in roles (owner, business administrator, branch manager, inventory manager, procurement officer, cashier, accountant, auditor, salesperson, warehouse operator) are defined in `packages/shared/src/permissions.ts`. Owners and administrators can add **custom roles** (any set of the 54 permissions) under *Administration → Roles & permissions*, and adjust a single user (**allow** a permission their roles lack, or **deny** one their roles give). A user's access is: built-in roles + custom roles + allowed - denied. Owners always have everything. Access is recomputed on every request, so changes apply at once without a new sign-in; supervisor approvals (PIN, card or fingerprint) use the supervisor's effective permissions the same way, and a supervisor limited to some branches only approves at those branches (the till's or fingerprint reader's branch).

**Deny by default.** Every route a signed-in user can reach declares who may use it (`requirePermission`, `requireAnyPermission`, `requireRole` or an explicit `signedIn(reason)`). `server/tests/route-guards.test.ts` walks the live router and fails if any signed-in route has no rule, and pins the short list open to every signed-in user (their own account, the list of tills, uploaded pictures, asking a supervisor).

**No escalation.** Except for owners:
- you can only give permissions you hold (to users or in custom roles);
- you cannot change a user who can do things you cannot (including resetting their password);
- you cannot change your own roles, permissions or branches;
- only owners create or change owners, and the last active owner cannot be removed or disabled.

**Branches.** A user limited to some branches (User.branchIds) only sees and changes those branches' records. This is enforced under the routes by `server/src/db/branchScopePlugin.ts`, like tenant isolation: queries on branch-owned records (sales, returns, quotations, shifts, tills, expenses, online orders, payment intents, stock levels, movements, batches, adjustments, stocktakes, transfers, purchase orders, supplier quotations, goods received notes, supplier returns, employees, payroll runs) are filtered to their branches or warehouses, and new records elsewhere are refused. Stock transfers are dispatched only at the sending warehouse and received only at the receiving one. Reports refuse another branch's id. Branch-limited managers can only create users limited to (some of) their own branches.

**Cost prices.** Cost prices, average cost, profit and margins are removed from every response (and CSV export) for users without *See cost prices and margins* (`products.cost`), e.g. cashiers and salespeople. Supplier prices on purchasing documents stay visible to purchasing and receiving staff. Product edits by such users keep the existing cost.

**Checkout rules** (*Settings → Checkout rules*, `settings.checkoutRules`) limit what cashiers do alone. Except for page access, the server enforces them:
- **Items.** Removing a scanned item, lowering its quantity or clearing a sale can each require a supervisor (permission `sales.items.remove`). The till sends every removal to `POST /pos/item-removals`, which records it in the audit trail (`pos.item_removed`, `pos.sale_cleared`, with the supervisor). When approval is required, it consumes the supervisor's single-use approval. Holding sales can be turned off.
- **Discounts.** A cashier may be allowed no discounts, or capped per item (%), per sale (%) and per sale (amount). Above the cap, checkout requires `sales.discount.override`.
- **Shifts.** Rules available: an open shift is needed to sell; a minimum opening float; one open shift per cashier; a blind count (cashiers never receive the expected cash or the variance); closing needs a supervisor; and a cash pickup warning above an amount.
- **Pages.** Users whose only role is Cashier see only the pages allowed here; Checkout always stays. This is a menu and navigation limit. What they can read or change is still decided by their permissions.

**Refused attempts** (permission, role or branch) are written to the audit trail as `access.denied` (at most once a minute per user, reason and path).

Module gates are also enforced on the server; adjustments need approval by a different user; only owners change modules.

## Single-business data scoping

See ARCHITECTURE.md. One business per installation; records carry its id and the fail-closed scoping plugin rejects unscoped queries. Tokens are bound to the business and session; payment callbacks need the installation's secret callback token. There are no vendor/platform accounts and no remote support access into the data.

## Input and output

- All request bodies and queries validated with Zod; Mongo operators cannot be injected (no raw user objects in filters, regex input escaped, `strictQuery`).
- Ids validated as ObjectIds; lookups are always scoped to the business.
- Helmet security headers with a restrictive CSP; HTML documents escape all values; CSV export protects against formula injection; uploads checked by magic bytes and size, random names, served with `nosniff`.
- Server-side network printing is disabled in the cloud to prevent SSRF; local mode only allows private IPs.

## Secrets

- Never commit `.env`; only `.env.example` with placeholders is in the repository.
- Integration credentials, 2FA secrets, biometric templates and bridge device keys are encrypted with AES-256-GCM (`ENCRYPTION_KEY`) and never returned by the API (only which fields are set).
- Production startup refuses placeholder JWT secrets and unknown deployment roles.

## Audit trails

`AuditLog` (setup, logins, sales, voids, returns, overrides, price and credit-limit changes, adjustments, integrations, backups, biometrics, user and role changes with the permissions added or removed, refused access attempts).

## Known limitations

- No WAF or bot protection in the app itself; use the reverse proxy/CDN.
- Customers, suppliers and products are shared by all branches (not branch-scoped). The books (journal entries) are not branch-scoped either: give accounting permissions only to staff who may see the whole business.
- Rate limits and SMS token buckets are per process (use a shared store if you run many instances).
- KRA eTIMS fiscal submission is not implemented.
