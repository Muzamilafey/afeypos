import { expect, test, type Page } from '@playwright/test';

const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

// Runs after checkout.spec.ts (same server): the business and product already exist.
test('pays through a payment gateway (simulator): pending until the provider confirms, then completes', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.goto('/settings/integrations');
  await expect(page.getByRole('button', { name: /^Paystack/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^pawaPay/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^JulyPay/ })).toBeDisabled();
  await shot(page, 'integrations-payment-methods');
  await page.getByRole('button', { name: /^Flutterwave/ }).click();
  await expect(page.getByLabel(/Webhook secret hash/)).toBeVisible();
  await shot(page, 'integrations-flutterwave-form');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Add the payment simulator/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Payment simulator' }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Checkout', exact: true }).click();
  const scan = page.getByLabel('Scan or search products');
  await scan.fill('MILK500');
  await scan.press('Enter');
  await expect(page.getByTestId('cart-total')).toHaveText(/65\.00/);
  await page.getByRole('button', { name: /^Pay / }).click();
  await page.getByRole('button', { name: 'Mobile money & cards' }).click();
  const panel = page.getByTestId('gateway-panel');
  await panel.getByLabel('Customer phone').fill('0712345678');
  await shot(page, 'pos-gateway-panel');
  await panel.getByRole('button', { name: /^Send .* request/ }).click();
  await expect(page.getByText(/Waiting for the customer to approve/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete sale' })).toBeDisabled();

  // Simulate the provider confirming (development-only endpoint, runs the normal verification path).
  await page.evaluate(async () => {
    const { accessToken } = await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).json();
    const h = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const list = await (await fetch('/api/v1/payments/intents?status=pending&provider=gateway', { headers: h })).json();
    await fetch(`/api/v1/payments/gateways/simulate/${list.data[0].id}`, { method: 'POST', headers: h, body: JSON.stringify({ status: 'succeeded' }) });
  });
  await expect(page.getByText('Payment simulator payment confirmed')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByText(/Sale RCP-\d+ complete/)).toBeVisible();
  await page.getByRole('button', { name: 'New sale' }).click();

  // Payment link flow shows a QR code for the hosted checkout page.
  await scan.fill('MILK500');
  await scan.press('Enter');
  await page.getByRole('button', { name: /^Pay / }).click();
  await page.getByRole('button', { name: 'Mobile money & cards' }).click();
  await page.getByRole('radio', { name: 'Payment link / QR' }).click();
  await page.getByRole('button', { name: /Create payment link/ }).click();
  await expect(page.getByAltText('Payment link QR code')).toBeVisible();
  await shot(page, 'pos-gateway-qr');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Back' }).click();

  await page.goto('/payments/online');
  await expect(page.getByRole('cell', { name: /^RCP-/ })).toBeVisible();
  await shot(page, 'online-payments');
});
