import { resourceHref, spaceHref, zoneMemberHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { clean } from './g-855-library.ts';
interface Seed {
  realm: string;
  zone: string;
  thai: { work: string };
  arabic: { work: string };
  work: string;
  entities: { elizabeth: string };
  facts: { statement: string; text: string; continuity: string; position: string }[];
}
let seed: Seed;
const main = (path: string) => `http://127.0.0.1:${process.env.MAIN_PORT}${path}`;
const uuid = (iri: string) => iri.slice(-36);
test.use({ actionTimeout: 20_000 });
test.beforeAll(async () => {
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
  // Main keeps processing the seed's events for a while, moving the graph under every read (409).
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main(`/v1/works/${uuid(seed.work)}`)).catch(() => null);
    const position = response?.ok
      ? JSON.stringify(((await response.json()) as { sourcePosition: unknown }).sourcePosition)
      : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for two minutes after the seed');
  // The Zone is read through its route segment, and its package runs only once Main reports it approved.
  let state = '';
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && state !== 'package';) {
    const zone = await fetch(main('/v1/zones/by-segment/franchise-wiki')).catch(() => null);
    const id = zone?.ok ? ((await zone.json()) as { zone: string }).zone.slice(-36) : null;
    const presentation = id
      ? await fetch(main(`/v1/zones/${id}/presentation`)).catch(() => null)
      : null;
    state = presentation?.ok
      ? ((await presentation.json()) as { execution: { state: string } }).execution.state
      : '';
    if (state !== 'package') await new Promise((done) => setTimeout(done, 1000));
  }
  if (state !== 'package')
    throw new Error('The franchise wiki Zone never reported its package approved');
  // The Realm's public header comes from a projection that can trail the Zone.
  let found = false;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && !found;) {
    const header = await fetch(main(`/v1/realms/${uuid(seed.realm)}`)).catch(() => null);
    found = Boolean(header?.ok);
    if (!found) await new Promise((done) => setTimeout(done, 1000));
  }
  if (!found) throw new Error('The Realm never became readable');
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
    const path = localizedPath(
      zoneMemberHref('franchise-wiki', 'characters', seed.entities.elizabeth.slice(-36)),
      'en',
    );
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
    await clean(page, info, `q7-continuities-${viewport.width}`);
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
    await page.goto(localizedPath(spaceHref('franchise-wiki', 'site'), 'en'));
    const button = page.getByRole('button', { name: /^Up to:/ });
    await expect(button).toHaveAttribute('data-hydrated', 'true');
    await button.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await clean(page, info, `inventory-1000-${viewport.width}`);
    await expect(dialog.getByRole('link', { name: 'Chapter 1000', exact: true })).toBeVisible();
  });
  test(`G856 ${viewport.width}: Thai and Arabic names survive an English interface`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    await page.goto(localizedPath(resourceHref('/w/', seed.thai.work.slice(-36)), 'en'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('เจ้าหญิงแห่งดวงจันทร์');
    await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute('lang', 'th');
    await clean(page, info, `thai-${viewport.width}`);
    await page.goto(localizedPath(resourceHref('/w/', seed.arabic.work.slice(-36)), 'en'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('اسم عربي للاختبار');
    await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute('dir', 'rtl');
    await clean(page, info, `arabic-${viewport.width}`);
  });
}
