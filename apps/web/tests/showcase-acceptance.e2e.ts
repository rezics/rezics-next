import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { deriveAddressSuffix } from '@rezics/model/address';
import { resourceHref, spaceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { signInAtAccounts } from './account-sign-in.ts';
import { campaignAlt, campaignTitle, gameTitle } from './showcase-acceptance-data.ts';

// The showcase acceptance: a Zone home that leads with slides, and a game's Work page, on a phone and a desktop,
// signed out and signed in. Each slide is announced once, by its heading; its position is its group's name; and the
// description its author wrote for its art is the only image a reader hears. showcase-acceptance.prepare.ts writes
// the Zone and the game into this stack before Playwright starts.

interface Seeded { space: string; zone: string; realm: string; work: string }
interface PrivateFixture { member: { email: string; password: string } }

const seeded = (): Seeded => JSON.parse(readFileSync(
  resolve('.temp/showcase-acceptance', process.env.REZICS_QA_RUN_ID!, 'seed.json'), 'utf8')) as Seeded;
const member = () => (JSON.parse(readFileSync(process.env.REZICS_WEB_AUTH_PRIVATE_PATH!, 'utf8')) as PrivateFixture).member;

const viewports = [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 900 }] as const;
// Rotation would move the stage under a snapshot.
test.use({ reducedMotion: 'reduce', actionTimeout: 30_000 });

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The headings of a snapshot that name `title`: a slide is announced once when exactly one does. */
const headings = (snapshot: string, title: string) => count(snapshot, new RegExp(`- heading "${escape(title)}"`, 'g'));

/** Tab from the stage's first control until focus leaves it, naming each stop. */
async function tabOrder(page: Page) {
  await page.locator('.showcase-layout').first().locator('button, a').first().focus();
  const stops: string[] = [];
  for (let step = 0; step < 40; step++) {
    const stop = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || !active.closest('.showcase-layout')) return null;
      return `${active.tagName.toLowerCase()}:${active.getAttribute('aria-label') ?? active.textContent?.trim() ?? ''}`;
    });
    if (stop === null) break;
    stops.push(stop);
    await page.keyboard.press('Tab');
  }
  return stops;
}

for (const identity of ['signed out', 'signed in'] as const) {
  for (const viewport of viewports) {
    test(`${identity} on a ${viewport.name}: each slide is heard once with its authored description, and a game Work page names its title once`, async ({ page }, info) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const { space, work } = seeded();
      const zone = localizedPath(spaceHref(space, 'site'), 'en');
      // The Zone's own address carries its name; sign-in finishes on that canonical path.
      if (identity === 'signed in') await signInAtAccounts(page, `${zone}-${deriveAddressSuffix('Games')}`, member());
      else await page.goto(zone);
      const stage = page.locator('.showcase-layout').first();
      await expect(stage).toBeVisible();
      await expect(page.locator('.showcase-slide')).toHaveCount(2);
      const shot = (name: string) => page.screenshot({ path: info.outputPath(`${identity.replace(' ', '-')}-${viewport.name}-${name}.png`), fullPage: false });

      // Art waits for the reader's content preferences; the tree is read once every image has settled.
      await expect(stage.getByRole('img', { name: 'Loading content preferences…' })).toHaveCount(0);
      // The first slide is the game's: its heading names it, its group only says where it is, and its art is decorative.
      const first = await stage.ariaSnapshot();
      expect(headings(first, gameTitle), first).toBe(1);
      expect(first).toMatch(/group "1 of 2"/);
      expect(first).not.toMatch(new RegExp(`group "[^"]*${escape(gameTitle)}`));
      expect(first).not.toMatch(new RegExp(`img "[^"]*${escape(gameTitle)}`));
      await shot('hero-game');

      // Keyboard order: controls, then the visible slide's own link once; the slide that is out of view takes no focus.
      const stops = await tabOrder(page);
      expect(stops.filter(stop => stop === `a:${gameTitle}`), stops.join(' | ')).toHaveLength(1);
      expect(stops.some(stop => stop.includes(campaignTitle) && stop.startsWith('a:'))).toBe(false);
      expect(stops.findIndex(stop => stop.startsWith('button:'))).toBeLessThan(stops.indexOf(`a:${gameTitle}`));

      // The campaign slide: its heading once, its group's position, and the author's description once as its art's name.
      await stage.getByRole('button', { name: new RegExp(`^${escape(campaignTitle)} · 2 of 2$`) }).click();
      await expect(stage.getByRole('heading', { name: campaignTitle })).toBeVisible();
      await expect(stage.getByRole('img', { name: campaignAlt })).toHaveCount(1);
      // The screenshot shows the art itself, not the frame before it loads.
      await expect.poll(() => stage.getByRole('img', { name: campaignAlt }).evaluate(
        image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
      const second = await stage.ariaSnapshot();
      expect(headings(second, campaignTitle), second).toBe(1);
      expect(second).toMatch(/group "2 of 2"/);
      expect(count(second, new RegExp(`img "${escape(campaignAlt)}"`, 'g')), second).toBe(1);
      expect(headings(second, gameTitle)).toBe(0);
      await shot('hero-campaign');

      // The game's Work page: one heading for its title, and art that carries no second name for it.
      await page.goto(localizedPath(resourceHref('/w/', work), 'en'));
      const heading = page.getByRole('heading', { level: 1, name: gameTitle });
      await expect(heading).toHaveCount(1);
      await expect(page.locator('.work-hero')).toBeVisible();
      const hero = await page.locator('.work-hero').ariaSnapshot();
      expect(hero).not.toMatch(new RegExp(`img "[^"]*${escape(gameTitle)}`));
      expect(count(hero, /- img /g), hero).toBe(0);
      await shot('work-page');
    });
  }
}
