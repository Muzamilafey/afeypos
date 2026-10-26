import { expect, test } from '@playwright/test';

// Runs after till-rules.spec.ts (same server): Carol the cashier has a shift open on the till; MILK500 costs 65.00.
test('gift vouchers and the loyalty program, from the back office to the till', async ({ page, browser }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Data Panel Widget' })).toBeVisible();
  // Loyalty needs its module; a member to give a card to.
  const { cardCustomer } = await page.evaluate(async () => {
    const { accessToken } = await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).json();
    const h = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    await fetch('/api/v1/settings/modules', { method: 'PUT', headers: h, body: JSON.stringify({ enabled: ['loyalty'] }) });
    const c = await (await fetch('/api/v1/customers', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Halima Noor', phone: '0722333444' }) })).json();
    return { cardCustomer: c.data };
  });
  await page.reload();

  // Gift voucher: a KES 100 promotion voucher.
  await page.getByRole('link', { name: 'Vouchers', exact: true }).click();
  await page.getByRole('button', { name: 'Issue vouchers' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Value of each voucher').fill('100');
  await dialog.getByLabel('Type').selectOption('promo');
  const popup = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: /^Issue voucher/ }).click();
  await (await popup).close();
  const code = (await page.locator('td span.font-mono').first().innerText()).trim();
  expect(code).toMatch(/^GV-/);

  // Loyalty: welcome bonus, then a card for Halima.
  await page.getByRole('link', { name: 'Loyalty program', exact: true }).click();
  await page.getByRole('tab', { name: 'Program rules' }).click();
  await page.getByLabel('Welcome bonus (points)').fill('100');
  await page.getByRole('button', { name: 'Save program' }).click();
  await expect(page.getByText('Loyalty program saved')).toBeVisible();
  await page.getByRole('tab', { name: 'Members' }).click();
  await page.getByLabel(/Show all customers/).check();
  await page.getByPlaceholder('Search name, phone or card').fill('Halima');
  await page.getByRole('button', { name: 'Give card' }).click();
  await expect(page.getByText(/100 pts/)).toBeVisible();
  const cardNo = (await page.getByText(/^Card LC\d{10}$/).innerText()).replace('Card ', '');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/loyalty-member.png` });
  expect(cardCustomer.name).toBe('Halima Noor');

  // At the till: pay with the voucher (65 of 100), then with points from the loyalty card.
  const carol = await (await browser.newContext()).newPage();
  await carol.goto('/login');
  await carol.getByLabel('Email').fill('carol@mandera.test');
  await carol.getByLabel('Password', { exact: true }).fill('CarolTill2026!');
  await carol.getByRole('button', { name: 'Sign in' }).click();
  await carol.getByRole('link', { name: 'Checkout', exact: true }).click();
  const scan = carol.getByLabel('Scan or search products');
  await scan.fill('MILK500');
  await scan.press('Enter');
  await expect(carol.getByTestId('cart-total')).toHaveText(/65\.00/);
  await carol.getByRole('button', { name: 'Voucher' }).click();
  await carol.getByLabel('Voucher code').fill(code);
  await carol.getByRole('button', { name: 'Check voucher' }).click();
  await expect(carol.getByTestId('voucher-info')).toContainText('100.00');
  await carol.getByRole('button', { name: 'Pay with this voucher' }).click();
  await expect(carol.getByTestId('voucher-balance')).toContainText('35.00');
  await carol.getByRole('button', { name: 'Add gift voucher payment' }).click();
  await carol.getByRole('button', { name: 'Complete sale' }).click();
  await expect(carol.getByText(/Sale RCP-\d+ complete/)).toBeVisible();
  await carol.getByRole('button', { name: 'New sale' }).click();

  await scan.fill('MILK500');
  await scan.press('Enter');
  await carol.getByRole('button', { name: 'Loyalty card' }).click();
  await carol.getByLabel('Card code or phone').fill(cardNo);
  await carol.getByRole('button', { name: 'Find customer' }).click();
  await expect(carol.getByRole('button', { name: /Loyalty points|Points \(100\)/ }).first()).toBeVisible();
  if (process.env.SHOTS) await carol.screenshot({ path: `${process.env.SHOTS}/pos-points.png` });
  await carol.getByRole('button', { name: 'Add loyalty points payment' }).click();
  await carol.getByRole('button', { name: 'Complete sale' }).click();
  await expect(carol.getByText(/Sale RCP-\d+ complete/)).toBeVisible();

  // Keyboard only: scan, Enter opens cash payment, type the cash, Enter completes, Enter starts the next sale.
  await carol.getByRole('button', { name: 'New sale' }).click();
  await scan.fill('MILK500');
  await scan.press('Enter');
  await expect(carol.getByTestId('cart-total')).toHaveText(/65\.00/);
  await carol.keyboard.press('+');
  await expect(carol.getByTestId('cart-total')).toHaveText(/130\.00/);
  await scan.press('Enter');
  const cash = carol.getByLabel('Cash received');
  await expect(cash).toBeFocused();
  await cash.fill('200');
  if (process.env.SHOTS) await carol.screenshot({ path: `${process.env.SHOTS}/pos-pay-drawer.png` });
  await cash.press('Enter');
  await expect(carol.getByText(/Sale RCP-\d+ complete/)).toBeVisible();
  await expect(carol.getByText(/Change: .*70\.00/)).toBeVisible();
  await carol.keyboard.press('Enter');
  await expect(carol.getByText(/Sale RCP-\d+ complete/)).toHaveCount(0);
  await expect(scan).toBeFocused();

  // The voucher kept its 35.00.
  await page.goto('/vouchers');
  await expect(page.getByRole('row', { name: new RegExp(code) })).toContainText('35.00');
});
