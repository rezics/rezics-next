import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { clean } from './g-855-library.ts';
interface Seed {
  thai: { work: string };
  arabic: { work: string };
  work: string;
  entities: { elizabeth: string };
  facts: { statement: string; text: string; continuity: string; position: string }[];
}
let seed: Seed;
test.use({ actionTimeout: 20_000 });
test.beforeAll(() => {
  test.setTimeout(300_000);
  const cache = `.temp/g856-q7-${process.env.REZICS_QA_RUN_ID}.json`;
  if (existsSync(cache)) seed = JSON.parse(readFileSync(cache, 'utf8')) as Seed;
  else {
    const result = spawnSync('bun', ['apps/web/tests/g-856-wiki-seed.ts'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 240_000,
    });
    if (result.status !== 0 || result.error)
      throw new Error(`Query 7 seed: ${result.stderr || result.error?.message}`);
    seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seed;
    mkdirSync('.temp', { recursive: true });
    writeFileSync(cache, JSON.stringify(seed));
  }
});
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`query 7 ${viewport.width}: contradictory wiki claims keep their continuity and reveal only at their chapter`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const path = `/en/r/franchise-wiki/characters/${seed.entities.elizabeth.slice(-36)}`;
    await page.goto(`${path}?position=${seed.facts[0]!.position.slice(-36)}`);
    await expect(page.locator('[data-wiki-entity]')).toBeVisible();
    await expect(page.getByText(seed.facts[0]!.text, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(seed.facts[1]!.text, { exact: true })).toHaveCount(0);
    await page.goto(`${path}?position=${seed.facts[1]!.position.slice(-36)}`);
    const box = page.locator('[data-wiki-infobox]');
    await expect(box).toContainText(seed.facts[0]!.text);
    await expect(box).toContainText(seed.facts[1]!.text);
    await clean(page, info, `q7-contradictions-${viewport.width}`);
    await page.goto(`${path}?position=all`);
    await expect(box).toContainText(seed.facts[2]!.text);
    // The API exposes applicability for each assertion. The corresponding
    // displayed claim must let the reader see which continuity it belongs to.
    for (const fact of seed.facts) {
      const response = await page.request.get(
        `/api/main/v1/statements/${fact.statement.slice(-36)}?position=all`,
      );
      expect(response.status(), await response.text()).toBe(200);
      expect(((await response.json()) as { applicability: string[] }).applicability).toEqual([
        fact.continuity,
      ]);
    }
    await expect(
      box.getByRole('link', { name: 'Synthetic alternate continuity', exact: true }),
    ).toHaveCount(1);
    await expect(box.getByRole('link', { name: 'Pride and Prejudice', exact: true })).toHaveCount(
      2,
    );
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`G856 ${viewport.width}: a reader can choose chapter 1000 without revealing the whole story`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    await page.goto('/en/r/franchise-wiki');
    const button = page.getByRole('button', { name: /^Up to:/ });
    await expect(button).toHaveAttribute('data-hydrated', 'true');
    await button.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Chapter 1000', exact: true })).toBeVisible();
    await clean(page, info, `inventory-1000-${viewport.width}`);
  });
  test(`G856 ${viewport.width}: Thai and Arabic names survive an English interface`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    await page.goto(`/en/w/${seed.thai.work.slice(-36)}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('เจ้าหญิงแห่งดวงจันทร์');
    await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute('lang', 'th');
    await clean(page, info, `thai-${viewport.width}`);
    await page.goto(`/en/w/${seed.arabic.work.slice(-36)}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('اسم عربي للاختبار');
    await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute('dir', 'rtl');
    await clean(page, info, `arabic-${viewport.width}`);
  });
}
