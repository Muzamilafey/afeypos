import fs from 'node:fs';
import { expect, test } from '@playwright/test';

// Runs after checkout.spec.ts (same server, owner amina@mandera.test, sale RCP-000001).
test('reports, invoices and quotations: PDF download and print on the letterhead', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'More reports', exact: true })).toBeVisible();
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await expect(page.locator('[data-stat]').first()).toBeVisible();

  // PDF: a real file, named after the report.
  const [download, pdf] = await Promise.all([
    page.waitForEvent('download'),
    page.waitForResponse((r) => r.url().includes('/render/report') && r.url().includes('format=pdf')),
    page.getByRole('button', { name: 'PDF', exact: true }).click(),
  ]);
  expect(pdf.status()).toBe(200);
  expect(download.suggestedFilename()).toBe('Daily-summary.pdf');
  const sent = pdf.request().postDataJSON();
  expect(sent.title).toBe('Daily summary');
  expect(sent.meta[0][0]).toBe('Period');
  expect(sent.sections.find((s: any) => s.kind === 'stats').items.map((i: any) => i.label)).toContain('Money collected');
  expect(sent.sections.find((s: any) => s.kind === 'table').columns.map((c: any) => c.label)).toEqual(expect.arrayContaining(['Day', 'Receipts', 'Collected']));

  // Print: the same report as a print page, in the browser's print dialog.
  const [html] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/render/report') && r.url().includes('format=html')),
    page.getByRole('button', { name: 'Print', exact: true }).click(),
  ]);
  expect(html.status()).toBe(200);
  const printed = await html.text();
  expect(printed).toContain('Daily summary');
  expect(printed).toContain('Mandera');
  if (process.env.SHOTS) fs.writeFileSync(`${process.env.SHOTS}/report-print.html`, printed);
  await expect(page.getByTestId('print-frame')).toHaveCount(1);

  // Another report tab, with tables on cards.
  await page.getByRole('tab', { name: 'Sales', exact: true }).click();
  const [salesPdf] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/render/report') && r.url().includes('format=pdf')),
    page.getByRole('button', { name: 'PDF', exact: true }).click(),
  ]);
  expect(salesPdf.request().postDataJSON().meta).toEqual(expect.arrayContaining([['Grouped by', 'day']]));

  // The invoice of a sale: PDF and Print (same layout).
  await page.getByRole('link', { name: 'Sales history', exact: true }).click();
  await page.getByText('RCP-000001').first().click();
  const [inv] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/print/invoice/')),
    page.getByRole('button', { name: 'Print invoice' }).click(),
  ]);
  expect(inv.status()).toBe(200);
  expect(await inv.text()).toContain('RCP-000001');
});

test('the Reports menu opens each report on its own page', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const menu = page.getByRole('navigation', { name: 'Main' });
  await expect(menu.getByRole('button', { name: 'Reports' })).toBeVisible();
  const reports = ['Sales Reports', 'Inventory Reports', 'Financial Reports', 'Customer Reports', 'Brand Report', 'Transaction Report', 'Profit Report', 'User Sales',
    'Branch Sales', 'Loss Report', 'Trending Products', 'Most Selling Products', 'Not Selling (3 Days)', 'Supplier Report', 'Drawer Calculations', 'HR Reports'];
  for (const name of reports) {
    await menu.getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'PDF', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  // A receipt of today's sales is on the transaction report, with who sold it.
  await menu.getByRole('link', { name: 'Transaction Report', exact: true }).click();
  await expect(page.getByRole('cell', { name: /^RCP-/ }).first()).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/reports-menu.png` });
});

