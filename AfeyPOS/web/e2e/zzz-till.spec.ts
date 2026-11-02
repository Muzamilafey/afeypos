import { expect, test } from '@playwright/test';

// Runs after zz-scales (Juice 300ml, JUICE300: piece 50.00, carton of 24). Owner amina@mandera.test.
test('till: switch a line to cartons, the customer display follows, and the till locks when idle', async ({ page, context }) => {
  await page.clock.install();
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();

  // Lock after 1 minute without use.
  await page.goto('/settings/checkout-rules');
  await page.getByLabel('Lock the till after (minutes without use)').fill('1');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Checkout rules saved')).toBeVisible();

  await page.goto('/pos');
  const start = page.getByRole('button', { name: /^Start shift/ });
  if (await start.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Enter the total instead' }).click();
    await page.getByLabel('Opening float').fill('500');
    await start.click();
  }
  const scan = page.getByLabel('Scan or search products');
  await scan.fill('JUICE300');
  await scan.press('Enter');
  const unit = page.getByLabel('Unit of Juice 300ml');
  await expect(unit).toHaveValue('pc');
  await expect(page.getByTestId('cart-total')).toHaveText(/50\.00/);

  // The customer display on a second window of the same PC.
  const display = await context.newPage();
  await display.goto('/customer-display');
  await expect(display.getByTestId('display-total')).toHaveText(/50\.00/);

  await unit.selectOption('ctn');
  await expect(page.getByTestId('cart-total')).toHaveText(/1,200\.00/);
  await expect(display.getByTestId('display-total')).toHaveText(/1,200\.00/);
  await display.screenshot({ path: 'test-results/customer-display.png' });

  // Idle for over a minute: locked; only the cashier's own password opens it, and the sale is kept.
  await page.bringToFront();
  await page.clock.fastForward('01:10');
  const lock = page.getByTestId('till-lock');
  await expect(lock).toBeVisible();
  await lock.getByLabel('PIN, password or card').fill('wrong-password');
  await lock.getByLabel('PIN, password or card').press('Enter');
  await expect(lock.getByText('Wrong PIN or password')).toBeVisible();
  await page.screenshot({ path: 'test-results/till-lock.png' });
  await lock.getByLabel('PIN, password or card').fill('Mandera2026');
  await lock.getByLabel('PIN, password or card').press('Enter');
  await expect(lock).toHaveCount(0);
  await expect(page.getByTestId('cart-total')).toHaveText(/1,200\.00/);

  // Back to no lock for anything after this.
  await page.goto('/settings/checkout-rules');
  await page.getByLabel('Lock the till after (minutes without use)').fill('0');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Checkout rules saved')).toBeVisible();
});
