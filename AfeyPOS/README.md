# Afey POS

Afey POS is a point of sale and retail management system for **minimarts and supermarkets** in Kenya. Each installation belongs to **one business**; there is no multi-tenant SaaS mode.

It runs in one of three roles (`DEPLOYMENT_MODE` in `server/.env`):

- **standalone**: a single shop on its own Windows (or Linux) server. Several tills on the shop network share one database, and the shop keeps selling when the internet is down.
- **hq**: the business's online head-office server. Owners and admins work here, every branch syncs to it, and it serves the online shop.
- **branch**: the local server in one branch, with its own database so the branch keeps selling offline, syncing to HQ when connected.

| Part | Path | Stack |
|---|---|---|
| Shared business rules (profiles, permissions, money, barcodes) | `packages/shared` | TypeScript |
| API server | `server` | Node.js 22, Express 5, Mongoose 8, Zod, Socket.IO |
| Web app (POS and back office) | `web` | React 18, Vite 6, Tailwind CSS, TanStack Query |
| Device bridge for the till PC | `bridge` | Node.js, no native dependencies |
| Windows installer scripts | `installer/windows` | PowerShell |

## Run it on your computer (one command)

Requirements: [Node.js](https://nodejs.org) 22.9 or newer. MongoDB is optional: if it is not installed, a private copy is downloaded on the first run.

```bash
npm run local
```

Then open http://localhost:5173 and set up your business. The command installs dependencies, creates `server/.env` with fresh secrets, starts a MongoDB replica set in `./data/mongo` (port 27018, data kept between runs) unless `server/.env` already points to a reachable replica set, and starts the API (port 4000) and the web app. Press Ctrl+C to stop everything. Works on Windows, macOS and Linux.

## Quick start (development)

Requirements: Node.js 22.9 or newer and MongoDB 7 or newer **running as a replica set** (a single node is fine; see [docs/DATABASE.md](docs/DATABASE.md)).

```bash
npm install
cp server/.env.example server/.env        # then set JWT_ACCESS_SECRET and ENCRYPTION_KEY
node scripts/generate-secrets.mjs         # prints fresh values for both
./scripts/start-local-mongo.sh            # optional helper: single-node replica set in ./data/db
npm run dev                               # API on :4000, web on :5173
```

Open http://localhost:5173. In local mode you are asked to set up the business on first visit. To try a ready-made shop: `npm run seed:demo -w @afeypos/server -- hardware demo-hw` (local mode creates it only when no business exists yet; cloud mode at `demo-hw.<BASE_DOMAIN>`).

## Commands

| Command | What it does |
|---|---|
| `npm run local` | Everything at once: install, config, database, API + web |
| `npm run dev` | API + web dev servers |
| `npm run build` | Builds shared, server, web and bridge |
| `npm run typecheck` | TypeScript checks for every package |
| `npm run lint` | ESLint over the monorepo |
| `npm test` | Unit and integration tests (real MongoDB replica set in memory) |
| `npm run test:e2e` | Playwright browser tests against the built app |
| `npm start` | Runs the built server (serves the web app when `WEB_DIST_DIR` is set) |

## Documentation

- [Architecture](docs/ARCHITECTURE.md): modules, multi-tenancy, business profiles, data model
- [Database](docs/DATABASE.md): replica set, transactions, indexes, migrations
- [Windows installation](docs/INSTALL-WINDOWS.md) for shop owners
- [Cloud deployment, DNS and HTTPS](docs/DEPLOYMENT-CLOUD.md)
- [M-Pesa (Daraja)](docs/MPESA.md), [Payment gateways](docs/PAYMENTS.md) (Paystack, Flutterwave, pawaPay, Airtel Money, Kopo Kopo, Hubtel, iPay, ZenoPay, Africa's Talking), [SMS and email](docs/NOTIFICATIONS.md)
- [Hardware](docs/HARDWARE.md), [Fingerprint readers](docs/BIOMETRICS.md)
- [Backups and recovery](docs/BACKUP.md), [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Security](docs/SECURITY.md), [Reports and definitions](docs/REPORTS.md), [Hybrid sync](docs/SYNC.md)
- [API overview](docs/API.md), [Testing and results](docs/TESTING.md)
- [Feature matrix](docs/FEATURE-MATRIX.md): what is implemented, tested, partial or unverified
