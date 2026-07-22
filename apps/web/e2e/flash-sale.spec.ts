import AxeBuilder from '@axe-core/playwright';
import { expect, installApi, test } from './fixtures';

const identifier = 'mia@example.com';

async function openActive(page: Parameters<typeof installApi>[0]) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Secure your card' })).toBeEnabled();
}

async function submit(page: Parameters<typeof installApi>[0]) {
  await page.getByRole('textbox', { name: 'Email or username' }).fill(identifier);
  await page.getByRole('button', { name: 'Secure your card' }).click();
}

test('active sale renders every product surface without horizontal overflow', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await installApi(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /last card/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Acquisition console' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ops ledger' })).toBeVisible();
  await expect(page.locator('footer')).toContainText('React · Vite');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expect(page).toHaveScreenshot('active-sale.png', {
    fullPage: true,
    maxDiffPixelRatio: 0.01,
  });
});

test('submitting blocks duplicates then checks reserved and persisted status', async ({ page }) => {
  const api = await installApi(page, 'active', {
    purchase: { hold: true },
    purchaseStatuses: [
      { purchased: true, order: { status: 'reserved', createdAt: null } },
      {
        purchased: true,
        order: { status: 'persisted', createdAt: new Date(FIXED_PERSISTED_AT).toISOString() },
      },
    ],
  });
  await openActive(page);
  const input = page.getByRole('textbox', { name: 'Email or username' });
  const buy = page.getByRole('button', { name: 'Secure your card' });
  await input.fill('x');
  await buy.click();
  await expect(page.getByRole('alert')).toContainText('Enter 3–64');
  await input.fill(identifier);
  await buy.click();
  await expect(page.getByRole('button', { name: 'Securing…' })).toBeDisabled();
  await expect(input).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check my status' })).toBeDisabled();
  await page.getByRole('button', { name: 'Securing…' }).click({ force: true });
  await page.keyboard.press('Enter');
  expect(api.counts().purchasePosts).toBe(1);
  await expect(page.locator('.feedback strong', { hasText: 'Card secured' })).toHaveCount(0);
  api.releasePurchase();
  await expect(page.locator('.feedback strong', { hasText: 'Card secured' })).toBeVisible();
  await page.getByRole('button', { name: 'Check my status' }).click();
  await expect(page.locator('.check-result')).toHaveText(
    'Reservation found — reserved and waiting for durable persistence.',
  );
  await page.getByRole('button', { name: 'Check my status' }).click();
  await expect(page.locator('.check-result')).toContainText(
    'Reservation found — persisted to the permanent record.',
  );
  await expect(page.locator('.check-result')).toContainText('Created');
  expect(api.counts().purchasePosts).toBe(1);
});

const FIXED_PERSISTED_AT = Date.UTC(2026, 6, 23, 4, 0, 1);

test('409 already purchased preserves the original reservation without retry', async ({ page }) => {
  const api = await installApi(page, 'active', {
    purchase: { httpStatus: 409, outcome: 'ALREADY_PURCHASED', stockRemaining: 499 },
  });
  await openActive(page);
  await submit(page);
  await expect(page.getByText('You already hold a reservation')).toBeVisible();
  await page.clock.runFor(30_000);
  expect(api.counts().purchasePosts).toBe(1);
});

test('410 sold out renders zero authoritative stock and disables Buy', async ({ page }) => {
  const api = await installApi(page, 'active', {
    purchase: {
      httpStatus: 410,
      outcome: 'SOLD_OUT',
      stockRemaining: 0,
      saleStateAfterPurchase: 'sold_out',
    },
  });
  await openActive(page);
  await submit(page);
  await expect(page.getByText('Sold out').last()).toBeVisible();
  await expect(page.getByText('0 / 500 remaining')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sold out' })).toBeDisabled();
  expect(api.counts().purchasePosts).toBe(1);
});

test('403 ended outcome refreshes the ended sale and disables Buy', async ({ page }) => {
  const api = await installApi(page, 'active', {
    purchase: {
      httpStatus: 403,
      outcome: 'SALE_ENDED',
      stockRemaining: 500,
      saleStateAfterPurchase: 'ended',
    },
  });
  await openActive(page);
  await submit(page);
  await expect(page.getByText('This drop is closed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sale ended' })).toBeDisabled();
  expect(api.counts().purchasePosts).toBe(1);
});

