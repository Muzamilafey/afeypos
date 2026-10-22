# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Server exits: "MongoDB is running as a standalone server" | Configure a replica set (DATABASE.md) or, for experiments only, `MONGODB_REQUIRE_REPLICA_SET=false` |
| Server exits: "Invalid environment configuration" | The message lists the variable; generate secrets with `node scripts/generate-secrets.mjs` |
| "No business is registered at this address" (404) | Cloud: wrong subdomain or DNS; dev: set `VITE_DEV_TENANT` and `ALLOW_TENANT_HEADER=true` |
| "This account is suspended" | Platform owner suspended the tenant (unpaid/abuse); reactivate in the portal |
| Tills cannot reach the server | Same network? Firewall rule "Afey POS" on a *Private* profile? Use the server IP, not localhost |
| "Open a shift on this till before selling" | Checkout → open shift, or disable *Require an open shift* in settings |
| "Insufficient stock" | Receive stock (GRN) or adjust; negative stock is blocked by default |
| "Supervisor approval required" | A manager enters their email and PIN/password in the approval dialog |
| M-Pesa stays pending | Callback URL not public HTTPS, wrong passkey/short code, or customer ignored the prompt. Press *Check status*; it expires after the timeout and nothing is charged |
| "M-Pesa is not configured for this branch" | Add a Daraja integration in Settings → Integrations |
| SMS shows `skipped` | No SMS provider configured, invalid number, or monthly allowance used |
| Receipt printer prints nothing | See HARDWARE.md; test with the device *Test* button |
| Locked out after failed logins | Wait 15 minutes or reset the password |
| Lost owner password and email | Local: on the server run `npm run reset-password -w @afeypos/server -- <email> <newPassword>` (or `node --env-file=.env dist/scripts/resetPassword.js ...` in `server`); cloud: the platform owner assists through support |
| Backup restore refused: checksum | The file was modified or truncated; use another copy |
| Restore refused: "Target database is not empty" | Add `--drop-existing` (full) or `--replace-tenant` (tenant), after confirming you have a current backup |
