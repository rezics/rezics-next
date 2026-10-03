import { expect, test } from '@playwright/test';
import { browseMessages } from '../features/discover/browse-messages.ts';

test('G1030: a zh-Hant Discover type link navigates while hydration scripts are held', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'script') {
      held++;
      await gate;
    }
    await route.continue();
  });
  try {
    await page.goto('/zh-Hant/discover', { waitUntil: 'commit' });
    const t = browseMessages['zh-Hant'];
    const works = page
      .getByRole('navigation', { name: t.type, exact: true })
      .getByRole('link', { name: t.works, exact: true });
    await expect(works).toHaveAttribute('href', '/zh-Hant/discover?tab=works');
    await expect.poll(() => held).toBeGreaterThan(0);
    await works.click({ noWaitAfter: true });
    await expect(page).toHaveURL(/\/zh-Hant\/discover\?tab=works$/);
    await expect(
      page
        .getByRole('navigation', { name: t.type, exact: true })
        .getByRole('link', { name: t.works, exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  } finally {
    release();
  }
});
