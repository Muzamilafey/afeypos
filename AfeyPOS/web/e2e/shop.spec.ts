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
  await expect(customer.getByRole('heading', { name: 'Groceries for a Brighter Tomorrow' })).toBeVisible();
  // The milk shows in several home page sections (featured, new arrivals...).
  await customer.getByRole('button', { name: 'Add Fresh milk 500ml' }).first().click();
  await customer.getByRole('button', { name: 'More Fresh milk 500ml' }).first().click();
  await expect(customer.getByTestId('cart-count')).toHaveText('2');
  await customer.screenshot({ path: 'test-results/shop-home.png', fullPage: true });
  await customer.getByRole('link', { name: 'Cart', exact: true }).click();
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

test('the owner redesigns the shop in Store studio with a live preview', async ({ page, browser }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Store studio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Store studio' })).toBeVisible();

  // Point the preview at the shop website.
  await page.getByRole('button', { name: 'Payments & address' }).click();
  await page.getByLabel('Shop web address').fill(SHOP);
  const preview = page.frameLocator('iframe[title="Shop preview"]');
  await expect(preview.getByRole('heading', { name: 'Groceries for a Brighter Tomorrow' })).toBeVisible();

  // Edits show in the preview before they are published.
  await page.getByRole('button', { name: 'Hero', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Fresh Food, Happy Homes');
  await expect(preview.getByRole('heading', { name: 'Fresh Food, Happy Homes' })).toBeVisible();
  await page.getByRole('button', { name: 'Brand & colours' }).click();
  await page.getByRole('button', { name: 'Ocean' }).click();
  await page.screenshot({ path: 'test-results/store-studio.png', fullPage: true });

  const customer = await (await browser.newContext()).newPage();
  await customer.goto(SHOP);
  await expect(customer.getByRole('heading', { name: 'Groceries for a Brighter Tomorrow' })).toBeVisible();

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Shop design published')).toBeVisible();
  await customer.reload();
  await expect(customer.getByRole('heading', { name: 'Fresh Food, Happy Homes' })).toBeVisible();
  expect(await customer.evaluate(() => document.documentElement.style.getPropertyValue('--c-primary'))).toBe('#16365c');

  // Information pages and the wishlist.
  await customer.getByRole('link', { name: 'About Us' }).click();
  await expect(customer.getByRole('heading', { name: 'About Us' })).toBeVisible();
  await customer.goto(`${SHOP}/shop`);
  await customer.getByRole('button', { name: 'Save Fresh milk 500ml to wishlist' }).click();
  await customer.getByRole('link', { name: 'Wishlist' }).click();
  await expect(customer.getByTestId('product-card')).toHaveCount(1);
  await customer.screenshot({ path: 'test-results/shop-wishlist.png', fullPage: true });
});
