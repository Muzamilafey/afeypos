import { expect, test } from '@playwright/test';

// Runs after the other specs on the same server (owner amina@mandera.test). Uses the keyboard-output adapter
// (typed weight) and the simulator label scale: no physical scale is attached in CI.
test('weighing scales: register, verify with a test weight, send prices, weigh at the till', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('amina@mandera.test');
  await page.getByLabel('Password', { exact: true }).fill('Mandera2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Weighing scales', exact: true }).click();
  await expect(page.getByText('What works with what')).toBeVisible();

  // A counter scale that types the weight: it only counts as verified after a correct test reading.
  await page.getByRole('button', { name: 'Add scale' }).click();
  let dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Counter scale');
  await dlg.getByLabel('Connection').selectOption('keyboard');
  for (const box of await dlg.getByRole('checkbox').all()) await box.check({ force: true });
  await dlg.getByRole('button', { name: 'Save and test' }).click();
  dlg = page.getByRole('dialog');
  await dlg.getByLabel('Test weight (kg)').fill('1');
  await dlg.getByLabel('Weight from the scale').fill('1.300');
  await dlg.getByRole('button', { name: 'Check reading' }).click();
  await expect(dlg.getByText(/1.300 kg but the test weight is 1.000/)).toBeVisible();
  await dlg.getByLabel('Weight from the scale').fill('1.004');
  await dlg.getByRole('button', { name: 'Check reading' }).click();
  await expect(page.getByTestId('scale-row').filter({ hasText: 'Counter scale' })).toContainText('verified');

  // A simulated label scale: prices go out as a versioned send the (simulated) scale confirms.
  await page.getByRole('button', { name: 'Add scale' }).click();
  dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill('Deli label scale');
  await dlg.getByLabel('Brand').selectOption('simulator');
  await dlg.getByLabel('What it does').selectOption('label');
  await dlg.getByRole('button', { name: 'Save and test' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Check reading' }).click();
  const deli = page.getByTestId('scale-row').filter({ hasText: 'Deli label scale' });
  await expect(deli).toContainText('simulated');

  // A weighed product made with the wizard, with the next free PLU.
  await page.goto('/products/new');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Beef steak');
  await next();
  await page.getByRole('button', { name: /By weight/ }).click();
  await next();
  await next();
  await page.getByLabel('Selling price').fill('800');
  await next();
  await page.getByLabel('SKU / code').fill('BEEF1');
  await next();
  await next();
  await page.getByRole('button', { name: 'Next free' }).click();
  await expect(page.getByText('Free', { exact: true })).toBeVisible();
  await next();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Product saved')).toBeVisible();

  await page.goto('/settings/hardware/scales');
  await expect(deli).toContainText('PLUs to send');
  await deli.getByRole('button', { name: 'Send prices' }).click();
  dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Beef steak');
  await dlg.getByRole('button', { name: 'Send now' }).click();
  await expect(dlg.getByTestId('scale-job').first()).toContainText('succeeded', { timeout: 20_000 });
  await dlg.getByRole('button', { name: 'Close' }).first().click();
  await expect(deli).toContainText('prices current');
  await page.screenshot({ path: 'test-results/scales.png', fullPage: true });

  // At the till: a weighed item opens the weigh window; only a real weight is added.
  await page.goto('/pos');
  const start = page.getByRole('button', { name: /^Start shift/ });
  if (await start.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Enter the total instead' }).click();
    await page.getByLabel('Opening float').fill('500');
    await start.click();
  }
  const scan = page.getByLabel('Scan or search products');
  await scan.fill('BEEF1');
  await scan.press('Enter');
  const weigh = page.getByRole('dialog');
  await expect(weigh.getByText('Weigh Beef steak')).toBeVisible();
  await expect(weigh.getByTestId('weigh-problem')).toContainText('Place the item');
  await weigh.getByLabel('Weight from the scale').fill('1.250');
  await expect(weigh.getByTestId('scale-reading')).toContainText('1.250');
  await page.screenshot({ path: 'test-results/pos-weigh.png' });
  await weigh.getByLabel('Weight from the scale').press('Enter');
  await expect(page.getByTestId('cart-total')).toHaveText(/1,000\.00/);
});
