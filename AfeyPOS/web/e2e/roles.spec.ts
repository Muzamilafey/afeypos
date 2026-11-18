import { expect, test } from '@playwright/test';

// Runs after checkout.spec.ts (same server, owner amina@mandera.test).
test('the owner makes a custom role; its user only reaches what it allows', async ({ page, browser }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Copy the Cashier role, without customers and without cash in/out.
  await page.getByRole('link', { name: 'Roles & permissions', exact: true }).click();
  await page.getByRole('button', { name: /^Cashier/ }).click();
  await expect(page.getByRole('heading', { name: 'Cashier' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy as new role' }).click();
  await page.getByLabel('Role name').fill('Till only');
  await page.getByLabel('See customers', { exact: true }).uncheck();
  await page.getByLabel('Cash in / cash out (drawer)').uncheck();
  await page.getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByText('Role “Till only” saved')).toBeVisible();
  await page.screenshot({ path: 'test-results/roles.png', fullPage: true });

  // A user with that role, with online orders taken away for them only.
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await page.getByRole('button', { name: 'Add user' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Tina Till');
  await dialog.getByLabel('Email').fill('tina@mandera.test');
  await dialog.getByLabel('Password').fill('TinaTill2026!');
  await dialog.getByText('Cashier', { exact: true }).click(); // untick the default role
  await dialog.getByText('Till only (custom)').click();
  await dialog.getByRole('button', { name: /Adjust permissions for this user/ }).click();
  await dialog.getByLabel('Handle online orders for this user').selectOption('deny');
  await expect(dialog.getByText(/1 taken away/).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/user-permissions.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('User saved')).toBeVisible();

  // Tina sees the till but not customers, online orders or settings.
  const tina = await (await browser.newContext()).newPage();
  await tina.goto('/login');
  await tina.getByLabel('Email').fill('tina@mandera.test');
  await tina.getByLabel('Password', { exact: true }).fill('TinaTill2026!');
  await tina.getByRole('button', { name: 'Sign in' }).click();
  await expect(tina.getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();
  await expect(tina.getByRole('link', { name: 'Customers', exact: true })).toHaveCount(0);
  await expect(tina.getByRole('link', { name: 'Online orders', exact: true })).toHaveCount(0);
  await expect(tina.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
  await tina.goto('/customers');
  await expect(tina.getByText('Not available')).toBeVisible();
  // Products are listed without cost prices.
  await tina.goto('/products');
  await expect(tina.getByRole('columnheader', { name: 'Cost' })).toHaveCount(0);
});
