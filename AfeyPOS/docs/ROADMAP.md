# Development phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Project, frontend, backend, database configuration, env files, docs | Done |
| 2 | Auth, roles, onboarding, business profiles, core data model | Done |
| 3 | Products, units, inventory, suppliers, customers, purchasing, stock movements | Done |
| 4 | Checkout, multiple tills, payments, receipts, returns, cashier reconciliation | Done |
| 5 | Minimart and supermarket features (other trades remain as optional modules) | Done, variants partial |
| 6 | M-Pesa, SMS, email, printers, barcode hardware, fingerprint adapters | Code done; live services and hardware unverified; vendor fingerprint SDKs pending |
| 7 | Windows local installation, multi-till LAN, backups, recovery | Done; installer not run on Windows yet |
| 8 | Single-business edition: standalone / head office / branch roles | Done; replaced the multi-tenant SaaS mode |
| 9 | Reports, security hardening, tests, docs, deployment | Done |

Next priorities: Daraja sandbox run, Windows installer run on a clean PC, physical printer/drawer tests, ZKTeco/SecuGen helper, KRA eTIMS, variant generator UI, offline PWA for tills, Socket.IO adapter for multi-instance cloud, more e2e coverage of back-office screens.
