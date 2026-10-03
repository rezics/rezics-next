import { expect, test, type Page } from '@playwright/test';

/** Delay actual hydration scripts, rather than waiting for the app's readiness
 * marker before interacting. Release uses a gate so host load cannot weaken it. */
async function holdHydration(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  await page.route('**/*', async (route) => {
    if (
      route.request().resourceType() === 'script' &&
      !route.request().url().includes('challenges.cloudflare.com')
    ) {
      held++;
      await gate;
    }
    await route.continue();
  });
  return { release, held: () => held };
}

test('G1030: zh-Hant email typed while scripts load survives hydration and Next', async ({
  page,
}) => {
  const gate = await holdHydration(page);
  try {
    await page.goto('/sign-in?hl=zh-Hant', { waitUntil: 'commit' });
    const email = page.locator('input[name="email"]');
    await email.fill('reader@example.test');
    await expect.poll(gate.held).toBeGreaterThan(0);
    await expect(page.locator('html')).not.toHaveAttribute('data-hydrated');
    gate.release();
    await page.locator('html[data-hydrated]').waitFor();
    await expect(email).toHaveValue('reader@example.test');
    await page.getByRole('button', { name: '下一步', exact: true }).click({ noWaitAfter: true });
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /reader@example\.test/ })).toBeVisible();
  } finally {
    gate.release();
  }
});

test('G1030: clicking Next before hydration submits the native email form', async ({ page }) => {
  const gate = await holdHydration(page);
  try {
    await page.goto('/sign-in?hl=zh-Hant&next=%2Fsecurity', { waitUntil: 'commit' });
    await page.locator('input[name="email"]').fill('reader@example.test');
    await expect.poll(gate.held).toBeGreaterThan(0);
    await page.getByRole('button', { name: '下一步', exact: true }).click({ noWaitAfter: true });
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('input[name="email"]')).toHaveValue('reader@example.test');
    await expect(page.locator('html')).not.toHaveAttribute('data-hydrated');
    gate.release();
    await page.locator('html[data-hydrated]').waitFor();
    await expect(page.locator('input[name="password"]')).toBeVisible();
  } finally {
    gate.release();
  }
});

test('G1030: signup name, email, passwords and policy check survive slow hydration', async ({
  page,
}) => {
  const gate = await holdHydration(page);
  try {
    await page.goto('/sign-up?hl=zh-Hant', { waitUntil: 'commit' });
    await page.locator('input[name="name"]').fill('林美玲');
    await page.locator('input[name="email"]').fill('reader@example.test');
    await page.locator('input[name="password"]').fill('typed before hydration');
    await page.locator('input[name="confirm"]').fill('typed before hydration');
    await page.locator('label[data-slot="checkbox"]').click();
    await expect.poll(gate.held).toBeGreaterThan(0);
    gate.release();
    await page.locator('html[data-hydrated]').waitFor();
    await expect(page.locator('input[name="name"]')).toHaveValue('林美玲');
    await expect(page.locator('input[name="email"]')).toHaveValue('reader@example.test');
    await expect(page.locator('input[name="password"]')).toHaveValue('typed before hydration');
    await expect(page.locator('input[name="confirm"]')).toHaveValue('typed before hydration');
    await expect(page.locator('input[name="accept-policies"]')).toBeChecked();
  } finally {
    gate.release();
  }
});

test('G1030: recovery retains typing and reset retains both passwords across hydration', async ({
  page,
}) => {
  const gate = await holdHydration(page);
  try {
    await page.goto('/forgot-password?hl=zh-Hant&email=old%40example.test', {
      waitUntil: 'commit',
    });
    await page.locator('input[name="email"]').fill('new@example.test');
    gate.release();
    await page.locator('html[data-hydrated]').waitFor();
    await expect(page.locator('input[name="email"]')).toHaveValue('new@example.test');
  } finally {
    gate.release();
  }
  await page.unrouteAll({ behavior: 'wait' });
  const resetGate = await holdHydration(page);
  try {
    await page.goto('/reset-password?hl=zh-Hant&token=hydration-fixture', { waitUntil: 'commit' });
    await page.locator('input[name="password"]').fill('typed before hydration');
    await page.locator('input[name="confirm"]').fill('typed before hydration');
    resetGate.release();
    await page.locator('html[data-hydrated]').waitFor();
    await expect(page.locator('input[name="password"]')).toHaveValue('typed before hydration');
    await expect(page.locator('input[name="confirm"]')).toHaveValue('typed before hydration');
  } finally {
    resetGate.release();
  }
});
