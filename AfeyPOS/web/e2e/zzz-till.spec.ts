import { expect, test } from '@playwright/test';

// Runs after zz-scales (Juice 300ml, JUICE300: piece 50.00, carton of 24). Owner amina@mandera.test.
test('till: switch a line to cartons, the customer display follows, and the till locks when idle', async ({ page, context }) => {
  await page.clock.install();
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();

  // Lock after 1 minute without use.
  await page.goto('/settings/checkout-rules');
  await page.getByLabel('Lock the till after (minutes without use)').fill('1');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Checkout rules saved')).toBeVisible();

  await page.goto('/pos');
  const start = page.getByRole('button', { name: /^Start shift/ });
  if (await start.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Enter the total instead' }).click();
    await page.getByLabel('Opening float').fill('500');
    await start.click();
  }
  const scan = page.getByLabel('Scan or search products');
  await scan.fill('JUICE300');
  await scan.press('Enter');
  const unit = page.getByLabel('Unit of Juice 300ml');
  await expect(unit).toHaveValue('pc');
  await expect(page.getByTestId('cart-total')).toHaveText(/50\.00/);

  // The customer display on a second window of the same PC.
  const display = await context.newPage();
  await display.goto('/customer-display');
  await expect(display.getByTestId('display-total')).toHaveText(/50\.00/);

  await unit.selectOption('ctn');
  await expect(page.getByTestId('cart-total')).toHaveText(/1,200\.00/);
  await expect(display.getByTestId('display-total')).toHaveText(/1,200\.00/);
  await display.screenshot({ path: 'test-results/customer-display.png' });

  // Idle for over a minute: locked; only the cashier's own password opens it, and the sale is kept.
  await page.bringToFront();
  await page.clock.fastForward('01:10');
  const lock = page.getByTestId('till-lock');
  await expect(lock).toBeVisible();
  await lock.getByLabel('PIN, password or card').fill('wrong-password');
  await lock.getByLabel('PIN, password or card').press('Enter');
  await expect(lock.getByText('Wrong PIN or password')).toBeVisible();
  await page.screenshot({ path: 'test-results/till-lock.png' });
  await lock.getByLabel('PIN, password or card').fill('Mandera2026');
  await lock.getByLabel('PIN, password or card').press('Enter');
  await expect(lock).toHaveCount(0);
  await expect(page.getByTestId('cart-total')).toHaveText(/1,200\.00/);

  // Back to no lock for anything after this.
  await page.goto('/settings/checkout-rules');
  await page.getByLabel('Lock the till after (minutes without use)').fill('0');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Checkout rules saved')).toBeVisible();
});

test('device compatibility: honest statuses, guided set-up and a real scan test', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Device compatibility', exact: true }).click();
  await page.getByRole('tab', { name: 'Compatibility list' }).click();
  const list = page.getByTestId('compat-list');
  await expect(list).toContainText('Voyager 1250g');
  await expect(list.getByRole('button', { name: /Voyager 1250g/ })).toContainText('Not yet verified');

  await page.getByRole('tab', { name: 'Add a device' }).click();
  await page.getByLabel('Device type').selectOption('barcode_scanner');
  await page.getByLabel('Model').selectOption('honeywell-1250g');
  await page.getByLabel('Connection').selectOption('keyboard_wedge');
  await page.getByRole('button', { name: 'Save and test' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Scan here').fill('5901234123457');
  await dlg.getByLabel('Scan here').press('Enter');
  await expect(dlg.getByTestId('test-outcome')).toContainText('Scanned 5901234123457');
  await dlg.getByRole('button', { name: 'Close' }).first().click();
  const health = page.getByTestId('hardware-health');
  await expect(health).toContainText('Honeywell');
  await expect(health.getByRole('row', { name: /Honeywell/ })).toContainText('Working');
  await page.screenshot({ path: 'test-results/device-compatibility.png', fullPage: true });
});

test('AI business assistant answers from the business data (built-in answers, no AI provider)', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'AI Assistant', exact: true }).click();
  await expect(page.getByText('Built-in answers (no AI set up)')).toBeVisible();
  await page.getByRole('button', { name: 'Which products are almost out of stock?' }).click();
  const chat = page.getByTestId('assistant-chat');
  await expect(chat).toContainText(/reorder level|No product is at or below/);
  await page.getByLabel('Ask a question').fill('What is my current inventory value?');
  await page.getByLabel('Ask a question').press('Enter');
  await expect(chat).toContainText('at cost');
  await expect(page.getByText('AI provider (owners and administrators)')).toBeVisible();
  await page.screenshot({ path: 'test-results/assistant.png', fullPage: true });
});

test('drop cash: amount, supervisor approval, recorded and taken off the drawer', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();
  await page.goto('/pos');
  await expect(page.getByLabel('Scan or search products')).toBeVisible();
  await page.getByRole('button', { name: /more/i }).first().click();
  await page.getByRole('button', { name: /Drop cash/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Drop cash' });
  await dlg.getByLabel('Amount to drop').fill('100');
  await dlg.getByRole('button', { name: 'Continue' }).click();
  const appr = page.getByRole('dialog', { name: 'Approve cash drop' });
  await appr.getByRole('radio', { name: 'Username / email' }).click();
  await appr.getByLabel('Username or email').fill('amina@mandera.test');
  await appr.getByLabel('PIN or password').fill('Mandera2026');
  await appr.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByTestId('drop-done')).toContainText(/Cash drop DRP-/);
  await page.screenshot({ path: 'test-results/cash-drop.png' });
  await page.getByRole('button', { name: 'Done' }).click();
});

test('the top bar has a Back button to the previous page', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Products', exact: true }).click();
  await page.getByRole('link', { name: 'Stock levels', exact: true }).click();
  await expect(page).toHaveURL(/\/inventory$/);
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page).toHaveURL(/\/products$/);
});

test('tax & fiscal devices: devices, transactions, reports and device finder', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();
  await page.goto('/settings/fiscal');
  await expect(page.getByRole('heading', { name: 'Tax & fiscal devices' })).toBeVisible();
  await expect(page.getByText(/No fiscal device is set up yet|Test connection/).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Fiscal transactions' }).click();
  await expect(page.getByLabel('Fiscal status')).toBeVisible();
  await page.getByLabel('Fiscal status').selectOption('attention');
  await page.getByRole('tab', { name: 'Reports' }).click();
  await expect(page.getByTestId('fiscal-report')).toContainText('Fiscalized sales');
  await expect(page.getByTestId('fiscal-report')).toContainText('VAT on fiscalized sales');
  await page.screenshot({ path: 'test-results/fiscal-report.png' });
  await page.getByRole('tab', { name: 'Find a device' }).click();
  await expect(page.getByText('Nothing is sent to any device')).toBeVisible();
});

test('owner dashboard: accounting graphs, and every card has View all', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Data Panel Widget' })).toBeVisible();
  const books = page.getByTestId('accounting-dashboard');
  await expect(books).toContainText('Revenue, costs and net profit (12 months)');
  await expect(books).toContainText('Where the money is');
  await expect(books).toContainText('VAT to pay KRA');
  expect(await page.getByRole('link', { name: 'View all' }).count()).toBeGreaterThan(10);
  await page.screenshot({ path: 'test-results/owner-dashboard.png', fullPage: true });
  await books.getByRole('link', { name: 'Balance sheet' }).click();
  await expect(page).toHaveURL(/\/accounting\?tab=bs$/);
  await expect(page.getByRole('tab', { name: 'Balance sheet' })).toHaveAttribute('aria-selected', 'true');
});
