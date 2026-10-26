import { expect, test } from '@playwright/test';

// Runs after checkout.spec.ts (same server): "Fresh milk 500ml" exists with stock.
// The shop website is served by the same server for the hostname shop.lan.test (SHOP_HOSTNAMES).
const port = Number(process.env.E2E_PORT ?? 4100);
const SHOP = `http://shop.lan.test:${port}`;

test('a customer orders on the shop website and staff deliver it as a sale', async ({ page, browser }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Data Panel Widget' })).toBeVisible();

  // Open the shop with one delivery area.
  await page.goto('/settings/online-shop');
  await page.getByText('The online shop is open').click();
  await page.getByRole('button', { name: 'Add area' }).click();
  await page.getByPlaceholder('Area (e.g. Kilimani)').fill('Kilimani');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Online shop saved')).toBeVisible();
  // List the milk online.
  await page.getByRole('link', { name: 'Products', exact: true }).click();
  await page.getByRole('cell', { name: /Fresh milk 500ml/ }).click();
  await page.getByText('Sell on the online shop').click();
  await page.getByText('Feature on the home page').click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Product saved')).toBeVisible();

  // The customer, on the separate shop website.
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(SHOP);
  await expect(customer.getByRole('heading', { name: 'Your groceries, delivered' })).toBeVisible();
  await customer.getByRole('button', { name: 'Add Fresh milk 500ml' }).click();
  await customer.getByRole('button', { name: 'More Fresh milk 500ml' }).click();
  await expect(customer.getByTestId('cart-count')).toHaveText('2');
  await customer.screenshot({ path: 'test-results/shop-home.png', fullPage: true });
  await customer.getByRole('link', { name: 'Basket' }).click();
  await expect(customer.getByTestId('cart-subtotal')).toHaveText(/130\.00/);
  await customer.getByRole('link', { name: 'Checkout' }).click();
  await customer.getByLabel('Delivery address').fill('Lenana Rd, House 12');
  await customer.getByLabel('Name', { exact: true }).fill('Achieng Odhiambo');
  await customer.getByLabel('Phone', { exact: true }).fill('0711222333');
  await customer.getByRole('radio', { name: 'Pay on delivery' }).click();
  await expect(customer.getByTestId('checkout-total')).toHaveText(/130\.00/);
  await customer.screenshot({ path: 'test-results/shop-checkout.png', fullPage: true });
  await customer.getByRole('button', { name: 'Place order' }).click();
  await expect(customer.getByTestId('order-status')).toHaveText('Received');
  const number = (await customer.getByTestId('order-number').textContent())!;
  expect(number).toMatch(/^WEB-/);

  // Staff: accept, dispatch and complete with cash collected by the rider.
  await page.getByRole('link', { name: 'Online orders', exact: true }).click();
  await page.getByRole('cell', { name: new RegExp(number) }).click();
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('button', { name: 'Out for delivery' }).click();
  await expect(page.getByRole('dialog').getByText(/Out for delivery/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Complete', exact: true }).click();
  const till = page.getByRole('dialog').getByLabel('Till');
  if (await till.inputValue() === '') await till.selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Complete sale' }).click();
  await expect(page.getByText(/Completed: sale RCP-/)).toBeVisible();

  await customer.reload();
  await expect(customer.getByTestId('order-status')).toHaveText('Done');
});
