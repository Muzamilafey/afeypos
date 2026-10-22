import { expect, test } from '@playwright/test';

// Runs after checkout.spec.ts (same server): the business and product already exist.
test('pays with M-Pesa (simulator): pending until Safaricom confirms, then completes', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Add mpesa' }).click();
  await page.getByLabel('Provider').selectOption('mock');
  await page.getByLabel('Name', { exact: true }).fill('Till simulator');
  await page.getByLabel('Short code').fill('174379');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Till simulator' })).toBeVisible();

  await page.getByRole('link', { name: 'Checkout', exact: true }).click();
  const scan = page.getByLabel('Scan or search products');
  await scan.fill('MILK500');
  await scan.press('Enter');
  await expect(page.getByTestId('cart-total')).toHaveText(/65\.00/);
  await page.getByRole('button', { name: /^Pay / }).click();
  await page.getByRole('button', { name: 'M-Pesa', exact: true }).click();
  await page.getByPlaceholder(/Customer phone/).fill('0712345678');
  await page.getByRole('button', { name: 'Send STK' }).click();
  await expect(page.getByText(/Waiting for the customer/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete sale' })).toBeDisabled();

  // Simulate Safaricom's callback from outside the UI (development-only endpoint).
  await page.evaluate(async () => {
    const { accessToken } = await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).json();
    const h = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const list = await (await fetch('/api/v1/payments/intents?status=pending', { headers: h })).json();
    await fetch(`/api/v1/payments/mpesa/simulate/${list.data[0].id}`, { method: 'POST', headers: h, body: JSON.stringify({ resultCode: 0 }) });
  });
  await expect(page.getByText('M-Pesa payment confirmed')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByText(/Sale RCP-\d+ complete/)).toBeVisible();
  await page.getByRole('button', { name: 'New sale' }).click();

  await page.goto('/payments/mpesa');
  await expect(page.getByRole('cell', { name: /^RCP-/ })).toBeVisible();
});
