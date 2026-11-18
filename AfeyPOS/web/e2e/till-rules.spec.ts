import { expect, test } from '@playwright/test';

// Runs after checkout.spec.ts (same server, owner amina@mandera.test, product MILK500, a shift open on the till).
test('checkout rules: a cashier needs a supervisor to delete an item; payment tiles and More', async ({ page, browser }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('link', { name: 'Checkout rules', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Removing an item needs a supervisor' }).check({ force: true });
  await page.getByRole('checkbox', { name: 'Returns' }).uncheck();
  await page.getByRole('button', { name: 'Add card machine' }).click();
  await page.getByRole('group', { name: 'Card machine 1' }).getByLabel('Name', { exact: true }).fill('Till 1 Equity PDQ');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/checkout-rules.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText(/Checkout rules saved/)).toBeVisible();

  // A cashier and a supervisor with a staff card (scanning it approves; no PIN).
  const samCard = await page.evaluate(async () => {
    const { accessToken } = await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).json();
    const h = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    await fetch('/api/v1/settings/users', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Carol Cashier', email: 'carol@mandera.test', password: 'CarolTill2026!', roles: ['cashier'] }) });
    // The owner's shift on this till ends; Carol opens her own.
    const open = await (await fetch('/api/v1/shifts?status=open', { headers: h })).json();
    for (const sh of open.data) await fetch(`/api/v1/shifts/${sh._id}/close`, { method: 'POST', headers: h, body: JSON.stringify({ countedCashCents: 0 }) });
    const sam = await (await fetch('/api/v1/settings/users', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Sam Supervisor', email: 'sam@mandera.test', password: 'SamSuper2026!', roles: ['branch_manager'], pin: '4321' }) })).json();
    const card = await (await fetch(`/api/v1/settings/users/${sam.data._id}/card`, { method: 'POST', headers: h })).json();
    return card.data.code as string;
  });

  const carol = await (await browser.newContext()).newPage();
  await carol.goto('/login');
  await carol.getByLabel('Email').fill('carol@mandera.test');
  await carol.getByLabel('Password', { exact: true }).fill('CarolTill2026!');
  await carol.getByRole('button', { name: 'Sign in' }).click();
  await expect(carol.getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();
  await expect(carol.getByRole('link', { name: 'Returns', exact: true })).toHaveCount(0);
  await carol.goto('/returns');
  await expect(carol).toHaveURL(/\/pos$/);
  await carol.getByRole('button', { name: 'Enter the total instead' }).click();
  await carol.getByLabel('Opening float').fill('500');
  await carol.getByRole('button', { name: /^Start shift/ }).click();

  const scan = carol.getByLabel('Scan or search products');
  await scan.fill('MILK500');
  await scan.press('Enter');
  await expect(carol.getByTestId('cart-total')).toHaveText(/65\.00/);
  await expect(carol.getByRole('button', { name: 'M-Pesa payment' })).toBeVisible();
  await expect(carol.getByRole('button', { name: 'Cash payment' })).toBeVisible();
  await expect(carol.getByRole('button', { name: 'Card payment' })).toBeVisible();
  if (process.env.SHOTS) await carol.screenshot({ path: `${process.env.SHOTS}/pos-tiles.png` });

  await carol.getByRole('button', { name: /^More/ }).click();
  if (process.env.SHOTS) await carol.screenshot({ path: `${process.env.SHOTS}/pos-more.png` });
  await carol.getByRole('button', { name: 'Delete item' }).click();
  await expect(carol.getByText(/Removing .* needs a supervisor/)).toBeVisible();
  await expect(carol.getByRole('radio', { name: 'Email' })).toHaveCount(0);
  await expect(carol.getByLabel('PIN')).toHaveCount(0);
  // A scanner types the code and Enter: that alone approves.
  await carol.getByLabel('Supervisor card').pressSequentially(samCard, { delay: 5 });
  await carol.getByLabel('Supervisor card').press('Enter');
  await expect(carol.getByText('Approved and recorded')).toBeVisible();
  await expect(carol.getByTestId('cart-total')).toHaveText(/0\.00/);

  // Card payment from a bank card machine needs the slip's approval code.
  await scan.fill('MILK500');
  await scan.press('Enter');
  await carol.getByRole('button', { name: 'Card payment' }).click();
  await carol.getByLabel('Approval code').fill('A1B2C3');
  await carol.getByRole('button', { name: 'Add card payment' }).click();
  await expect(carol.getByText('Card Visa')).toBeVisible();
  await carol.getByRole('button', { name: 'Complete sale' }).click();
  await expect(carol.getByText(/Sale RCP-\d+ complete/)).toBeVisible();

  // The removal is in the audit trail with the supervisor.
  await page.goto('/audit');
  await expect(page.getByText('pos.item_removed').first()).toBeVisible();
});
