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

Server-enforced RBAC (`packages/shared/src/permissions.ts`) with roles: owner, business administrator, branch manager, inventory manager, procurement officer, cashier, accountant, auditor, salesperson, warehouse operator. Branch restrictions per user. Module gates on the server. Adjustments require approval by a different user. Only owners can create owners or change modules.

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

`AuditLog` (setup, logins, sales, voids, returns, overrides, price and credit-limit changes, adjustments, integrations, backups, biometrics).

## Known limitations

- No WAF or bot protection in the app itself; use the reverse proxy/CDN.
- Rate limits and SMS token buckets are per process (use a shared store if you run many instances).
- KRA eTIMS fiscal submission is not implemented.
