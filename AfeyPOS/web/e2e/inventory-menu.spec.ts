import { expect, test } from '@playwright/test';

// Runs after checkout.spec.ts (same server, owner amina@mandera.test, product MILK500 with barcode 6001234567892).
test('inventory menu: units, categories, brands, stock alerts and barcode verify', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  const menu = page.getByRole('navigation', { name: 'Main' });
  await expect(menu.getByRole('button', { name: 'Inventory' })).toBeVisible();
  for (const name of ['Products', 'Units', 'Stock levels', 'Categories', 'Brands', 'Stock alerts', 'Barcode labels', 'Barcode verify']) {
    await expect(menu.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/inventory-menu.png` });

  await menu.getByRole('link', { name: 'Units', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Kilogram' }).first()).toBeVisible();

  await menu.getByRole('link', { name: 'Categories', exact: true }).click();
  await page.getByRole('button', { name: 'Add category' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Frozen desserts');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: /Frozen desserts/ }).first()).toBeVisible();

  await menu.getByRole('link', { name: 'Brands', exact: true }).click();
  await page.getByRole('button', { name: 'Add brand' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Brookside');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Brookside' }).first()).toBeVisible();

  await menu.getByRole('link', { name: /^Stock alerts/ }).click();
  await expect(page.getByRole('heading', { name: 'Stock alerts' })).toBeVisible();
  await expect(page.getByText('Out of stock').first()).toBeVisible();

  await menu.getByRole('link', { name: 'Barcode verify', exact: true }).click();
  const box = page.getByLabel('Barcode to verify');
  await box.fill('MILK500');
  await box.press('Enter');
  await expect(page.getByTestId('barcode-result')).toContainText('Fresh milk 500ml');
  await box.fill('6001234567890');
  await box.press('Enter');
  await expect(page.getByTestId('barcode-result')).toContainText('Check digit wrong');

  // Groups fold away and come back.
  await menu.getByRole('button', { name: 'Customers & marketing' }).click();
  await expect(menu.getByRole('link', { name: 'Customers', exact: true })).toHaveCount(0);
  await menu.getByRole('button', { name: 'Customers & marketing' }).click();
  await expect(menu.getByRole('link', { name: 'Customers', exact: true })).toBeVisible();
});

test('inventory → receive stock: scan adds one, set the new total, save', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Receive stock', exact: true }).click();
  const scan = page.getByLabel('Scan barcode');
  await expect(scan).toBeEnabled();
  await scan.fill('MILK500');
  await scan.press('Enter');
  await expect(page.getByLabel('Received Fresh milk 500ml')).toHaveValue('1');
  await scan.fill('MILK500');
  await scan.press('Enter');
  await expect(page.getByLabel('Received Fresh milk 500ml')).toHaveValue('2');

  // Typing the counted total works out how many arrived.
  const total = page.getByLabel('New total Fresh milk 500ml');
  const before = Number(await total.inputValue()) - 2;
  await total.fill(String(before + 10));
  await expect(page.getByLabel('Received Fresh milk 500ml')).toHaveValue('10');
  await expect(page.getByTestId('receive-total')).toContainText('10 received');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/receive-stock.png` });

  await page.getByRole('button', { name: 'Save received stock' }).click();
  await expect(page.getByText(/Saved GRN-/)).toBeVisible();
  await expect(page.getByTestId('receive-lines')).toHaveCount(0);
});
