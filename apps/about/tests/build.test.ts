import { beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { copyStatus } from '../src/copy-status.ts';
import { features, featureIds, milestoneHorizon } from '../src/features.ts';
import { catalogs } from '../src/i18n/messages/index.ts';
import { localeDirection, uiLocales } from '../src/i18n/locales.ts';
import { pageIds, pagePath } from '../src/pages.ts';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');
const site = 'https://rezics.com';

beforeAll(() => {
  const build = Bun.spawnSync([join(root, '../../node_modules/.bin/astro'), 'build'], {
    cwd: root,
    // bun test sets NODE_ENV=test, which would build React's development runtime.
    env: { ...process.env, NODE_ENV: 'production' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (build.exitCode !== 0)
    throw new Error(`astro build failed:\n${build.stdout.toString()}\n${build.stderr.toString()}`);
}, 180_000);

const html = (path: string) => readFileSync(join(dist, path, 'index.html'), 'utf8');
const pages = pageIds.flatMap((page) =>
  uiLocales.map((locale) => ({ page, locale, path: pagePath(locale, page) })),
);

test('every page exists in every locale with its language and direction set', () => {
  expect(pages).toHaveLength(pageIds.length * uiLocales.length);
  for (const { page, locale, path } of pages) {
    const source = html(path);
    expect(source, path).toContain(`<html lang="${locale}" dir="${localeDirection[locale]}">`);
    expect(source.match(/<h1[ >]/g)?.length, `${path} h1`).toBe(1);
    expect(source, path).toMatch(
      new RegExp(`<main id="skip-nav-content"[^>]*data-copy="${copyStatus[page]}"`),
    );
  }
});

test('every page inherits its locale instead of marking translated copy as English', () => {
  for (const { path } of pages) {
    const main = html(path).match(/<main id="skip-nav-content"[^>]*>/)![0];
    expect(main, path).not.toContain(' lang=');
  }
});

test('each page has a canonical URL and hreflang alternates that point back at each other', () => {
  for (const { page, path } of pages) {
    const source = html(path);
    expect(source, path).toContain(`<link rel="canonical" href="${site}${path}">`);
    const alternates = [
      ...source.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g),
    ].map(([, lang, href]) => [lang, href]);
    expect(alternates.map(([lang]) => lang).sort(), path).toEqual(
      [...uiLocales, 'x-default'].sort(),
    );
    for (const [lang, href] of alternates) {
      expect(href, `${path} ${lang}`).toBe(
        `${site}${pagePath(lang === 'x-default' ? 'en' : lang!, page)}`,
      );
    }
    expect(source, path).toContain(`<meta property="og:locale" content=`);
    expect(source, path).toContain(
      `<meta property="og:image" content="${site}/og/${page === 'home' ? 'home' : page}.png">`,
    );
  }
});

test('titles and descriptions are unique per locale and page', () => {
  for (const locale of uiLocales) {
    const titles = new Set<string>();
    for (const page of pageIds) {
      const source = html(pagePath(locale, page));
      const title = source.match(/<title>([^<]+)<\/title>/)?.[1];
      expect(title, `${locale}/${page}`).toBeTruthy();
      expect(titles.has(title!), `${locale}/${page} title repeated`).toBe(false);
      titles.add(title!);
      expect(
        source.match(/<meta name="description" content="([^"]+)"/)?.[1],
        `${locale}/${page}`,
      ).toBeTruthy();
    }
  }
});

test('structured data parses: Organization everywhere, SoftwareApplication on Home', () => {
  for (const { page, path } of pages) {
    const blocks = [
      ...html(path).matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g),
    ].map(([, json]) => JSON.parse(json!) as { '@type': string });
    expect(
      blocks.map((block) => block['@type']),
      path,
    ).toEqual(page === 'home' ? ['Organization', 'SoftwareApplication'] : ['Organization']);
  }
});

/**
 * The site's islands and when each hydrates. The home page's Motion islands load when the
 * browser is idle, after the page has painted, so they are live before the reader reaches
 * them (the language record is set back to its original out of sight). The form loads when
 * it scrolls into view; pages without Motion islands download React only then.
 */
const islandLoading = {
  NotifyForm: 'visible',
  StoryDeck: 'idle',
  ListingInPlace: 'idle',
  PlaceInStory: 'idle',
} as const;

test('client JavaScript is islands plus one tiny boot script', () => {
  const inline = new Set<string>();
  for (const { path } of pages) {
    const source = html(path);
    const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    for (const [, attributes, body] of scripts) {
      if (attributes!.includes('application/ld+json')) continue;
      if (attributes!.includes('data-about-boot')) {
        inline.add(body!);
        continue;
      }
      // Astro's island bootstrap and the theme button's small inlined module.
      expect(
        ['astro-island', 'self.Astro', '[data-theme-toggle]'].some((marker) =>
          body!.includes(marker),
        ),
        `${path}: ${attributes}`,
      ).toBe(true);
    }
    const islands = [
      ...source.matchAll(/<astro-island[^>]*component-export="(\w+)"[^>]*client="(\w+)"/g),
    ].map(([, name, client]) => [name!, client!] as const);
    for (const [name, client] of islands) {
      expect(Object.keys(islandLoading), `${path}: ${name}`).toContain(name);
      expect(client, `${path}: ${name}`).toBe(islandLoading[name as keyof typeof islandLoading]);
    }
    if (path === pagePath('en', 'home'))
      expect(islands.map(([name]) => name).sort()).toEqual(Object.keys(islandLoading).sort());
  }
  expect(inline.size, 'one boot script for every page').toBe(1);
  expect([...inline][0]!.length).toBeLessThan(700);
});

test('JavaScript and CSS stay within budget', () => {
  const assets = readdirSync(join(dist, '_astro'));
  const size = (extension: string) =>
    assets
      .filter((name) => name.endsWith(extension))
      .reduce((sum, name) => sum + statSync(join(dist, '_astro', name)).size, 0);
  // All chunks together: React's client runtime (about 210 kB raw, 66 kB gzip), Motion's
  // gesture and layout features (about 130 kB raw, 43 kB gzip) and the islands. Pages
  // without Motion islands download React only when the notify form becomes visible.
  expect(size('.js')).toBeLessThan(480_000);
  expect(size('.css')).toBeLessThan(160_000);
});

test('only post-launch statements carry one localized Later label on every surface', () => {
  const seen = new Set<string>();
  for (const { path, locale } of pages) {
    const source = html(path);
    if (!path.endsWith('/roadmap/')) expect(source, path).not.toContain('data-horizon=');
    let labelCount = 0;
    for (const [, id, body] of source.matchAll(
      /<li[^>]*data-feature="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g,
    )) {
      expect(featureIds as string[], `${path} ${id}`).toContain(id!);
      seen.add(id!);
      const labels = [
        ...body!.matchAll(/<span[^>]*data-status="([^"]+)"[^>]*>([\s\S]*?)<\/span>/g),
      ];
      const later = features[id as keyof typeof features].status === 'later';
      expect(labels, `${path} ${id}`).toHaveLength(later ? 1 : 0);
      if (later) {
        labelCount++;
        expect(labels[0]![1]).toBe('later');
        expect(labels[0]![2]).toContain(catalogs.site[locale].status.later);
        expect(body).toContain(`title="${catalogs.site[locale].status.laterHelp}"`);
        expect(body).toContain(`lang="${locale}"`);
      }
    }
    // No stray labels may escape the feature components.
    expect([...source.matchAll(/data-status=/g)], path).toHaveLength(labelCount);
  }
  expect([...seen].sort()).toEqual([...featureIds].sort());
});

