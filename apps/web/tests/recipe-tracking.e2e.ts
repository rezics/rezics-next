import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { LaunchRecipesCorpus } from '../../../scripts/load/launch-corpus-types.ts';
import { resourceHref } from '../features/address/path.ts';
import { realmWorkHref } from '../features/realm/route.ts';
import { localizedPath } from '../i18n/locale.ts';
import { device } from './g-743-stack.ts';
import { expectClean, type Findings, pressByKeyboard } from './g-743-matrix.ts';

test.use({ actionTimeout: 15_000 });

for (const locale of ['en', 'ja'] as const) {
  test(`recipe-tracking / ${locale}: a cook saves a recipe, completes it and returns to persisted progress`, async ({ browser }, info) => {
    test.setTimeout(180_000);
    const prepared = JSON.parse(readFileSync(resolve('.temp/launch-corpus', `browser-recipes-${process.env.REZICS_QA_RUN_ID}.json`), 'utf8')) as { corpus: LaunchRecipesCorpus; restored: boolean };
    expect(prepared.restored).toBe(true);
    const recipe = prepared.corpus.records.find(record => record.recipeId === 'puff-paste')!;
    const home = localizedPath(realmWorkHref('launch-recipes', recipe.work), locale);
    const connections = localizedPath(resourceHref('/w/', recipe.work.slice(-36), ['connections']), locale);
    const page = await device(browser, info, home, { reducedMotion: true });
    const found: Findings = [];
    const t = locale === 'en'
      ? { want: 'Want to cook', cooking: 'Cooking', cooked: 'Cooked', remove: 'Remove from my shelves', start: 'Mark reading', finish: 'Mark completed', reset: 'Mark not started', started: 'Reading', completed: 'Completed', empty: 'Not started' }
      : { want: '作りたい', cooking: '調理中', cooked: '作った', remove: '本棚から削除', start: '読書中にする', finish: 'クリアにする', reset: '未開始に戻す', started: '読書中', completed: 'クリア', empty: '未読' };
    const shelved = (label: string) => page.getByRole('button', { name: new RegExp(`^${label} —`) });
    const savedShelf = async (label: string) => {
      await expect(shelved(label)).toBeVisible();
      await expect(shelved(label)).not.toHaveAttribute('aria-busy', 'true');
    };
    try {
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 1, name: recipe.title, exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: locale === 'en' ? 'Recipe' : 'レシピ', exact: true })).toBeVisible();
      // Start a fresh shelf cycle when the same member ran the other locale already.
      const existing = page.getByRole('button', { name: /^(Want to cook|Cooking|Cooked|作りたい|調理中|作った) —/ });
      if (await existing.count()) {
        await pressByKeyboard(page, existing, found, 'Shelf');
        await page.getByRole('menuitem', { name: t.remove, exact: true }).press('Enter');
      }
      await pressByKeyboard(page, page.getByRole('button', { name: t.want, exact: true }), found, t.want);
      await savedShelf(t.want);
      await page.reload();
      await savedShelf(t.want);
      for (const label of [t.cooking, t.cooked]) {
        await pressByKeyboard(page, page.getByRole('button', { name: /^(Want to cook|Cooking|Cooked|作りたい|調理中|作った) —/ }), found, 'Shelf');
        await page.getByRole('menuitemradio', { name: label, exact: true }).press('Enter');
        await savedShelf(label);
        await page.reload();
        await savedShelf(label);
      }
      await page.goto(connections);
      const progress = page.locator('[data-work-progress]');
      await expect(progress).toBeVisible();
      if (await progress.getByRole('button', { name: t.reset, exact: true }).count()) {
        await pressByKeyboard(page, progress.getByRole('button', { name: t.reset, exact: true }), found, t.reset);
      }
      await expect(progress.locator('[data-where]')).toHaveText(t.empty);
      await pressByKeyboard(page, progress.getByRole('button', { name: t.start, exact: true }), found, t.start);
      await expect(progress.locator('[data-where]')).toHaveText(t.started);
      await page.reload();
      await expect(progress.locator('[data-where]')).toHaveText(t.started);
      await pressByKeyboard(page, progress.getByRole('button', { name: t.finish, exact: true }), found, t.finish);
      await expect(progress.locator('[data-where]')).toHaveText(t.completed);
      await page.reload();
      await expect(progress.locator('[data-where]')).toHaveText(t.completed);
      await page.screenshot({ path: info.outputPath(`recipe-progress-${locale}.png`), fullPage: true });
      await page.goto(home);
      await savedShelf(t.cooked);
      expectClean(found);
    } finally {
      await page.context().close();
    }
  });
}
