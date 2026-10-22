import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

const port = Number(process.env.E2E_PORT ?? 4100);
const chromium = fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, screenshot: 'only-on-failure', trace: 'retain-on-failure', launchOptions: chromium },
  webServer: {
    command: `node ../scripts/e2e-server.mjs ${port}`,
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
