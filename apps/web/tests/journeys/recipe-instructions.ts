import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect as playwrightExpect, type Locator, type Page, test } from '@playwright/test';
import { resourceHref } from '../../features/address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { expectClean, type Findings, keyboardReach, pressByKeyboard } from '../g-743-matrix.ts';
import type { RecipeInstructionsFixture } from '../recipe-instructions-seed.ts';

const expect = playwrightExpect.configure({ timeout: 30_000 });

/** A reader scrolls the document with keys, without moving focus by script. */
async function readByKeyboard(page: Page, target: Locator) {
  await page.keyboard.press('Control+Home');
  for (let step = 0; step < 30; step++) {
    const inView = await target.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
    });
    if (inView) break;
    await page.keyboard.press('PageDown');
  }
  await expect(target).toBeInViewport();
}

export function registerRecipeInstructionsJourney() {
  test.use({ actionTimeout: 15_000 });
  for (const locale of ['en', 'ja'] as const) {
    test(`recipe-instructions / ${locale}: a reader opens procedure, Post and audio instructions by keyboard and reloads each form`, async ({ page }, info) => {
      test.setTimeout(240_000);
      const fixture = JSON.parse(readFileSync(resolve('.temp/recipe-instructions', process.env.REZICS_QA_RUN_ID!, 'seed.json'), 'utf8')) as RecipeInstructionsFixture;
      const found: Findings = [];
      await page.emulateMedia({ reducedMotion: 'reduce' });
      // Signed-out reading proves publication supplies access to dependencies;
      // the authoring member's custody cannot hide a missing public instruction.
      for (const recipe of fixture.recipes) {
        await page.goto(localizedPath(resourceHref('/w/', recipe.work.slice(-36)), locale));
        for (const visit of ['open', 'reload']) {
          if (visit === 'reload') await page.reload();
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          await expect(page.getByRole('heading', { level: 1, name: recipe.title, exact: true })).toBeVisible();
          const region = page.getByRole('region', { name: locale === 'en' ? 'Recipe' : 'レシピ', exact: true });
          const instructions = region.locator('[data-instruction-occurrence]');
          await expect(instructions).toHaveCount(1);
          if (recipe.form === 'audio') {
            const label = locale === 'en' ? 'Open recording' : '録音・動画を開く';
            const delivered = page.waitForResponse(response => response.url().includes('/v1/media/representations/') && response.url().includes('/bytes'));
            await pressByKeyboard(page, instructions.getByRole('button', { name: label, exact: true }), found, label);
            const response = await delivered;
            expect(response.status()).toBe(200);
            expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(fixture.recordingDigest);
            const audio = instructions.locator('audio');
            await expect(audio).toHaveAttribute('controls', '');
            await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(2);
            await keyboardReach(page, audio, found, label);
            await page.keyboard.press('Space');
            await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(false);
            await page.keyboard.press('Space');
            await expect.poll(() => audio.evaluate(element => (element as HTMLAudioElement).paused)).toBe(true);
          } else {
            const text = instructions.getByText(recipe.text!, { exact: true });
            await expect(text).toBeVisible();
            await readByKeyboard(page, text);
            if (recipe.form === 'procedure') {
              await expect(instructions.getByRole('heading', { name: 'Sauce method', exact: true })).toBeVisible();
              await expect(instructions.locator('[data-procedure-item="sauce"] [data-procedure-item="stir"]')).toContainText(recipe.text!);
            }
          }
          await page.screenshot({ path: info.outputPath(`${recipe.form}-${locale}-${visit}.png`), fullPage: true });
        }
      }
      expectClean(found);
    });
  }
}