test('the roadmap groups launch stages separately from principles and post-launch claims', () => {
  for (const locale of uiLocales) {
    const source = html(pagePath(locale, 'roadmap'));
    const columns = new Map(
      [
        ...source.matchAll(
          /data-roadmap-column="(\w+)">([\s\S]*?)(?=<div data-roadmap-column|<div class="mt-20")/g,
        ),
      ].map(([, key, body]) => [key, body!]),
    );
    const afterLaunch = source.split('data-after-launch')[1]!;
    expect(afterLaunch, locale).toBeDefined();
    for (const id of featureIds) {
      const entry = features[id];
      if (entry.milestone) {
        const horizon = milestoneHorizon[entry.milestone];
        expect(columns.get(horizon), `${locale} ${horizon}`).toContain(`data-feature="${id}"`);
        expect(afterLaunch).not.toContain(`data-feature="${id}"`);
      } else if (entry.status === 'later') {
        expect(afterLaunch).toContain(`data-feature="${id}"`);
        for (const body of columns.values()) expect(body).not.toContain(`data-feature="${id}"`);
      } else {
        expect(source).not.toContain(`data-feature="${id}"`);
      }
    }
  }
});

test('sitemap, robots and share images exist', () => {
  const sitemap = readFileSync(join(dist, 'sitemap.xml'), 'utf8');
  expect(sitemap.match(/<loc>/g)).toHaveLength(pages.length);
  expect(sitemap.match(/hreflang="x-default"/g)).toHaveLength(pages.length);
  expect(sitemap).toContain('<loc>https://rezics.com/zh-Hant/reading/</loc>');
  const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
  expect(robots).toContain('Sitemap: https://rezics.com/sitemap.xml');
  for (const page of pageIds) {
    const file = join(dist, 'og', `${page === 'home' ? 'home' : page}.png`);
    expect(existsSync(file), file).toBe(true);
    const png = readFileSync(file);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  }
});

test('the confirmation page is not indexed and the root falls back to English', () => {
  for (const locale of uiLocales) {
    const source = html(`/${locale}/notified/`);
    expect(source).toContain('<meta name="robots" content="noindex">');
    expect(source).not.toContain('rel="canonical"');
  }
  expect(readFileSync(join(dist, 'index.html'), 'utf8')).toContain('url=/en/');
  expect(readFileSync(join(dist, '404.html'), 'utf8')).toContain('noindex');
});
