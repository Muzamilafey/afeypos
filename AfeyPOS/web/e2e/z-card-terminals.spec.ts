import { expect, test } from '@playwright/test';

// Runs last (same server): owner amina@mandera.test, cashier carol@mandera.test (no shift open), MILK500 costs 65.00.
// Uses the simulated terminal (test-only provider): a real bank terminal needs its provider's integration.
test('bank card terminal: self-service setup, then a verified card payment at the till', async ({ page, browser }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('link', { name: 'Bank card terminals', exact: true }).click();
  await page.getByRole('tab', { name: 'Supported providers' }).click();
  await expect(page.getByText('Equity Bank Kenya')).toBeVisible();
  await expect(page.getByText('Provider access required').first()).toBeVisible();

  // 1-2. Provider, terminal model and connection: Equity cannot be chosen; the simulator only offers its cloud connection.
  await page.getByRole('button', { name: 'Add a terminal' }).click();
  const wiz = page.getByRole('dialog');
  await expect(wiz.getByRole('radio', { name: /Equity Bank Kenya/ })).toBeDisabled();
  await wiz.getByRole('radio', { name: /Afey terminal simulator/ }).click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  await expect(wiz.getByRole('radio', { name: /LAN \/ Wi-Fi/ })).toBeDisabled();
  await wiz.getByLabel('Name', { exact: true }).fill('Till 1 card terminal');
  await wiz.getByRole('button', { name: 'Create and continue' }).click();

  // 3-5. Find the terminal, pair with the code on its screen, test the connection.
  await wiz.getByRole('button', { name: 'Find terminals' }).click();
  await wiz.getByRole('button', { name: 'Use this terminal' }).click();
  const screen = await wiz.getByLabel('Simulated terminal screen').innerText();
  const code = /(\d{6})/.exec(screen)![1];
  await wiz.getByLabel('Pairing code').fill(code === '111111' ? '222222' : '111111');
  await wiz.getByRole('button', { name: 'Pair' }).click();
  await expect(wiz.getByText(/rejected pairing/)).toBeVisible();
  await wiz.getByLabel('Pairing code').fill(code);
  await wiz.getByRole('button', { name: 'Pair' }).click();
  await wiz.getByRole('button', { name: 'Test the connection' }).click();

  // 6-8. Tills, a test payment, and enabling only once every check passed.
  await wiz.getByRole('checkbox').first().check({ force: true });
  await wiz.getByRole('button', { name: 'Save tills' }).click();
  await wiz.getByRole('button', { name: 'Run the test payment' }).click();
  await expect(wiz.getByTestId('setup-result')).toBeVisible({ timeout: 30_000 });
  await expect(wiz.getByTestId('setup-result').getByText('Not done')).toHaveCount(0);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/card-terminal-setup.png` });
  await wiz.getByRole('button', { name: 'Enable for payments' }).click();
  await expect(page.getByText('Till 1 card terminal is ready at the till')).toBeVisible();
  await wiz.getByRole('button', { name: 'Close' }).first().click();
  await page.getByRole('tab', { name: 'Terminals' }).click();
  await expect(page.getByTestId('terminal-Till 1 card terminal')).toContainText('Afey Simulated Terminal');

  // At the till: the amount goes to the terminal, the status follows it, and only the verified approval pays.
  const carol = await (await browser.newContext()).newPage();
  await carol.goto('/login');
  await carol.getByLabel('Email').fill('carol@mandera.test');
  await carol.getByLabel('Password', { exact: true }).fill('CarolTill2026!');
  await carol.getByRole('button', { name: 'Sign in' }).click();
  await expect(carol.getByRole('link', { name: 'Checkout', exact: true })).toBeVisible();
  await carol.goto('/pos');
  await carol.getByRole('button', { name: 'Enter the total instead' }).click();
  await carol.getByLabel('Opening float').fill('500');
  await carol.getByRole('button', { name: /^Start shift/ }).click();
  const scan = carol.getByLabel('Scan or search products');
  await scan.fill('MILK500');
  await scan.press('Enter');
  await expect(carol.getByTestId('cart-total')).toHaveText(/65\.00/);
  await carol.getByRole('button', { name: 'Card payment' }).click();
  const panel = carol.getByTestId('terminal-panel');
  await panel.getByRole('button', { name: /Charge .*65\.00 on the terminal/ }).click();
  await expect(panel.getByTestId('terminal-status')).toContainText(/Connecting to terminal|Ready for card|Enter PIN|Processing/);
  // Once it paid the whole sale the panel closes; the terminal's last answer stays on screen.
  await expect(carol.getByTestId('terminal-status')).toContainText('Payment approved — please remove your card', { timeout: 30_000 });
  await expect(carol.getByTestId('terminal-status')).toContainText('SIMULATED');
  await expect(carol.getByText(/Card Visa \*\*\*\*1111 \(simulated\)/)).toBeVisible();
  if (process.env.SHOTS) await carol.screenshot({ path: `${process.env.SHOTS}/card-terminal-checkout.png` });
  await carol.getByRole('button', { name: 'Complete sale' }).click();
  await expect(carol.getByText(/Sale RCP-\d+ complete/)).toBeVisible();

  // The dashboard shows the verified payment linked to its sale.
  await page.getByRole('tab', { name: 'Card payments' }).click();
  await expect(page.getByText(/RCP-\d+/).first()).toBeVisible();
  await expect(page.getByText('verified').first()).toBeVisible();
});
