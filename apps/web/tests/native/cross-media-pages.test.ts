import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { expect as visible } from 'playwright/test';

type Reading = {
  source: string;
  externalId: string;
  selection: 'selected' | 'proposed';
  route: string;
  subject: { subject: { id: string } };
};
type Seed = {
  status: string;
  readings: Reading[];
  members: { source: string; key: string; kind: string; franchise?: string }[];
};
type Visit = {
  origin: string;
  cdp: string;
  contextIndex: number;
  seedResult: string;
  realms: { anime: string; visualNovel: string };
  destinations: { library: string; collection: string; thread: string; settings: string; creatorSales: string };
  /** Selected statement identities from the real native admission, including incoming directions and qualifiers. */
  edges: { from: string; property: string; direction: 'in' | 'out'; to: string; qualifiers: string[] }[];
};

/** Reuse the live capture's browser/session and authentic producer result; never provision a substitute seed. */
test('mounted seeded franchises remain connected through Home, both Realms, works, characters and people, then capture the core pages', async () => {
  const input = Bun.env.REZICS_CROSS_MEDIA_VISIT;
  if (!input) throw new Error('REZICS_CROSS_MEDIA_VISIT must name the live native visit configuration');
  const visit = (await Bun.file(input).json()) as Visit;
  const seed = (await Bun.file(visit.seedResult).json()) as Seed;
  expect(['imported', 'imported-with-gaps']).toContain(seed.status);
  expect(visit.edges.length).toBeGreaterThan(0);
  const selected = new Map(
    seed.readings
      .filter((reading) => reading.selection === 'selected')
      .map((reading) => [`${reading.source}:${reading.externalId}`, reading]),
  );
  const members = seed.members.map((member) => ({
    ...member,
    reading: selected.get(`${member.source}:${member.key}`),
  }));
  const works = members.filter((member) => member.kind === 'work' && member.franchise);
  expect(works.length).toBeGreaterThan(3);
  for (const member of works) expect(member.reading).toBeDefined();
  const character = members.find((member) => member.kind === 'character' && member.reading)?.reading;
  const person = members.find((member) => member.kind === 'person' && member.reading)?.reading;
  expect(character).toBeDefined();
  expect(person).toBeDefined();
  const workByFranchise = ['steins-gate', 'clannad', 'fate'].map((franchise) => {
    const reading = works.find((member) => member.franchise === franchise)?.reading;
    if (!reading) throw new Error(`No selected native work for ${franchise}`);
    return { franchise, reading };
  });
  const destination = (path: string) => {
    const url = new URL(path.startsWith('/en/') ? path : `/en${path}`, visit.origin);
    if (url.origin !== new URL(visit.origin).origin)
      throw new Error('Capture destination must belong to the mounted app');
    return url.href;
  };
  const browser = await chromium.connectOverCDP(visit.cdp);
  const context = browser.contexts()[visit.contextIndex];
  if (!context) throw new Error('The retained native browser context is unavailable');
  const originalTheme = (await context.cookies(visit.origin)).filter((cookie) => cookie.name === 'rezics_theme');
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  async function open(path: string) {
    const response = await page.goto(destination(path), { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
    await visible(page.locator('main')).toBeVisible();
  }
  try {
    for (const path of ['/', visit.realms.anime, visit.realms.visualNovel]) {
      await open(path);
      // Home uses Search TypeLists; Realms use their independently authorized native publication shelf.
      const lists = page.locator(
        path === '/' ? '[data-slot="type-list"]' : '[aria-labelledby="realm-published-heading"]',
      );
      await visible(lists.first()).toBeVisible();
      expect(await lists.locator('a[href*="/subjects/"]').count()).toBeGreaterThan(0);
    }
    const readings = [...works.map((member) => member.reading!), character!, person!];
    const ids = new Set(readings.map((reading) => reading.subject.subject.id));
    for (const edge of visit.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
    for (const reading of readings) {
      await open(reading.route);
      const connections = page.locator('[data-slot="subject-connections"]');
      await visible(connections).toBeVisible();
      for (const edge of visit.edges.filter((edge) => edge.from === reading.subject.subject.id)) {
        const key = `${edge.direction}:${edge.property}${edge.filter ? ':qualified' : ''}`;
        if (edge.filter) expect(edge.filter).toBe(reading.subject.subject.id);
        const option = connections.locator(`option[value="${key}"]`);
        await visible(option.first()).toBeAttached();
        const selector = option.first().locator('..');
        await selector.selectOption(key);
        const section = selector.locator('xpath=ancestor::section[1]');
        await visible(section.locator(`a[href*="/subjects/${edge.to}/"]`).first()).toBeVisible();
        for (const qualifier of edge.qualifiers) await visible(section).toContainText(qualifier);
      }
      const link = connections.locator('a[href*="/subjects/"][href*="via="]').first();
      if (await link.count()) {
        await link.click();
        const back = page.getByRole('link', { name: 'Return to the previous destination' });
        await visible(back).toBeVisible();
        await back.click();
        await visible(page.locator('[data-slot="subject-connections"]')).toBeVisible();
        expect(new URL(page.url()).hash).toBe('#connections');
      }
    }
    // Last product step: one retained capture, the mounted app and real admitted destinations, four views each.
    const pages = [
      ['home', '/'],
      ['anime-realm', visit.realms.anime],
      ['visual-novel-realm', visit.realms.visualNovel],
      ...workByFranchise.map(({ franchise, reading }) => [`work-${franchise}`, reading.route]),
      ['character', character!.route],
      ['person', person!.route],
      ['search', '/search'],
      ['library', visit.destinations.library],
      ['collection', visit.destinations.collection],
      ['board-thread', visit.destinations.thread],
      ['settings', visit.destinations.settings],
      ['creator-sales', visit.destinations.creatorSales],
    ];
    const directory = resolve(import.meta.dir, '../../../../.temp/screenshots/core');
    await mkdir(directory, { recursive: true });
    for (const [index, [name, path]] of pages.entries())
      for (const width of [390, 1440])
        for (const theme of ['light', 'dark'] as const) {
          await context.addCookies([{ name: 'rezics_theme', value: theme, url: visit.origin }]);
          await page.setViewportSize({ width, height: 1000 });
          await page.emulateMedia({ colorScheme: theme });
          await open(path!);
          await visible(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
          await page.evaluate(() => document.fonts.ready);
          const screenshot = resolve(directory, `${String(index + 1).padStart(2, '0')}-${name}-${width}-${theme}.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          console.info(screenshot);
        }
  } finally {
    await context.clearCookies({ name: 'rezics_theme' });
    if (originalTheme.length) await context.addCookies(originalTheme);
    await page.close();
    // The live browser, native services, session and capture handle remain owned by their original caller.
  }
}, 900_000);
