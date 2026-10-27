import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { expect, test } from '@playwright/test';

// 1x1 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

// Runs after checkout.spec.ts (owner amina@mandera.test; product MILK500 exists).
test('products import: Excel template, photos, review every product, then import', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();
  await page.goto('/products');
  await page.getByRole('button', { name: 'Import products' }).click();

  // The template is a formatted workbook with headings, dropdowns and instructions.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download template/ }).click()]);
  expect(dl.suggestedFilename()).toBe('Afey-POS-product-import.xlsx');
  const file = path.join(os.tmpdir(), `afey-import-${Date.now()}.xlsx`);
  await dl.saveAs(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('Products')!;
  expect(wb.getWorksheet('How to fill')).toBeTruthy();
  const head = (ws.getRow(3).values as any[]).filter(Boolean).map(String);
  expect(head).toEqual(expect.arrayContaining(['Photo', 'Product name *', 'SKU / item code *', 'Selling price *']));
  expect(ws.getCell('G4').dataValidation?.type).toBe('list');

  // Fill it like a user: two new products (one with a photo in its row), one update, one mistake.
  const col = (h: string) => head.findIndex((x) => x.replace(' *', '') === h) + 1;
  const put = (r: number, v: Record<string, string | number>) => Object.entries(v).forEach(([h, x]) => (ws.getRow(r).getCell(col(h)).value = x));
  put(4, { 'Product name': 'Kabras Sugar 2kg', 'SKU / item code': 'SUG2KG', Barcode: '6161101560012', Category: 'Groceries', Unit: 'pc', 'Selling price': 260, 'VAT %': 16 });
  put(5, { 'Product name': 'Fresh milk 500ml', 'SKU / item code': 'MILK500', 'Selling price': 65 });
  put(6, { 'Product name': 'Royco Mchuzi Mix 75g', 'SKU / item code': 'ROYCO75', 'Selling price': 'cheap' });
  put(7, { 'Product name': 'Ketepa Pride 100g', 'SKU / item code': 'KETEPA100', Unit: 'pc', 'Selling price': 145 });
  const img = wb.addImage({ buffer: PNG as any, extension: 'png' });
  ws.addImage(img, { tl: { col: 0.1, row: 3.1 }, ext: { width: 40, height: 40 } } as any);
  await wb.xlsx.writeFile(file);

  await page.getByLabel('Product file').setInputFiles(file);
  const review = page.getByTestId('import-review');
  await expect(review).toBeVisible();
  await expect(page.getByTestId('import-row-4')).toContainText('New');
  await expect(page.getByTestId('import-row-4').locator('img')).toHaveCount(1);
  await expect(page.getByTestId('import-row-5')).toContainText('Update');
  await expect(page.getByTestId('import-row-6')).toContainText('Not a number');
  await expect(page.getByRole('button', { name: /^Import 4 products/ })).toBeDisabled();

  // Photos named by SKU are matched to their rows.
  await page.getByLabel('Product photos').setInputFiles({ name: 'KETEPA100.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByTestId('import-row-7').locator('img')).toHaveCount(1);

  // Fix the mistake here, check again, import.
  await page.getByLabel('Selling price row 6').fill('45');
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByTestId('import-row-6')).toContainText('New');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/import-review.png`, fullPage: true });
  await page.getByRole('button', { name: /^Import 4 products/ }).click();
  await expect(page.getByTestId('import-done')).toContainText('3 added, 1 updated, 2 photos');
  fs.rmSync(file, { force: true });

  await page.getByRole('button', { name: 'See products' }).click();
  await page.getByPlaceholder(/Search/).first().fill('Kabras');
  await expect(page.getByText('Kabras Sugar 2kg')).toBeVisible();
});
