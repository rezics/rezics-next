import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect as baseExpect, type Page, test } from '@playwright/test';
import { spaceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';

// The year view and the Work page render catalogue reads on the server. A quiet stack
// answers inside a few seconds; a busy one needs the same budget as the click.
const expect = baseExpect.configure({ timeout: 30_000 });

// A reader filters each Zone by format and publication year, opens the long series, and reads the fact panel.
// anime-manga-zones.prepare.ts writes the Zones into this stack before Playwright starts.

interface SeededZone { handle: string; title: string }
interface Seeded { anime: SeededZone; manga: SeededZone }

const seeded = (): Seeded => JSON.parse(readFileSync(
  resolve('.temp/anime-manga-zones', process.env.REZICS_QA_RUN_ID!, 'seed.json'), 'utf8')) as Seeded;

const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 860 },
] as const;
const locales = ['en', 'ja'] as const;

const copy = {
  en: {
    filters: 'Filters',
    yearLabel: 'Publication year',
    yearSubmit: 'Show this year',
    tv: /^TV\s+\d+/,
    manga: /^Manga\s+\d+/,
    episodes: '1,155 episodes',
    volumes: '21 volumes',
    completed: 'Completed',
    tvWord: 'TV',
    mangaWord: 'Manga',
  },
  ja: {
    filters: 'フィルター',
    yearLabel: '公開年',
    yearSubmit: 'この年を表示',
    tv: /^テレビ\s+\d+/,
    manga: /^漫画\s+\d+/,
    episodes: '1,155 話',
    volumes: '21 巻',
    completed: '完結',
    tvWord: 'テレビ',
    mangaWord: '漫画',
  },
} as const;

test.use({ reducedMotion: 'reduce', actionTimeout: 30_000 });

async function chooseFormat(page: Page, filters: string, name: RegExp) {
  // The phone drawer and the desktop chip are both in the tree. Only a shown control counts:
  // an `or` of a hidden summary and a visible chip is two matches, and the expectation fails closed.
  const summary = page.locator('summary', { hasText: filters }).filter({ visible: true });
  const link = page.getByRole('link', { name }).filter({ visible: true });
  await expect(summary.or(link).first()).toBeVisible();
  if (await summary.isVisible()) await summary.click();
  await link.first().click();
}

async function showYear(page: Page, label: string, submit: string, year: string) {
  await page.getByLabel(label).fill(year);
  await page.getByRole('button', { name: submit }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]year=${year}(?:&|$)`));
}

for (const locale of locales) {
  for (const viewport of viewports) {
    test(`${locale} at ${viewport.width}px: filter the long anime and manga by format and year`, async ({ page }, info) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const words = copy[locale];
      const data = seeded();
      const shot = async (name: string) => {
        const path = resolve('.temp/anime-manga-zones/screens', `${locale}-${viewport.name}-${name}.png`);
        mkdirSync(resolve('.temp/anime-manga-zones/screens'), { recursive: true });
        await page.screenshot({ path, fullPage: false });
        await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false });
      };

      await page.goto(localizedPath(spaceHref(data.anime.handle, 'site', ['browse']), locale));
      await chooseFormat(page, words.filters, words.tv);
      await showYear(page, words.yearLabel, words.yearSubmit, '1980');
      const anime = page.getByRole('link', { name: data.anime.title }).first();
      await expect(anime).toBeVisible();
      await expect(page.getByText(words.episodes).first()).toBeVisible();
      await anime.scrollIntoViewIfNeeded();
      await shot('anime-year');
      await anime.click();
      const animePanel = page.locator('[data-catalogue-panel]');
      await expect(animePanel).toBeVisible();
      await expect(animePanel).toContainText(words.tvWord);
      await expect(animePanel).toContainText('1980');
      await expect(animePanel).toContainText(words.episodes);
      await expect(animePanel).toContainText(words.completed);
      await expect(animePanel).not.toContainText(/chapter/i);
      await animePanel.scrollIntoViewIfNeeded();
      await shot('anime-panel');

      await page.goto(localizedPath(spaceHref(data.manga.handle, 'site', ['browse']), locale));
      await chooseFormat(page, words.filters, words.manga);
      await showYear(page, words.yearLabel, words.yearSubmit, '1995');
      const manga = page.getByRole('link', { name: data.manga.title }).first();
      await expect(manga).toBeVisible();
      await expect(page.getByText(words.volumes).first()).toBeVisible();
      await manga.scrollIntoViewIfNeeded();
      await shot('manga-year');
      await manga.click();
      const mangaPanel = page.locator('[data-catalogue-panel]');
      await expect(mangaPanel).toBeVisible();
      await expect(mangaPanel).toContainText(words.mangaWord);
      await expect(mangaPanel).toContainText('1995');
      await expect(mangaPanel).toContainText(words.volumes);
      await expect(mangaPanel).toContainText(words.completed);
      await expect(mangaPanel.getByText(/\d+ episodes/)).toHaveCount(0);
      await mangaPanel.scrollIntoViewIfNeeded();
      await shot('manga-panel');
    });
  }
}
