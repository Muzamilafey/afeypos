import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('set up a minimart, add a product and complete a cash sale', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByRole('button', { name: /Minimart/ }).click();
  await page.getByLabel('Business name').fill('Mandera Minimart');
  await page.getByLabel('Your name').fill('Amina Hassan');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password').fill('Mandera2026');
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByText('Your business is ready')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Data Panel Widget' })).toBeVisible();
  // Minimart navigation: checkout yes, quotations no.
  await expect(page.getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Quotations', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true });

  await page.getByRole('link', { name: 'Products', exact: true }).click();
  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Fresh milk 500ml');
  await page.getByLabel('SKU / code').fill('MILK500');
  await page.getByLabel('Selling price').fill('65');
  await page.getByLabel('Cost (per base unit)').fill('48');
  await page.getByLabel(/Quantity \(pc\)/).fill('24');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Product saved')).toBeVisible();
  await page.screenshot({ path: 'test-results/product.png', fullPage: true });

  await page.getByRole('link', { name: 'Checkout', exact: true }).click();
  // Start shift: count the float note by note.
  await page.getByLabel(/Number of .*1,000\.00 notes/).fill('1');
  await expect(page.getByTestId('cash-count-total')).toContainText('1,000.00');
  await page.getByRole('button', { name: /^Start shift/ }).click();
  const scan = page.getByLabel('Scan or search products');
  await scan.fill('MILK500');
  await scan.press('Enter');
  await scan.fill('MILK500');
  await scan.press('Enter');
  await expect(page.getByTestId('cart-total')).toHaveText(/130\.00/);
  await page.screenshot({ path: 'test-results/pos.png', fullPage: true });
  await page.getByRole('button', { name: /^Pay / }).click();
  await page.getByLabel('Cash received').fill('200');
  await expect(page.getByTestId('change-due')).toHaveText(/70\.00/);
  await page.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByText(/Sale RCP-\d+ complete/)).toBeVisible();
  await expect(page.getByText(/Change: .*70\.00/)).toBeVisible();
  await page.screenshot({ path: 'test-results/sale-complete.png' });
  await page.getByRole('button', { name: 'New sale' }).click();

  // Checkout is full screen: no sidebar; Go back leaves it.
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page).not.toHaveURL(/\/pos$/);
  await page.getByRole('link', { name: 'Sales history', exact: true }).click();
  await expect(page.getByText(/RCP-000001/)).toBeVisible();
  await page.getByRole('link', { name: 'Stock levels', exact: true }).click();
  await expect(page.getByText('22 pc')).toBeVisible();

  // Return one milk from the receipt by scanning its number.
  await page.getByRole('link', { name: 'Returns', exact: true }).click();
  await page.getByTestId('return-lookup').fill('RCP-000001');
  await page.getByTestId('return-lookup').press('Enter');
  await expect(page.getByRole('dialog').getByText('Return from RCP-000001')).toBeVisible();
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByTestId('return-total')).toHaveText(/65\.00/);
  await page.getByLabel('Reason').selectOption('damaged');
  const till = page.getByLabel('Till paying out');
  if (await till.inputValue() === '') await till.selectOption({ index: 1 });
  await page.screenshot({ path: 'test-results/return.png', fullPage: true });
  await page.getByRole('button', { name: 'Process return' }).click();
  await expect(page.getByText(/Return RTN-\d+ done: refund .*65\.00/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Damaged' })).toBeVisible();
  await page.getByRole('link', { name: 'Stock levels', exact: true }).click();
  await expect(page.getByText('23 pc')).toBeVisible();
});

test('rejects bad credentials with a clear message', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
});