test('429 Retry-After countdown completes without another POST', async ({ page }) => {
  const api = await installApi(page, 'active', {
    purchase: {
      httpStatus: 429,
      outcome: 'RATE_LIMITED',
      stockRemaining: 500,
      retryAfter: '2',
    },
  });
  await openActive(page);
  await submit(page);
  await expect(page.getByText('Too many attempts')).toBeVisible();
  await expect(page.getByText('Try again in 2s.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again in 2s' })).toBeDisabled();
  await page.clock.runFor(2250);
  await expect(page.getByRole('button', { name: 'Secure your card' })).toBeEnabled();
  expect(api.counts().purchasePosts).toBe(1);
});

test('structured 503 unavailable outcome is explicit and never retried', async ({ page }) => {
  const api = await installApi(page, 'active', {
    purchase: {
      httpStatus: 503,
      outcome: 'UPSTREAM_UNAVAILABLE',
      stockRemaining: null,
    },
  });
  await openActive(page);
  await submit(page);
  await expect(page.getByText('Service temporarily unavailable')).toBeVisible();
  await page.clock.runFor(30_000);
  expect(api.counts().purchasePosts).toBe(1);
});

test('HTTP 200 valid confirmation is never presented as secured', async ({ page }) => {
  const api = await installApi(page, 'active', {
    purchase: { httpStatus: 200, outcome: 'CONFIRMED', stockRemaining: 499 },
  });
  await openActive(page);
  await submit(page);
  await expect(page.getByText('We could not verify the result')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Email or username' })).toHaveValue(identifier);
  await expect(page.getByRole('button', { name: 'Check my status' })).toBeEnabled();
  expect(api.counts().purchasePosts).toBe(1);
  await expect(page.locator('.feedback strong', { hasText: 'Card secured' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '✓ Card secured' })).toHaveCount(0);
  await page.clock.runFor(30_000);
  expect(api.counts().purchasePosts).toBe(1);
  await expect(page.locator('.feedback strong', { hasText: 'Card secured' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '✓ Card secured' })).toHaveCount(0);
});

test('transport-aborted purchase stays ambiguous and never retries', async ({ page }) => {
  const api = await installApi(page, 'active', { purchase: { abort: true } });
  await openActive(page);
  await submit(page);
  await expect(page.getByText('Result unknown')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Email or username' })).toHaveValue(identifier);
  await expect(page.getByRole('button', { name: 'Check my status' })).toBeEnabled();
  await page.clock.runFor(30_000);
  expect(api.counts().purchasePosts).toBe(1);
});

test('sale polling retains last-good stock and serializes held recovery', async ({ page }) => {
  const api = await installApi(page);
  await openActive(page);
  await expect(page.getByText('500 / 500 remaining')).toBeVisible();
  api.failNextSaleStatus();
  await page.clock.runFor(3000);
  await expect(page.getByRole('alert')).toContainText('temporarily unreachable');
  await expect(page.getByText('500 / 500 remaining')).toBeVisible();
  api.holdNextSaleStatus(321);
  const retry = page.getByRole('button', { name: 'Retry' });
  await retry.click();
  await retry.click();
  await expect.poll(() => api.counts().saleStatusInFlight).toBe(1);
  expect(api.counts().maximumSaleStatusInFlight).toBe(1);
  await api.releaseSaleStatus();
  await expect(page.getByText('321 / 500 remaining')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const state of ['upcoming', 'active', 'sold_out', 'ended'] as const) {
  test(`axe ${state} surface has no serious or critical violations`, async ({ page }) => {
    await installApi(page, state);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const pill = page.locator('.pill');
    const buy = page.locator('.buy-button');
    if (state === 'upcoming') {
      await expect(pill).toHaveText(/Upcoming/);
      await expect(buy).toHaveText('Opens soon');
      await expect(buy).toBeDisabled();
    } else if (state === 'active') {
      await expect(pill).toHaveText(/Live now/);
      await expect(buy).toHaveText('Secure your card');
      await expect(buy).toBeEnabled();
    } else if (state === 'sold_out') {
      await expect(pill).toHaveText(/Sold out/);
      await expect(buy).toHaveText('Sold out');
      await expect(buy).toBeDisabled();
      await expect(page.getByText('0 / 500 remaining')).toBeVisible();
    } else {
      await expect(pill).toHaveText(/Ended/);
      await expect(buy).toHaveText('Sale ended');
      await expect(buy).toBeDisabled();
    }
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      results.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical'),
    ).toEqual([]);
  });
}
