import { expect, test } from '@playwright/test';
import { localeNames, uiLocales } from '../i18n/define.ts';

test('G288 Traditional Chinese home route keeps English fallback strings', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/zh-Hant/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  await expect(page.getByRole('heading', { level: 1, name: 'Find a work. Follow its meaning.' })).toBeVisible();
  await expect(page.getByRole('search', { name: 'Search published works' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('eight canonical locale routes expose native picker names and English key fallback', async ({ page }) => {
  await page.goto('/fr/search');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('heading', { name: 'Search works' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${origin}/fr/search`);
  for (const locale of uiLocales) {
    await expect(page.locator(`link[rel="alternate"][hreflang="${locale}"]`))
      .toHaveAttribute('href', `${origin}/${locale}/search`);
  }
  const picker = page.getByRole('combobox', { name: 'Language' });
  await picker.click();
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText(uiLocales.map(locale => localeNames[locale]));
  await page.getByRole('option', { name: localeNames.de }).click();
  await expect(page).toHaveURL(`${origin}/de/search`);
  await expect(page.getByRole('heading', { name: 'Search works' })).toBeVisible();
});

test('interface locale persists without changing public search language or another browser session', async ({ browser }) => {
  const first = await browser.newContext({ locale: 'en-US' });
  const second = await browser.newContext({ locale: 'en-US' });
  try {
    const page = await first.newPage();
    await page.goto('/search?q=river');
    await expect(page).toHaveURL(/\/en\/search\?q=river$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Search works' })).toBeVisible();
    const origin = new URL(page.url()).origin;
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${origin}/en/search`);
    await expect(page.locator('link[rel="alternate"][hreflang="zh-Hans"]'))
      .toHaveAttribute('href', `${origin}/zh-Hans/search`);

    await page.getByRole('banner').getByRole('combobox', { name: 'Language' }).click();
    await page.getByRole('option', { name: localeNames['zh-Hans'] }).click();
    await expect(page).toHaveURL(/\/zh-Hans\/search\?q=river$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
    await expect(page.getByRole('heading', { name: '搜索作品' })).toBeVisible();
    // The interface locale never becomes a content-language filter.
    await expect(page.getByRole('region', { name: '搜索结果' })).toContainText('全局中没有与“river”匹配的作品');
    await expect(page.getByTestId('search-completeness')).not.toContainText('仅限');

    await page.getByRole('link', { name: '英语' }).click();
    await expect(page).toHaveURL(/\/zh-Hans\/search\?q=river&lang=en$/);
    await expect(page.getByRole('link', { name: '英语' })).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('search-completeness')).toContainText('仅限英语文本');

    // Protected pages begin OAuth while retaining their language and return address.
    const studio = await page.request.get('/zh-Hans/studio', { maxRedirects: 0 });
    expect(studio.headers().location).toBe('/auth/start?next=%2Fzh-Hans%2Fstudio');
    const identity = await page.request.get('/zh-Hans/identity?next=/zh-Hans/studio', { maxRedirects: 0 });
    expect(identity.headers().location).toContain('/auth/start?next=');
    await page.goto('/');
    await expect(page).toHaveURL(/\/zh-Hans$/);
    await expect(page.getByRole('heading', { name: '寻找作品，追寻其意义。' })).toBeVisible();
    await page.goto('/en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.goto('/');
    await expect(page).toHaveURL(/\/zh-Hans$/);

    const invalidLocale = await page.request.post('/locale/select', { form: { locale: 'pt' } });
    expect(invalidLocale.status()).toBe(400);
    const rejectedOrigin = await page.request.post('/locale/select', { form: { locale: 'en' },
      headers: { origin: 'https://another.example' } });
    expect(rejectedOrigin.status()).toBe(403);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');

    const unsafeReturn = await page.request.post('/locale/select', { form: { locale: 'en' },
      headers: { origin: 'http://127.0.0.1:3003', referer: 'http://127.0.0.1:3003//another.example' },
      maxRedirects: 0 });
    expect(unsafeReturn.status()).toBe(303);
    expect(new URL(unsafeReturn.headers().location).origin).toBe('http://127.0.0.1:3003');

    const other = await second.newPage();
    await other.goto('/search?q=river');
    await expect(other).toHaveURL(/\/en\/search\?q=river$/);
    await expect(other.locator('html')).toHaveAttribute('lang', 'en');
    await expect(other.getByRole('heading', { name: 'Search works' })).toBeVisible();
  } finally {
    await first.close();
    await second.close();
  }
});
