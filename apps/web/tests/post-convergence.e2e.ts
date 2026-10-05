import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

const storybook = process.env.REZICS_STORYBOOK_URL ?? 'http://localhost:6006';
const samples = [
  { locale: 'en', story: 'Chapter Without Label', text: 'A chapter of 雨夜书店 · 连载小说' },
  {
    locale: 'zh-Hant',
    story: 'Chapter Without Label Traditional Chinese',
    text: '《雨夜书店 · 连载小说》的一個章節',
  },
];

for (const sample of samples) {
  test(`the shared Manage queue names an unreadable chapter label in ${sample.locale}`, async ({
    page,
  }) => {
    const response = await page.request.get(`${storybook}/index.json`);
    expect(response.ok()).toBe(true);
    const index = (await response.json()) as {
      entries: Record<string, { id: string; title: string; name: string; type: string }>;
    };
    const entry = Object.values(index.entries).find(
      (item) =>
        item.type === 'story' && item.title === 'Manage/Queue' && item.name === sample.story,
    );
    expect(
      entry,
      'The shared stack must serve the integrated chapter wording stories',
    ).toBeDefined();
    await page.goto(`${storybook}/iframe.html?id=${entry!.id}&viewMode=story`);
    await expect(page.getByRole('heading', { level: 3, name: sample.text })).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: new RegExp(sample.locale === 'en' ? '^A chapter of' : '^《雨夜书店'),
      }),
    ).toBeVisible();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page.screenshot({
      path: resolve('.temp', `post-convergence-shared-${sample.locale}.png`),
    });
  });
}
