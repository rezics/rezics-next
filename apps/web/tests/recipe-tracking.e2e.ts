import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BFF_PREFIX } from '../features/api/browser.ts';
import { studioHref } from '../features/studio/agent.ts';
import { localizedPath } from '../i18n/locale.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { chooseRadio, expectClean, type Findings, pressByKeyboard } from './g-743-matrix.ts';

test.use({ actionTimeout: 15_000 });

for (const locale of ['en', 'ja'] as const) {
  test(`recipe-tracking / ${locale}: a cook saves a recipe, completes it and returns to persisted progress`, async ({ page }, info) => {
    test.setTimeout(300_000);
    const { member, actingSubject } = JSON.parse(readFileSync(process.env.REZICS_WEB_AUTH_PRIVATE_PATH!, 'utf8')) as {
      member: { email: string; password: string }; actingSubject: string;
    };
    const found: Findings = [];
    const title = `Measured pancakes (${locale})`;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signInAtAccounts(page, localizedPath(studioHref({ iri: actingSubject, handle: null }, '/new'), 'en'), member);
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
    await chooseRadio(page, page.getByRole('radio', { name: /^Recipe/ }), found, 'Recipe');
    await pressByKeyboard(page, page.getByRole('combobox', { name: 'Language you’ll write in', exact: true }), found, 'Recipe language');
    await page.getByRole('option', { name: 'English', exact: true }).press('Enter');
    await pressByKeyboard(page, page.getByRole('button', { name: /^Create as / }), found, 'Create recipe');
    await expect(page.getByRole('heading', { name: 'About this recipe', exact: true })).toBeVisible();
    const ingredient = page.getByRole('textbox', { name: 'Ingredient line', exact: true });
    await ingredient.fill('1 cup flour');
    await ingredient.press('Enter');
    await expect(page.locator('[data-line]')).toHaveCount(1);
    const step = page.getByRole('form', { name: 'Add a step', exact: true });
    await step.getByRole('textbox').fill('Cook the pancakes until golden.');
    await pressByKeyboard(page, step.getByRole('button', { name: 'Add', exact: true }), found, 'Add step');
    await expect(page.locator('[data-step]')).toHaveCount(1);
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
    const published = page.waitForResponse(response => new URL(response.url()).pathname === `${BFF_PREFIX}/v1/work-publications`
      && response.request().method() === 'POST' && response.status() !== 202, { timeout: 60_000 });
    await pressByKeyboard(page, page.getByRole('button', { name: 'Publish', exact: true }), found, 'Publish recipe');
    const response = await published;
    expect(response.ok(), JSON.stringify({ method: 'POST', path: `${BFF_PREFIX}/v1/work-publications`,
      request: response.request().postDataJSON(), status: response.status(), answer: await response.json() })).toBe(true);
    await expect(page.getByText('Published. Everyone can read this recipe.')).toBeVisible();
    const path = new URL(page.url()).pathname.replace(/^\/en/, '').replace(/\/edit\/recipe$/, '');
    const home = localizedPath(path, locale);
    const connections = localizedPath(`${path}/connections`, locale);
    await page.goto(home);
    if (locale !== 'en') await page.goto(home);
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
      await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
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
      await page.close();
    }
  });
}
