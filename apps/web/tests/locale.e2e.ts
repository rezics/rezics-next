import { expect, test } from '@playwright/test';

test('interface locale persists without changing public search language or another browser session', async ({ browser }) => {
  const first = await browser.newContext({ locale: 'en-US' });
  const second = await browser.newContext({ locale: 'en-US' });
  try {
    const page = await first.newPage();
    await page.goto('/search?q=river');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Search works' })).toBeVisible();

    const queryAfterSwitch = page.waitForRequest(request => request.url().includes('/api/main/v1/queries')
      && request.method() === 'POST');
    await page.getByRole('form', { name: 'Interface language' })
      .getByRole('button', { name: '简体中文' }).click();
    const initialQuery = await queryAfterSwitch;
    expect(initialQuery.postDataJSON()).toMatchObject({ language: null });
    await expect(page).toHaveURL(/\/search\?q=river$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('heading', { name: '搜索作品' })).toBeVisible();
    await expect(page.getByRole('region', { name: '搜索结果' })).toContainText('没有找到匹配的作品。');

    const selectedQuery = page.waitForRequest(request => request.url().includes('/api/main/v1/queries')
      && request.method() === 'POST' && request.postDataJSON()?.language === 'en');
    await page.getByRole('radio', { name: '英语' }).check();
    expect((await selectedQuery).postDataJSON()).toMatchObject({ language: 'en' });
    await expect(page.getByRole('radio', { name: '英语' })).toBeChecked();

    await page.goto('/studio');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fstudio$/);
    await expect(page.getByRole('heading', { name: '登录 REZICS' })).toBeVisible();
    await page.goto('/identity?next=/studio');
    await expect(page.getByRole('heading', { name: '选择操作身份' })).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '寻找作品，追寻其意义。' })).toBeVisible();

    const invalidLocale = await page.request.post('/locale/select', { form: { locale: 'fr' } });
    expect(invalidLocale.status()).toBe(400);
    const rejectedOrigin = await page.request.post('/locale/select', { form: { locale: 'en' },
      headers: { origin: 'https://another.example' } });
    expect(rejectedOrigin.status()).toBe(403);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

    const unsafeReturn = await page.request.post('/locale/select', { form: { locale: 'en' },
      headers: { origin: 'http://127.0.0.1:3003', referer: 'http://127.0.0.1:3003//another.example' },
      maxRedirects: 0 });
    expect(unsafeReturn.status()).toBe(303);
    expect(new URL(unsafeReturn.headers().location).origin).toBe('http://127.0.0.1:3003');

    const other = await second.newPage();
    await other.goto('/search?q=river');
    await expect(other.locator('html')).toHaveAttribute('lang', 'en');
    await expect(other.getByRole('heading', { name: 'Search works' })).toBeVisible();
  } finally {
    await first.close();
    await second.close();
  }
});
