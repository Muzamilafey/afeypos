import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 4100);

export default defineConfig({
  testDir: './e2e',
  testMatch: ['checkout.spec.ts', 'mpesa.spec.ts', 'gateway.spec.ts', 'staff.spec.ts', 'hr.spec.ts', 'ledger-crm.spec.ts', 'shop.spec.ts', 'suppliers.spec.ts', 'roles.spec.ts', 'receipts.spec.ts', 'till-rules.spec.ts'],
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  // Browse via a non-loopback hostname, like a till on the shop LAN: browsers treat 127.0.0.1 specially
  // (e.g. they never upgrade it to HTTPS), which would hide plain-HTTP deployment bugs.
  use: {
    baseURL: `http://pos-server.lan.test:${port}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--no-proxy-server', '--host-resolver-rules=MAP pos-server.lan.test 127.0.0.1, MAP shop.lan.test 127.0.0.1'] },
  },
  webServer: {
    command: `node ../scripts/e2e-server.mjs ${port}`,
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: Boolean(process.env.E2E_REUSE),
    timeout: 120_000,
  },
});
