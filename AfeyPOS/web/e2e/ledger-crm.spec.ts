import { expect, test } from '@playwright/test';

// Runs after checkout.spec.ts (same server): there are sales, products and opening stock.
test('keeps the books automatically and shows the CRM', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Data Panel Widget' })).toBeVisible();

  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await expect(page.getByText('Net sales')).toBeVisible();
  await expect(page.getByRole('link', { name: /4000 Sales/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Balance sheet' }).click();
  await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Trial balance' }).click();
  await expect(page.getByText('Totals (balanced)')).toBeVisible();
  await page.screenshot({ path: 'test-results/trial-balance.png', fullPage: true });
  await page.getByRole('link', { name: /1200 Inventory/ }).click();
  await expect(page.getByRole('heading', { name: '1200 Inventory' })).toBeVisible();

  await page.getByRole('link', { name: 'CRM & campaigns', exact: true }).click();
  await expect(page.getByText('Agreed to offers')).toBeVisible();
  await page.getByRole('tab', { name: 'Campaigns' }).click();
  await page.getByRole('button', { name: 'New campaign' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Weekend offer');
  await page.getByRole('dialog').getByLabel(/^Message/).fill('Hi {{name}}, milk is 2 for 120 this weekend.');
  await page.getByRole('button', { name: 'Who receives it?' }).click();
  await expect(page.getByTestId('campaign-preview')).toContainText('customers who agreed to offers');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('cell', { name: /Weekend offer/ })).toBeVisible();
});

test('communications: send an SMS to customers from a ready template', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Data Panel Widget' })).toBeVisible();
  // Turn on a console SMS provider via the API so the page is in its full state.
  await page.evaluate(async () => {
    const { accessToken } = await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).json();
    const h = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const list = await (await fetch('/api/v1/settings/integrations', { headers: h })).json();
    if (!list.data.some((i: any) => i.kind === 'sms')) await fetch('/api/v1/settings/integrations', { method: 'POST', headers: h, body: JSON.stringify({ kind: 'sms', provider: 'console', name: 'Dev SMS' }) });
  });
  await page.goto('/communications');
  await expect(page.getByRole('heading', { name: 'Communications' })).toBeVisible();
  await page.getByLabel('Send to').selectOption('customers');
  await page.getByLabel('Ready template').selectOption('promo');
  await expect(page.getByPlaceholder(/Write your message/)).not.toHaveValue('');
  await expect(page.getByTestId('comm-reach')).toBeVisible();
  // Switch audience to suppliers: the template list changes to supplier ones.
  await page.getByLabel('Send to').selectOption('suppliers');
  await expect(page.getByLabel('Ready template')).toContainText('Supplier');
  await page.screenshot({ path: 'test-results/communications.png', fullPage: true });
});
