import { expect, test } from '@playwright/test';

// Runs after checkout.spec.ts (same server): "Fresh milk 500ml" exists.
test('asks two suppliers for quotes, orders from one and receives the goods', async ({ page, context }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Two suppliers.
  await page.getByRole('link', { name: 'Suppliers', exact: true }).click();
  for (const [name, email] of [['Brookside Dairy', 'orders@brookside.test'], ['Githunguri Dairy', 'sales@githunguri.test']]) {
    await page.getByRole('button', { name: 'New supplier' }).click();
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(name);
    await page.getByRole('dialog').getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('cell', { name: new RegExp(name) })).toBeVisible();
  }

  // Request quotations from both, emailed as PDF.
  await page.getByRole('link', { name: 'Supplier quotations', exact: true }).click();
  await page.getByRole('button', { name: 'Request quotation' }).click();
  const rfq = page.getByRole('dialog');
  await rfq.getByText('Brookside Dairy').click();
  await rfq.getByText('Githunguri Dairy').click();
  await rfq.getByLabel('Search or scan product').fill('Fresh milk');
  await rfq.getByRole('button', { name: /Fresh milk 500ml/ }).click();
  await rfq.getByLabel('Quantity of Fresh milk 500ml').fill('24');
  await rfq.getByRole('button', { name: 'Save and email' }).click();
  await expect(page.getByText('Request emailed to 2 supplier(s)')).toBeVisible();

  // Enter Brookside's price and order from them.
  await page.getByRole('cell', { name: /Brookside Dairy/ }).click();
  const quote = page.getByRole('dialog');
  await quote.getByLabel('Quoted price for Fresh milk 500ml').fill('52');
  await quote.getByLabel('Delivery (days)').fill('2');
  await quote.getByRole('button', { name: 'Save prices' }).click();
  await expect(page.getByText('Prices saved')).toBeVisible();
  await expect(quote.getByText('KES 1,248.00').or(quote.getByText('Ksh 1,248.00')).first()).toBeVisible();
  await quote.getByRole('button', { name: 'Compare suppliers' }).click();
  await expect(page.getByRole('dialog').getByText('Cheapest complete quote')).toBeVisible();
  await page.screenshot({ path: 'test-results/supplier-compare.png', fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: 'Brookside Dairy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Accept and order' }).click();
  await page.getByRole('button', { name: 'Create and email order' }).click();
  await expect(page.getByText('Purchase order created')).toBeVisible();

  // The new order opens; receive the delivery against it.
  await expect(page.getByRole('dialog').getByRole('heading', { name: /Purchase order PO-/ })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Outstanding')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Receive goods' }).click();
  const grn = page.getByRole('dialog');
  await grn.getByLabel('Supplier invoice no.').fill('BD-7781');
  await grn.getByLabel('Quantity of Fresh milk 500ml').fill('20');
  await grn.getByRole('button', { name: 'Post receipt' }).click();
  await expect(page.getByText(/Goods received \(GRN-/)).toBeVisible();
  await expect(page.getByRole('dialog').getByText('BD-7781')).toBeVisible();
  await page.screenshot({ path: 'test-results/goods-received.png', fullPage: true });

  // The goods received note as PDF, and by email.
  // (Headless Chromium has no PDF viewer, so check the PDF the button fetches.)
  const [pdf, tab] = await Promise.all([page.waitForResponse(/\/api\/v1\/pdf\/goods_receipt\//), context.waitForEvent('page'), page.getByRole('dialog').getByRole('button', { name: 'PDF' }).click()]);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect(Number(pdf.headers()['content-length'])).toBeGreaterThan(1000);
  await tab.close();
  await page.getByRole('dialog').getByRole('button', { name: 'Email' }).click();
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('orders@brookside.test');
  await page.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByText('Goods received note emailed to orders@brookside.test')).toBeVisible();

  // The order is partly received (20 of 24).
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Purchase orders', exact: true }).click();
  await expect(page.getByText('partially received').or(page.getByText('Partially received')).first()).toBeVisible();
});
