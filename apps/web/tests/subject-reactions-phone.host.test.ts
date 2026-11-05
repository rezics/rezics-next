import { expect, test } from 'bun:test';

import {
  createSubjectReactionPages,
  createThreadReactionPages,
  post,
  subjectPath,
  threadPath,
  thread,
} from './support/reaction-pages';

const { open, reset } = await createSubjectReactionPages();
const crowdedThread = thread(2, 'A shared reading');
crowdedThread.thread.reactions = { upvote: 9, downvote: 8, like: 7, love: 6, laugh: 5, insightful: 4, sad: 3 };
const { open: openThread } = await createThreadReactionPages({
  calls: [],
  refusal: undefined,
  releaseRefusal: undefined,
  reactionGate: undefined,
  current: crowdedThread,
  posts: {
    posts: [
      {
        ...post(12),
        reactions: { upvote: 9, downvote: 8, like: 7, love: 6, laugh: 5, insightful: 4, sad: 3 },
        viewerReaction: 'sad',
      },
    ],
    next: null,
  },
});

const kinds = { like: 9, love: 8, laugh: 7, insightful: 6, sad: 5 };
const timeout = 300_000;
const pathFor = (locale: string) => `/${locale}${subjectPath.slice(3)}`;

async function insideViewport(page: import('playwright').Page, locator: import('playwright').Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
}

test(
  'subject reactions and their menu stay inside the phone viewport in both locales and session states',
  async () => {
    for (const locale of ['en', 'zh-Hans']) {
      for (const signedIn of [true, false]) {
        for (const counts of [{}, kinds]) {
          reset(counts, counts === kinds ? 'sad' : null);
          const { page } = await open(pathFor(locale), { width: 390, signedIn });
          try {
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
            const actions = page.locator('[data-slot="subject-header-actions"]');
            const reactions = actions.locator('[data-slot="reactions"]');
            const chips = reactions.locator('[data-slot="reaction-chip"]:visible');
            for (let index = 0; index < (await chips.count()); index += 1) await insideViewport(page, chips.nth(index));
            const react = reactions.locator('a, button').filter({ hasText: /React|表态/ });
            const reactButton = react.first();
            await insideViewport(page, reactButton);
            const menu = actions.locator(':scope > div:last-child button');
            await insideViewport(page, menu);
            expect(await reactions.evaluate((node) => getComputedStyle(node).flexWrap)).toBe('wrap');
            const reactionsBox = (await reactions.boundingBox())!;
            const menuBox = (await menu.boundingBox())!;
            const actionsBox = (await actions.boundingBox())!;
            expect(Math.abs(menuBox.y - reactionsBox.y)).toBeLessThanOrEqual(2);
            expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(actionsBox.x + actionsBox.width + 1);
          } finally {
            await page.context().close();
          }
        }
      }
    }
  },
  timeout,
);

test(
  'subject actions keep the reaction cluster and overflow menu at the top right on desktop',
  async () => {
    reset(kinds, 'sad');
    const { page } = await open(pathFor('en'), { width: 1280 });
    try {
      const header = page.locator('main header');
      const actions = header.locator('[data-slot="subject-header-actions"]');
      const reactions = actions.locator('[data-slot="reactions"]');
      const react = reactions.locator('button').filter({ hasText: 'React' });
      const menu = actions.locator(':scope > div:last-child button');
      const reactBox = (await react.boundingBox())!;
      const menuBox = (await menu.boundingBox())!;
      const headerBox = (await header.boundingBox())!;
      expect(Math.abs(reactBox.y - menuBox.y)).toBeLessThanOrEqual(2);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width + 1);
      expect(menuBox.x).toBeGreaterThan(headerBox.x + headerBox.width / 2);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'phone reaction and overflow menus stay reachable by keyboard and inside the viewport',
  async () => {
    reset(kinds, 'sad');
    const { page } = await open(pathFor('en'), { width: 390 });
    try {
      const actions = page.locator('[data-slot="subject-header-actions"]');
      const reactions = actions.locator('[data-slot="reactions"]');
      const react = reactions.getByRole('button', { name: 'React', exact: true });
      await react.click();

      const picker = page.locator('[data-slot="drawer-popup"]:visible, [data-slot="dropdown-menu-content"]:visible');
      const popupState = await react.evaluate((node) => ({
        trigger: node.outerHTML,
        width: window.innerWidth,
        phoneMedia: window.matchMedia('(max-width: 767px)').matches,
        popups: Array.from(
          document.querySelectorAll('[data-slot="drawer-popup"], [data-slot="dropdown-menu-content"], [role="dialog"]'),
        ).map((popup) => ({
          slot: popup.getAttribute('data-slot'),
          role: popup.getAttribute('role'),
          hidden: (popup as HTMLElement).hidden,
          display: getComputedStyle(popup).display,
          ariaHidden: popup.getAttribute('aria-hidden'),
        })),
      }));
      await picker.waitFor({ state: 'visible' }).catch(() => {
        throw new Error(`Reaction picker did not open: ${JSON.stringify(popupState)}`);
      });
      expect(await picker.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      const choices = picker.getByRole('button');
      for (let index = 0; index < (await choices.count()); index += 1) await insideViewport(page, choices.nth(index));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.keyboard.press('Escape');
      await picker.waitFor({ state: 'hidden' });
      const reactHandle = await react.elementHandle();
      await page.waitForFunction((element) => document.activeElement === element, reactHandle);

      const menu = actions.locator(':scope > div:last-child button');
      await page.keyboard.press('Tab');
      expect(await menu.evaluate((node) => node === document.activeElement)).toBe(true);
      await menu.click();
      const overflow = page.locator('[data-slot="drawer-popup"]:visible, [data-slot="dropdown-menu-content"]:visible');
      await overflow.waitFor({ state: 'visible' });
      expect(await overflow.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      const menuItems = overflow.getByRole('button');
      for (let index = 0; index < (await menuItems.count()); index += 1)
        await insideViewport(page, menuItems.nth(index));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.keyboard.press('Escape');
      await overflow.waitFor({ state: 'hidden' });
      const menuHandle = await menu.elementHandle();
      await page.waitForFunction((element) => document.activeElement === element, menuHandle);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a thread post reaction row stays within a 390 px viewport',
  async () => {
    const { page } = await openThread(threadPath(), false);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const reactions = page.locator('main ol > li').first().getByRole('group', { name: 'Reactions' });
      await reactions.waitFor({ state: 'visible' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      const box = (await reactions.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(391);
      expect(await reactions.evaluate((node) => getComputedStyle(node).flexWrap)).toBe('wrap');
      const chips = reactions.locator('[data-slot="reaction-chip"]:visible');
      expect(await chips.count()).toBe(7);
      const rows = new Set<number>();
      for (let index = 0; index < (await chips.count()); index += 1) {
        const chip = chips.nth(index);
        await insideViewport(page, chip);
        rows.add(Math.round((await chip.boundingBox())!.y));
      }
      const react = reactions.locator('a, button').filter({ hasText: 'React' }).first();
      await insideViewport(page, react);
      expect(rows.size).toBeGreaterThan(1);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
