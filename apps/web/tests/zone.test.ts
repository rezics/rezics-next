import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  packageDigest,
  workCoverProps,
  ZONE_PACKAGE_BUDGET,
  zonePresets,
  type ZoneTokens,
  type ZoneWork,
} from '@rezics/zone-sdk';
import type { ReactNode } from 'react';
import { ZONE_PRESETS } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { coverProps } from '../features/catalogue/work.ts';
import { isoMoment, zoneWorkCards } from '../features/zones/adapt-cards.ts';
import { catalogueWork } from '../features/zones/card.tsx';
import { contrast, inkOn, mix, parseHex, readableOn, toHex } from '../features/zones/color.ts';
import { isZonePage, zoneCsp, zoneNonce } from '../features/zones/csp.ts';
import { decideExecution, isSafeMode, zoneLookEnabled } from '../features/zones/execution.ts';
import {
  defaultPresentation,
  feedOf,
  moduleTitle,
  placedModule,
  presetTokens,
  realmFeeds,
} from '../features/zones/presentation.ts';
import {
  accentRoles,
  auraSurfaces,
  weakestContrast,
  zoneScheme,
  zoneTheme,
} from '../features/zones/theme.ts';
import type { CopyButton } from '../zones/official/ai-workshop/copy-button.tsx';
import type { ShelfCarousel } from '../zones/official/books/carousel.tsx';

const web = join(import.meta.dir, '..');

/** What a server component may hand a client component: data and elements, never functions. */
type ServerSent = ReactNode | readonly ServerSent[] | { readonly [key: string]: ServerSent };
type TakesOnlyData<Component extends (props: never) => unknown> = Parameters<Component>[0] extends {
  readonly [key: string]: ServerSent;
}
  ? true
  : false;
// Slots render on the server; a function prop makes React refuse the client component.
const clientComponentsTakeData: [
  TakesOnlyData<typeof CopyButton>,
  TakesOnlyData<typeof ShelfCarousel>,
] = [true, true];

test('module titles keep configured copy when a translation is absent', () => {
  const module = {
    title: 'Series and volumes from the shared catalogue.',
    titles: { ja: 'シリーズと巻' },
  };
  expect(moduleTitle(module, 'en')).toBe(module.title);
  expect(moduleTitle(module, 'zh-Hant')).toBe(module.title);
  expect(moduleTitle(module, 'ja')).toBe(module.titles.ja);
});

