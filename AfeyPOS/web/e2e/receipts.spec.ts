import { expect, test } from '@playwright/test';

// Runs after checkout.spec.ts (same server, owner amina@mandera.test).
test('the owner designs the receipt with a template, extra fields and a live preview', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('link', { name: 'Receipts', exact: true }).click();
  const preview = page.frameLocator('iframe[title="Receipt preview"]');
  await expect(preview.getByText('RCP-000123').first()).toBeVisible();

  await page.getByRole('radio', { name: /^Modern/ }).click();
  await page.getByLabel('Receipt title').fill('TAX INVOICE');
  await page.getByRole('button', { name: 'Add field' }).click();
  const field = page.getByRole('group', { name: 'Extra field 1' });
  await field.getByLabel('Label').fill('Paybill');
  await field.getByLabel('Value').fill('555444');
  await page.getByLabel('Promotion / message').fill('Double points every Friday!');
  await page.getByRole('checkbox', { name: '"Powered by Afey POS"' }).uncheck();
  await expect(preview.getByText('TAX INVOICE')).toBeVisible();
  await expect(preview.getByText('555444')).toBeVisible();
  await expect(preview.getByText('Powered by Afey POS')).toHaveCount(0);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/receipt-settings.png` });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Receipt settings saved/)).toBeVisible();

  // The real receipt of the latest sale uses the saved layout.
  await page.getByRole('button', { name: 'Latest real sale' }).click();
  await expect(preview.getByText(/RCP-0000/).first()).toBeVisible();
  await expect(preview.getByText('TAX INVOICE')).toBeVisible();
  for (const t of ['Classic', 'Bold', 'Elegant', 'Compact']) {
    await page.getByRole('radio', { name: new RegExp(`^${t}`) }).click();
    await page.waitForTimeout(400);
    if (process.env.SHOTS) await page.locator('iframe[title="Receipt preview"]').screenshot({ path: `${process.env.SHOTS}/receipt-${t.toLowerCase()}.png` });
  }
  await page.reload();
  await expect(page.getByRole('radio', { name: /^Modern/ })).toHaveAttribute('aria-checked', 'true');
});
