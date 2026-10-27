import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs after checkout.spec.ts (same server): the business exists. Starts the real device bridge with the
// simulated fingerprint reader to exercise enrolment and fingerprint sign-in end to end.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.env.E2E_PORT ?? 4100);
const BRIDGE_PORT = 9223;
const TOKEN = 'e2e-pairing-token-0123456789abcdef';
let bridge: ChildProcess | null = null;

test.afterAll(() => {
  bridge?.kill();
});

async function signInOwner(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Data Panel Widget' })).toBeVisible();
}

test('staff card and fingerprint sign-in', async ({ page, context }) => {
  await signInOwner(page);
  // Biometrics is optional: turn it on through the API with the owner's session.
  const token = await page.evaluate(async () => (await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).json()).accessToken);
  const modules = await page.evaluate(async (t) => (await fetch('/api/v1/settings/modules', { method: 'PUT', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: ['biometrics'] }) })).status, token);
  expect(modules).toBe(200);

  // Add a cashier with a PIN, then issue and print the staff card.
  await page.goto('/settings/users');
  await page.getByRole('button', { name: 'Add user' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Juma Cashier');
  await dialog.getByLabel('Email').fill('juma@mandera.test');
  await dialog.getByLabel('Password').fill('Juma12345');
  await dialog.getByLabel(/Till PIN/).fill('2468');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('User saved')).toBeVisible();
  await page.getByRole('cell', { name: /Juma Cashier/ }).click();
  const [cardPage] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Issue card' }).click()]);
  await cardPage.waitForLoadState();
  const code = (await cardPage.locator('.code').textContent())!.trim();
  expect(code).toMatch(/^AFE[A-Z2-7]{13}$/);
  await expect(cardPage.locator('.name')).toHaveText('Juma Cashier');
  await cardPage.screenshot({ path: 'test-results/staff-card.png' });
  await cardPage.close();
  await expect(page.getByRole('dialog').getByText(`Card …${code.slice(-4)}`)).toBeVisible();

  // Register the reader and start the bridge with its key.
  await page.goto('/settings/hardware');
  await page.getByRole('button', { name: 'Register reader' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Till 1 reader');
  await page.getByRole('dialog').getByLabel('Make').selectOption('simulator');
  await page.getByRole('dialog').getByRole('button', { name: 'Register' }).click();
  const reader = JSON.parse((await page.getByTestId('reader-config').textContent())!);
  await page.getByRole('button', { name: 'Done' }).click();
  const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'afey-bridge-')), 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    port: BRIDGE_PORT, host: '127.0.0.1', allowedOrigins: [`http://pos-server.lan.test:${port}`], pairingToken: TOKEN,
    server: { url: `http://127.0.0.1:${port}` }, biometricDevice: reader.biometricDevice, printers: {}, fingerprint: { vendor: 'simulator' },
  }));
  bridge = spawn(process.execPath, [path.join(root, 'bridge', 'dist', 'index.js')], { env: { ...process.env, AFEY_BRIDGE_CONFIG: cfgFile, AFEY_SIM_FINGER: 'juma-right-index' }, stdio: 'inherit' });
  await expect.poll(async () => fetch(`http://127.0.0.1:${BRIDGE_PORT}/status`).then((r) => r.status).catch(() => 0)).toBe(401);

  // Pair this browser with the bridge.
  await page.getByLabel('Bridge address').fill(`http://127.0.0.1:${BRIDGE_PORT}`);
  await page.getByLabel('Pairing token').fill(TOKEN);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByTestId('bridge-status')).toContainText('Reader registered');

  // Enrol Juma's finger from the user editor.
  await page.goto('/settings/users');
  await page.getByRole('cell', { name: /Juma Cashier/ }).click();
  await page.getByRole('button', { name: 'Enrol finger' }).click();
  await expect(page.getByText('right index enrolled')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();

  // The card alone: scanning it (code + Enter) signs in, no PIN.
  await page.getByRole('radio', { name: 'Staff card' }).click();
  await expect(page.getByLabel('PIN')).toHaveCount(0);
  await page.getByLabel('Staff card').fill(code.toLowerCase());
  await page.getByLabel('Staff card').press('Enter');
  await expect(page.getByRole('heading', { name: 'Quick start' })).toBeVisible();
  await page.locator('[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();

  // Fingerprint: touch only, no email.
  await page.getByRole('radio', { name: 'Fingerprint' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Quick start' })).toBeVisible();
  await page.locator('[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();

  // Clock in with the card from the sign-in screen.
  await page.getByRole('button', { name: 'Clock in / out' }).click();
  await expect(page.getByRole('dialog').getByLabel('PIN')).toHaveCount(0);
  await page.getByRole('dialog').getByLabel('Staff card').fill(code);
  await page.getByRole('dialog').getByLabel('Staff card').press('Enter');
  await expect(page.getByRole('status')).toContainText('Juma Cashier: clocked in');
  await page.getByRole('button', { name: 'Use fingerprint' }).click();
  await expect(page.getByRole('status')).toContainText('Juma Cashier: clocked out');
});