describe('Zone color arithmetic', () => {
  test('WCAG contrast matches the reference values', () => {
    expect(contrast(parseHex('#000000'), parseHex('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(parseHex('#777777'), parseHex('#ffffff'))).toBeCloseTo(4.48, 2);
    expect(toHex(parseHex('#2f63ad'))).toBe('#2f63ad');
    expect(() => parseHex('red')).toThrow();
  });

  test('a derived tone keeps the accent when it already reads, and otherwise moves just far enough', () => {
    const light = [parseHex('#f9f6f2')];
    expect(toHex(readableOn(parseHex('#2f63ad'), light))).toBe('#2f63ad');
    const coral = readableOn(parseHex('#ff8674'), light);
    expect(contrast(coral, light[0]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(coral, light[0]!)).toBeLessThan(5.2);
    const dark = [parseHex('#0d1218')];
    expect(contrast(readableOn(parseHex('#7c3aed'), dark), dark[0]!)).toBeGreaterThanOrEqual(4.5);
  });

  test('text on a filled accent is white or dark ink, whichever reads better', () => {
    const ink = parseHex('#0b1626');
    expect(toHex(inkOn(parseHex('#2f63ad'), ink))).toBe('#ffffff');
    expect(toHex(inkOn(parseHex('#ffd84d'), ink))).toBe('#0b1626');
    expect(toHex(mix(parseHex('#000000'), 0, parseHex('#ffffff')))).toBe('#ffffff');
  });
});

describe('Zone themes', () => {
  const tokens = (accent: string, extra: Partial<ZoneTokens> = {}): ZoneTokens => ({
    ...presetTokens.clean,
    accent,
    ...extra,
  });

  test('every preset reads at WCAG AA in light and dark, on the page, the panels and filled buttons', () => {
    for (const preset of zonePresets) {
      const { light, dark } = weakestContrast(presetTokens[preset]);
      expect(light, `${preset} light`).toBeGreaterThanOrEqual(4.5);
      expect(dark, `${preset} dark`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('any accent a moderator picks is made readable, on any page surface and tint', () => {
    for (const accent of [
      '#ffff00',
      '#00ff00',
      '#ff0000',
      '#808080',
      '#000000',
      '#ffffff',
      '#0000ff',
      '#ff8674',
      '#1a1a2e',
    ]) {
      for (const surfaceTint of ['none', 'subtle', 'accent'] as const) {
        for (const pageSurface of ['flat', 'cards'] as const) {
          const { light, dark } = weakestContrast(tokens(accent, { surfaceTint, pageSurface }));
          expect(
            Math.min(light, dark),
            `${accent} ${surfaceTint} ${pageSurface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  test('the logo red is never used as it is for text; a red accent is darkened in light and lightened in dark', () => {
    const light = accentRoles(tokens('#df3d35'), 'light');
    const dark = accentRoles(tokens('#df3d35'), 'dark');
    expect(toHex(light.primary)).not.toBe('#df3d35');
    expect(toHex(dark.primary)).not.toBe('#df3d35');
  });

  test('Zones keep the shared visual language: only structure applies, never colour, scheme or type', () => {
    for (const preset of zonePresets) {
      const theme = zoneTheme(presetTokens[preset], { reader: 'system', enabled: true });
      expect(theme.className).toBe('zone-scope');
      expect(
        Object.keys(theme.style).filter((name) =>
          ['--primary', '--accent', '--ring', '--radius', '--zone-accent'].includes(name),
        ),
      ).toEqual([]);
      expect(theme.style).toMatchObject({
        '--zone-page': 'var(--background)',
        '--zone-heading-font': 'var(--font-interface)',
        '--zone-heading-scale': '1',
      });
    }
    const serial = zoneTheme(presetTokens.serial, { reader: 'light', enabled: true });
    expect([serial.style['--zone-panel'], serial.style['--zone-tiles']]).toEqual([
      'var(--card)',
      '6',
    ]);
    const standard = zoneTheme(presetTokens.serial, { reader: 'system', enabled: false });
    expect([standard.style['--zone-panel'], standard.style['--zone-panel-pad']]).toEqual([
      'transparent',
      '0px',
    ]);
  });

  test('a Zone that asks for its own look gets its tokens with a light and a dark value', () => {
    const themed = zoneTheme(presetTokens.serial, {
      reader: 'light',
      enabled: true,
      ownLook: true,
    });
    expect(themed.style['--primary']).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
    expect(themed.style['--zone-radius-card']).toBe('0.375rem');
    expect(
      zoneTheme(presetTokens.serial, { reader: 'light', enabled: false, ownLook: true }).style[
        '--primary'
      ],
    ).toBeUndefined();
  });

  test('a dark Zone darkens only for readers who follow the system; an explicit reader choice wins', () => {
    expect(zoneScheme(presetTokens.vibrant, 'system')).toBe('dark');
    expect(zoneScheme(presetTokens.vibrant, 'light')).toBeNull();
    expect(zoneScheme(presetTokens.editorial, 'system')).toBeNull();
    expect(
      zoneTheme(presetTokens.vibrant, { reader: 'system', enabled: true, ownLook: true }).className,
    ).toBe('zone-scope dark');
  });

  test('the surfaces themes derive against are Rezics Aura’s', () => {
    const css = readFileSync(join(web, '../../packages/ui/src/styles.css'), 'utf8');
    const [light, dark] = css.split('@variant dark');
    const value = (block: string, name: string) =>
      new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(block)?.[1];
    for (const [block, surface] of [
      [light!, auraSurfaces.light],
      [dark!, auraSurfaces.dark],
    ] as const) {
      expect(value(block, 'background')).toBe(surface.background);
      expect(value(block, 'card')).toBe(surface.card);
      expect(value(block, 'foreground')).toBe(surface.foreground);
      expect(value(block, 'primary-foreground')).toBe(surface.primaryForeground);
    }
  });

  test('presets are Main’s, so a preset looks the same wherever it is chosen', () => {
    expect(presetTokens).toEqual(ZONE_PRESETS);
  });
});

describe('Zone presentation', () => {
  const titles = {
    picks: 'Featured',
    latest: 'Latest',
    newChapters: 'New chapters',
    newlyAdded: 'Newly added',
    recentlyCompleted: 'Completed',
    rankings: 'Rankings',
    quotes: 'Quotes',
    rising: 'Rising',
    decisions: 'Decisions',
  };

  test('the default layout reads Main’s Realm module feeds and names its modules in the reader’s words', () => {
    const presentation = defaultPresentation(titles);
    expect(presentation.tokens).toEqual(presetTokens.clean);
    expect(presentation.modules.map((module) => module.type)).toEqual([
      'hero-carousel',
      'shelf',
      'ranking',
      'quote-stream',
      'rising',
      'decision-log',
    ]);
    const latest = presentation.modules.find((module) => module.id === 'latest')!;
    expect(latest.tabs?.map((tab) => feedOf(tab.source))).toEqual([
      'latest-chapters',
      'new-adoptions',
      'recently-completed',
    ]);
    // Sources without a Main read stay unresolved, so their modules are left off the page.
    expect(
      feedOf(presentation.modules.find((module) => module.type === 'ranking')!.source),
    ).toBeNull();
    expect(feedOf({ kind: 'collection', collection: 'https://rezics.com/id/x' })).toBeNull();
    expect(realmFeeds).toContain('recent-decisions');
  });

  test('a placed module takes its options, with covers and the main column by default', () => {
    expect(
      placedModule(
        {
          id: 'r',
          type: 'rising',
          title: 'Rising',
          source: { kind: 'query-block', block: 'x' },
          options: { rail: true },
        },
        '/en/r/x/works',
      ),
    ).toEqual({
      id: 'r',
      type: 'rising',
      title: 'Rising',
      rail: true,
      layout: 'covers',
      shuffle: false,
      more: '/en/r/x/works',
    });
  });
});

const zoneWorkKeys = [
  'id',
  'href',
  'title',
  'cover',
  'kind',
  'author',
  'authorHref',
  'tagline',
  'status',
  'chapters',
  'words',
  'updatedAt',
  'latestChapter',
  'decision',
  'hub',
  'showcaseArt',
] as const;
type ExactZoneWorkKeys<Keys extends readonly (keyof ZoneWork)[]> = [
  Exclude<keyof ZoneWork, Keys[number]>,
  Exclude<Keys[number], keyof ZoneWork>,
] extends [never, never]
  ? true
  : never;

describe('Zone Work cards from Main', () => {
  test('ZoneWork’s keys are the generic card', () => {
    const exact: ExactZoneWorkKeys<typeof zoneWorkKeys> = true;
    expect(exact).toBe(true);
    const work = {
      id: 'https://rezics.com/id/w',
      href: '/w/w',
      title: null,
      cover: null,
      kind: 'book',
      author: null,
      authorHref: null,
      tagline: null,
      status: null,
      chapters: null,
      words: null,
      updatedAt: null,
      latestChapter: null,
      decision: null,
      hub: null,
      showcaseArt: null,
    } satisfies ZoneWork;
    expect(Object.keys(work).sort()).toEqual([...zoneWorkKeys].sort());
  });

  test('a published prompt or Skill copies exactly its published text and shows only its disclosed excerpt', () => {
    const skill = {
      profile: 'hub-work-card-v1' as const,
      kind: 'skill-package' as const,
      declaredModels: ['model-a'],
      testedModels: [],
      preview: 'Groups reading notes by theme.',
      copyText: '---\nname: reading-notes\n---\n',
    };
    expect(zoneWorkCards({ hub: skill })).toEqual({
      hub: {
        kind: 'skill',
        preview: { value: 'Groups reading notes by theme.', lang: '', dir: 'ltr' },
        copyText: '---\nname: reading-notes\n---\n',
        testedModels: [],
      },
    });
    // Declared models are the author's intent, not a test; the card shows tested models only.
    expect(
      zoneWorkCards({ hub: { ...skill, kind: 'prompt', testedModels: ['model-b'] } }).hub,
    ).toMatchObject({ kind: 'prompt', testedModels: ['model-b'] });
  });

  test('a moment Eden revived as a Date crosses to the page as the ISO string the SDK promises', () => {
    expect(isoMoment(new Date('2026-09-28T04:27:33.000Z'))).toBe('2026-09-28T04:27:33.000Z');
    expect(isoMoment('soon')).toBeNull();
  });

  test('reads without a Hub card carry none', () => {
    expect(zoneWorkCards({})).toEqual({ hub: null });
  });
});

describe('Zone package execution', () => {
  const approved = { approved: { digest: 'sha256:abc' }, reason: 'none-approved' as const };
  const base = {
    main: approved,
    slug: 'fiction',
    installedDigest: 'sha256:abc',
    safeMode: false,
    lookEnabled: true,
  };

  test('a package runs only when Main approves exactly the bytes this build carries', () => {
    expect(decideExecution(base)).toEqual({ mode: 'package', slug: 'fiction' });
    expect(decideExecution({ ...base, installedDigest: 'sha256:def' })).toEqual({
      mode: 'fallback',
      reason: 'digest-mismatch',
    });
    expect(decideExecution({ ...base, installedDigest: null })).toEqual({
      mode: 'fallback',
      reason: 'not-installed',
    });
  });

  test('the reader’s opt-out and safe mode win over any approval', () => {
    expect(decideExecution({ ...base, lookEnabled: false })).toEqual({
      mode: 'fallback',
      reason: 'viewer-opt-out',
    });
    expect(decideExecution({ ...base, safeMode: true })).toEqual({
      mode: 'fallback',
      reason: 'safe-mode',
    });
    expect(isSafeMode({ safe: '' })).toBe(true);
    expect(isSafeMode({})).toBe(false);
    expect(zoneLookEnabled('standard')).toBe(false);
    expect(zoneLookEnabled(undefined)).toBe(true);
  });

  test('Main’s revocation, expiry or kill switch, and community Zones, always fall back', () => {
    for (const reason of ['revoked', 'expired', 'global-disabled', 'none-approved'] as const) {
      expect(decideExecution({ ...base, main: { approved: null, reason } })).toEqual({
        mode: 'fallback',
        reason,
      });
    }
    expect(decideExecution({ ...base, main: null })).toEqual({
      mode: 'fallback',
      reason: 'none-approved',
    });
    expect(decideExecution({ ...base, slug: null })).toEqual({
      mode: 'fallback',
      reason: 'none-approved',
    });
  });
});

describe('Zone page content security policy', () => {
  test('applies to localized Zone pages only', () => {
    expect(isZonePage('/en/z/fiction')).toBe(true);
    expect(isZonePage('/zh-Hans/z/0f0e0d0c-0b0a-4908-8706-050403020100/works')).toBe(true);
    expect(isZonePage('/r/fiction')).toBe(false);
    expect(isZonePage('/en/w/fiction')).toBe(false);
    expect(isZonePage('/en/r/')).toBe(false);
  });

  test('scripts need the per-response nonce; plugins, base rewrites and framing are refused', () => {
    const [first, second] = [zoneNonce(), zoneNonce()];
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9+/]{24}$/);
    expect(zoneCsp(first)).toBe(
      `script-src 'nonce-${first}' 'strict-dynamic'; object-src 'none'; base-uri 'none'; ` +
        "frame-ancestors 'none'; frame-src https://www.youtube-nocookie.com https://player.bilibili.com",
    );
    expect(zoneCsp(first, true)).toStartWith(
      `script-src 'nonce-${first}' 'strict-dynamic' 'unsafe-eval';`,
    );
  });
});

/** Every file of an official package, keyed by its path inside the package. */
function packageFiles(slug: string): Record<string, string> {
  const root = join(web, 'zones/official', slug);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return Object.fromEntries(
    walk(root).map((path) => [relative(root, path), readFileSync(path, 'utf8')]),
  );
}

const officialSlugs = readdirSync(join(web, 'zones/official')).filter((name) =>
  statSync(join(web, 'zones/official', name)).isDirectory(),
);

describe('Official Zone packages', () => {
  test('every installed official vertical ships its own package', () => {
    expect([...officialSlugs].sort()).toEqual([
      'ai-workshop',
      'books',
      'fiction',
      'franchise-wiki',
      'games',
      'light-novels',
      'mods',
      'software',
      'visual-novels',
    ]);
  });

  test.each(officialSlugs)(
    '%s imports only React, the SDK, Rezics UI, icons and its own files',
    (slug) => {
      for (const [path, source] of Object.entries(packageFiles(slug)).filter(([path]) =>
        /\.tsx?$/.test(path),
      )) {
        for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
          expect(specifier, `${slug}/${path}`).toMatch(
            /^(?:react|@rezics\/zone-sdk|@rezics\/ui\/[a-z-]+|lucide-react|\.\/[\w-]+\.(?:tsx?|json|css\?raw))$/,
          );
        }
      }
    },
  );

  test('slots render on the server, so a package’s client components take only data', () => {
    expect(clientComponentsTakeData).toEqual([true, true]);
    const clients = officialSlugs.flatMap((slug) =>
      Object.entries(packageFiles(slug))
        .filter(([, source]) => source.startsWith("'use client'"))
        .map(([path]) => `${slug}/${path}`),
    );
    // A new client component joins the type check above.
    expect(clients.sort()).toEqual(['ai-workshop/copy-button.tsx', 'books/carousel.tsx']);
  });

  test.each(officialSlugs)(
    '%s reaches no network, credentials, storage or dynamic code',
    (slug) => {
      const forbidden = [
        /\bfetch\s*\(/,
        /XMLHttpRequest/,
        /WebSocket/,
        /sendBeacon/,
        /document\.cookie/,
        /localStorage/,
        /sessionStorage/,
        /indexedDB/,
        /\beval\s*\(/,
        /new\s+Function/,
        /<script/i,
        /\/api\/main/,
        /https?:\/\//,
        /dangerouslySetInnerHTML/,
      ];
      for (const [path, source] of Object.entries(packageFiles(slug))) {
        for (const pattern of forbidden)
          expect(pattern.test(source), `${slug}/${path} matches ${pattern}`).toBe(false);
      }
    },
  );

  test.each(officialSlugs)('%s styles only its own Zone, inside the zone layer', (slug) => {
    const css = packageFiles(slug)
      [`${slug}.css`]!.replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    expect(css.startsWith(`@layer zone {\n  @scope ([data-zone="${slug}"]) {`)).toBe(true);
    // The layer and the scope close together at the end: no rule escapes them.
    expect(css.endsWith('}\n}')).toBe(true);
    const opened = css.indexOf('{', css.indexOf('@scope'));
    let depth = 0;
    for (const [index, char] of [...css].entries()) {
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      if (index > opened && index < css.length - 3) expect(depth).toBeGreaterThanOrEqual(2);
    }
  });

  test.each(officialSlugs)(
    '%s keeps REZICS’s colours and type: it names them only through platform properties',
    (slug) => {
      const css = packageFiles(slug)[`${slug}.css`]!.replace(/\/\*[\s\S]*?\*\//g, '');
      // Colours come from the platform's custom properties (mixed, at most), never as literals.
      expect(
        css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi) ?? [],
      ).toEqual([]);
      // Type is the interface face, the Work-title face or code; a package never brings its own.
      const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((match) =>
        match[1]!.trim(),
      );
      expect(
        families.filter(
          (family) =>
            !/^(?:inherit|var\(--(?:zone-heading-font|font-interface|font-work-serif|font-work-title|font-code)\))$/.test(
              family,
            ),
        ),
      ).toEqual([]);
      // The accent a Zone may one day ask for is not a colour any package relies on.
      expect(css).not.toContain('--zone-accent');
    },
  );

  test.each(officialSlugs)('%s stays within the size budget', (slug) => {
    const files = packageFiles(slug);
    const css = Object.entries(files)
      .filter(([path]) => path.endsWith('.css'))
      .map(([, text]) => text)
      .join('');
    const code = Object.entries(files)
      .filter(([path]) => /\.tsx?$/.test(path))
      .map(([, text]) => text)
      .join('');
    expect(gzipSync(css).byteLength).toBeLessThanOrEqual(ZONE_PACKAGE_BUDGET.cssGzipBytes);
    // Source, not the built chunk: a proxy until size-limit measures the build (see the handoff's proposed tasks).
    expect(gzipSync(code).byteLength).toBeLessThanOrEqual(ZONE_PACKAGE_BUDGET.jsGzipBytes);
  });

  test.each(officialSlugs)(
    '%s: `task zones:digest` prints the digest the web computes for its build',
    async (slug) => {
      const run = Bun.spawn(['bun', join(web, '../../scripts/zones/digest.ts'), slug], {
        stdout: 'pipe',
      });
      expect((await new Response(run.stdout).text()).trim()).toBe(
        await packageDigest(packageFiles(slug)),
      );
      expect(await run.exited).toBe(0);
    },
  );

  test('a package sets a Work’s cover exactly as the platform card does', () => {
    const id = 'https://rezics.com/id/0192f3a4-5b6c-7d8e-9f01-23456789abcd';
    const work = {
      id,
      href: '/w/w',
      kind: 'package' as const,
      status: null,
      chapters: null,
      words: null,
      updatedAt: null,
      decision: null,
      tagline: null,
      title: { value: 'Lumen', lang: 'en', dir: 'ltr' as const },
      author: { value: 'aurora', lang: '', dir: 'ltr' as const },
      cover: { url: '/api/main/v1/media/c?actingSubject=a', width: 600, height: 600 },
    };
    expect(workCoverProps(work)).toEqual({
      title: 'Lumen',
      lang: 'en',
      dir: 'ltr',
      authors: ['aurora'],
      kind: 'package',
      id,
      image: { src: '/api/main/v1/media/c?actingSubject=a', width: 600, height: 600 },
    });
    expect(coverProps(catalogueWork(work), '?actingSubject=a')).toEqual(workCoverProps(work));
    const bare = { ...work, title: null, author: null, cover: null };
    expect(workCoverProps(bare)).toMatchObject({ title: '', authors: [], image: null });
    expect(coverProps(catalogueWork(bare))).toEqual(workCoverProps(bare));
  });

  test.each(officialSlugs)('%s may size and tint a Work’s cover but never change it', (slug) => {
    for (const [path, source] of Object.entries(packageFiles(slug)).filter(([path]) =>
      path.endsWith('.tsx'),
    )) {
      for (const [element] of source.matchAll(/<WorkCover\b[^>]*>/g)) {
        expect(element, `${slug}/${path}`).toContain('{...workCoverProps(');
        // Spread props first and override only these: the face is the Work's.
        const own = element.split(/\{\.\.\.workCoverProps\([^)]*\)\}/)[1] ?? '';
        for (const [, prop] of own.matchAll(/\b([a-zA-Z]+)=/g)) {
          expect(
            ['size', 'loading', 'alt', 'className', 'style'],
            `${slug}/${path}: ${prop}`,
          ).toContain(prop);
        }
      }
    }
  });

  test('a package digest covers every byte and path, and nothing else', async () => {
    const files = packageFiles('fiction');
    const digest = await packageDigest(files);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await packageDigest(Object.fromEntries(Object.entries(files).reverse()))).toBe(digest);
    expect(await packageDigest({ ...files, 'fiction.css': `${files['fiction.css']} ` })).not.toBe(
      digest,
    );
    const [first] = Object.keys(files);
    const renamed = Object.fromEntries(
      Object.entries(files).map(([path, text]) => [path === first ? `x${path}` : path, text]),
    );
    expect(await packageDigest(renamed)).not.toBe(digest);
  });
});
