import { expect, test } from '@playwright/test';

// Runs after checkout.spec.ts (same server): the business and product already exist.
test('pays with M-Pesa (simulator): pending until Safaricom confirms, then completes', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Data Panel Widget' })).toBeVisible();

  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: /^M-Pesa simulator/ }).click();
  await expect(page.getByLabel('Provider')).toHaveValue('mock');
  await page.getByLabel('Name', { exact: true }).fill('Till simulator');
  // Typed key by key: the field must keep focus while the dialog re-renders.
  await page.getByLabel('Short code').pressSequentially('174379');
  await expect(page.getByLabel('Short code')).toHaveValue('174379');
  await expect(page.getByLabel('Short code')).toBeFocused();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('article', { name: 'Till simulator' })).toBeVisible();

  // Register the C2B URLs and prove them with a test payment.
  const card = page.getByRole('article', { name: 'Till simulator' });
  await expect(card.getByText('Not registered')).toBeVisible();
  await card.getByRole('button', { name: 'Register C2B URLs' }).click();
  const c2b = page.getByRole('region', { name: 'C2B URL registration' });
  await expect(c2b.getByLabel('Short code to register')).toHaveValue('174379');
  await c2b.getByRole('button', { name: 'Register C2B URLs' }).click();
  await expect(c2b.getByRole('status')).toContainText('Registered for short code 174379');
  await c2b.getByRole('button', { name: 'Send test payment' }).click();
  await expect(c2b.getByRole('status')).toContainText('Test payment');
  await expect(c2b.getByText('None yet')).toHaveCount(0);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/c2b-register.png` });
  await page.keyboard.press('Escape');
  await expect(card.getByText('Registered (174379)')).toBeVisible();

  await page.getByRole('link', { name: 'Checkout', exact: true }).click();
  const scan = page.getByLabel('Scan or search products');
  await scan.fill('MILK500');
  await scan.press('Enter');
  await expect(page.getByTestId('cart-total')).toHaveText(/65\.00/);
  await page.getByRole('button', { name: /^Pay / }).click();
  await page.getByRole('button', { name: 'M-Pesa', exact: true }).click();
  await page.getByPlaceholder(/Customer phone/).fill('0712345678');
  await page.getByRole('button', { name: 'Send prompt' }).click();
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
  // Nothing to press: the confirmed payment covers the sale, so the till completes and prints it.
  await expect(page.getByText(/Sale RCP-\d+ complete/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'New sale' }).click();

  // Customer pays the Paybill themselves: the till is already watching for it, with nothing to press.
  await scan.fill('MILK500');
  await scan.press('Enter');
  await page.getByRole('button', { name: /^Pay / }).click();
  await page.getByRole('button', { name: 'M-Pesa', exact: true }).click();
  const watching = page.getByTestId('mpesa-watching');
  await expect(watching).toContainText('174379');
  // The cashier can still send a prompt or type a code while the till watches.
  await expect(page.getByRole('radio', { name: 'Customer pays Paybill/Till' })).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/pos-mpesa-paybill.png` });
  const account = await watching.locator('text=/^T1\\d{4}$/').innerText();
  await page.evaluate(async (acct) => {
    const { accessToken } = await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).json();
    const h = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    await fetch('/api/v1/payments/mpesa/simulate-c2b', { method: 'POST', headers: h, body: JSON.stringify({ amountCents: 6500, account: acct }) });
  }, account);
  await expect(page.getByText('M-Pesa payment confirmed')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Sale RCP-\d+ complete/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'New sale' }).click();

  // Money paid to the till without a sale is not listed: the cashier finds it only by its M-Pesa code.
  await page.evaluate(async () => {
    const { accessToken } = await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).json();
    const h = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    await fetch('/api/v1/payments/mpesa/simulate-c2b', { method: 'POST', headers: h, body: JSON.stringify({ amountCents: 10000, account: 'WALKIN', receipt: 'UJR9NBEDFC' }) });
  });
  await scan.fill('MILK500');
  await scan.press('Enter');
  await page.getByRole('button', { name: /^Pay / }).click();
  await page.getByRole('button', { name: 'M-Pesa', exact: true }).click();
  await expect(page.getByText('UJR9NBEDFC')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Enter M-Pesa code' }).click();
  await page.getByLabel('M-Pesa code').fill('ujr9nbedfc');
  await page.getByRole('button', { name: 'Find payment' }).click();
  const found = page.getByTestId('mpesa-found');
  await expect(found).toContainText('UJR9NBEDFC');
  await expect(found).toContainText('SIMULATED CUSTOMER');
  await expect(found).toContainText('100.00');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/pos-mpesa-code.png` });
  await found.getByRole('button', { name: 'Use this payment' }).click();
  await page.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByText(/Sale RCP-\d+ complete/)).toBeVisible();
  await page.getByRole('button', { name: 'New sale' }).click();

  await page.goto('/payments/mpesa');
  await expect(page.getByRole('cell', { name: /^RCP-/ })).toHaveCount(3);
});
