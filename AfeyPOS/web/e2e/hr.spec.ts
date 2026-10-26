import { expect, test } from '@playwright/test';

// Runs after checkout.spec.ts (same server).
test('adds an employee and runs a payroll with Kenyan deductions', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Data Panel Widget' })).toBeVisible();

  await page.getByRole('link', { name: 'Employees', exact: true }).click();
  await page.getByRole('button', { name: 'Add employee' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Full name').fill('Wanjiru Kamau');
  await d.getByLabel('KRA PIN').fill('A987654321Z');
  await d.getByLabel('Basic salary per month').fill('50000');
  await d.getByLabel('M-Pesa number').fill('0722000111');
  await d.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Wanjiru Kamau' })).toBeVisible();

  await page.getByRole('link', { name: 'Payroll', exact: true }).click();
  await page.getByRole('button', { name: 'Run payroll' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByRole('heading', { name: /^Payroll \d{4}-\d{2}$/ })).toBeVisible();
  const row = page.getByRole('row', { name: /Wanjiru Kamau/ });
  // KES 50,000: NSSF 3,000 · SHIF 1,375 · levy 750 · PAYE 5,845.85 · net 39,029.15
  await expect(row).toContainText('3,000.00');
  await expect(row).toContainText('1,375.00');
  await expect(row).toContainText('5,845.85');
  await expect(row).toContainText('39,029.15');
  await page.screenshot({ path: 'test-results/payroll.png', fullPage: true });
});
