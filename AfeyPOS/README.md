# Afey POS

Afey POS is a point of sale and business management system for shops, wholesalers, hardware stores, minimarts, supermarkets, electronics shops, boutiques, pharmacies, liquor stores and multi-branch chains, in Kenya and elsewhere.

It runs two ways:

- **Local installation**: one business on its own Windows (or Linux) server. Several tills on the shop network share one database, and the shop keeps selling when the internet is down.
- **Cloud SaaS**: many businesses on one platform, each at its own subdomain (`mandera.afeypos.com`), with isolated data, plans, trials and a platform-owner portal.

| Part | Path | Stack |
|---|---|---|
| Shared business rules (profiles, permissions, money, barcodes) | `packages/shared` | TypeScript |
| API server | `server` | Node.js 22, Express 5, Mongoose 8, Zod, Socket.IO |
| Web app (POS, back office, platform portal) | `web` | React 18, Vite 6, Tailwind CSS, TanStack Query |
| Device bridge for the till PC | `bridge` | Node.js, no native dependencies |
| Windows installer scripts | `installer/windows` | PowerShell |

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
- [M-Pesa (Daraja)](docs/MPESA.md), [SMS and email](docs/NOTIFICATIONS.md)
- [Hardware](docs/HARDWARE.md), [Fingerprint readers](docs/BIOMETRICS.md)
- [Backups and recovery](docs/BACKUP.md), [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Security](docs/SECURITY.md), [Reports and definitions](docs/REPORTS.md), [Hybrid sync](docs/SYNC.md)
- [API overview](docs/API.md), [Testing and results](docs/TESTING.md)
- [Feature matrix](docs/FEATURE-MATRIX.md): what is implemented, tested, partial or unverified
