import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { compile } from 'tailwindcss';
import type { ListPresentation } from '@rezics/ui/cover';
import type { Item, RowValue } from '../src/features/pages/overview';
import type { Fact } from '../src/search/results';

const app = join(import.meta.dir, '..');
const root = join(app, '../..');
const realm = 'realm/reading + credits';
const contextQuery = '?realm=realm%2Freading+%2B+credits';
const label = '作品と出演者';
type Props = {
  items: Item[];
  value: Omit<RowValue, 'link'>;
  label: string;
  preview: boolean;
  memberFacts: Record<string, Record<string, Fact[]>>;
  presentations: Record<string, ListPresentation>;
};
type MountedWindow = Window & {
  mountCoverList(props: Props): void;
  coverDestinations: string[];
};
const value: Props['value'] = {
  locale: 'en',
  ratio: '2:3',
  reader: { spoilerLevel: 0, suitability: 'blur' },
  labels: {
    spoilerShow: 'Show spoiler',
    documentSpoiler: 'Reveal passage',
    cover: { withheld: 'Sensitive cover', reveal: 'Show cover', credit: 'Cover credit', via: 'via' },
  },
  unlabelled: 'Unlabelled',
  spoilerShow: 'Show spoiler',
  context: { id: 'selected-context', population: { kind: 'realm', id: realm, title: 'Reading community' } },
};
const book: Item = {
  id: 'book',
  label: { text: '雪国', lang: 'ja' },
  type: 'schema:Book',
  statement: 'book-first',
  notes: ['First appearance'],
  gated: false,
  summary: {
    id: 'book',
    type: 'schema:Book',
    cover: {
      media: 'sensitive-cover',
      width: 600,
      height: 800,
      placeholder: { color: '#465c72', thumbhash: '' },
      variants: [{ format: 'webp', width: 600 }],
      focalPoint: null,
      credit: null,
      withheld: 'suitability',
    },
  },
};
const ordinary: Item[] = [
  book,
  { ...book, statement: 'book-second', notes: ['Second appearance'] },
  {
    id: 'movie',
    label: { text: 'Un viaje al río', lang: 'es' },
    type: 'schema:Movie',
    statement: 'movie-first',
    notes: ['Restored edition'],
    gated: false,
  },
  {
    id: 'secret',
    label: { text: 'Hidden performer', lang: 'en' },
    type: 'type:Unknown',
    statement: 'secret-first',
    notes: ['Secret note'],
    gated: true,
  },
];
const memberFacts: Props['memberFacts'] = {
  book: {
    'schema:datePublished': [{ kind: 'time', year: 1948 }],
    'schema:author': [{ kind: 'item', id: 'author', labels: { ja: '川端康成' } }],
    'schema:unselected': [{ kind: 'code', value: 'Unselected fact' }],
  },
  movie: { 'schema:duration': [{ kind: 'quantity', amount: 90, unit: 'min' }] },
};
const presentations: Props['presentations'] = {
  'schema:Book': { imageAspect: 'portrait', keyFacts: ['schema:author', 'schema:datePublished'] },
  'schema:Movie': { imageAspect: 'landscape', keyFacts: ['schema:duration'] },
};
const ordinaryDestinations = [
  `/en/subjects/book/雪国${contextQuery}`,
  `/en/subjects/book/雪国${contextQuery}`,
  `/en/subjects/movie/un-viaje-al-río${contextQuery}`,
];

async function componentBundle() {
  const result = await Bun.build({
    entrypoints: ['cover-list-fixture'],
    target: 'browser',
    format: 'iife',
    plugins: [
      {
        name: 'mounted-cover-list',
        setup(build) {
          build.onResolve({ filter: /^cover-list-fixture$/ }, () => ({ path: 'entry', namespace: 'cover-list' }));
          build.onLoad({ filter: /.*/, namespace: 'cover-list' }, () => ({
            loader: 'tsx',
            resolveDir: app,
            contents: `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { flushSync } from 'react-dom';
            import { CoverList } from ${JSON.stringify(join(app, 'src/features/pages/cover-list.tsx'))};
            import { setLocale } from ${JSON.stringify(join(app, 'src/paraglide/runtime.js'))};
            setLocale('en', { reload: false });
            window.coverDestinations = [];
            function Link({ children, ...props }) {
              return <a {...props} data-custom-link="true" onClick={event => {
                event.preventDefault();
                window.coverDestinations.push(event.currentTarget.getAttribute('href'));
              }}>{children}</a>;
            }
            const root = createRoot(document.getElementById('app'));
            window.mountCoverList = ({ presentations, ...props }) => flushSync(() => root.render(
              <CoverList {...props} value={{ ...props.value, link: Link }}
                listPresentationFor={types => types.map(type => presentations[type]).find(Boolean)} />
            ));
          `,
          }));
        },
      },
    ],
  });
  expect(result.success, result.logs.map(String).join('\n')).toBe(true);
  return result.outputs[0]!.text();
}

// Generate the real utilities used by the delivered components, including the default sm breakpoint.
// No replacement CSS, component stubs, server, catalogue fetch or per-row hydration is involved.
async function componentStyles() {
  const files = [
    'apps/web/src/features/pages/cover-list.tsx',
    'packages/ui/src/components/cover-card.tsx',
    'packages/ui/src/components/content-item.tsx',
    'packages/ui/src/components/list-row.tsx',
    'packages/ui/src/components/cover.tsx',
  ];
  const sources = await Promise.all(files.map((path) => Bun.file(join(root, path)).text()));
  const [theme, preflight] = await Promise.all([
    Bun.file(Bun.resolveSync('tailwindcss/theme.css', app)).text(),
    Bun.file(Bun.resolveSync('tailwindcss/preflight.css', app)).text(),
  ]);
  const compiler = await compile(`${theme}\n${preflight}\n@tailwind utilities;`);
  return compiler.build(sources.flatMap((source) => source.match(/[^\s"'`{}]+/g) ?? []));
}

async function mount(page: Page, items: Item[], preview: boolean) {
  await page.evaluate((props) => (window as MountedWindow).mountCoverList(props), {
    items,
    value,
    label,
    preview,
    memberFacts,
    presentations,
  });
}

// Authored for integration; UNRUN under MINIMAL. This is mounted browser coverage, not native producer proof.
test('Named semantic Subject cover lists across preview and full views', async () => {
  const [bundle, css] = await Promise.all([componentBundle(), componentStyles()]);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.route('https://rezics.test/en/subject-test', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html lang="en"><body><button id="start">Start</button><main id="app"></main><button id="end">End</button></body></html>',
      }),
    );
    await page.goto('https://rezics.test/en/subject-test');
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle });
    for (const preview of [false, true]) {
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        // A fresh mount also resets each responsive copy's spoiler state.
        await mount(page, [], preview);
        await mount(page, ordinary, preview);
        const list = page.getByRole('list', { name: label, exact: true });
        expect(await list.count()).toBe(1);
        expect(await page.getByRole('list').count()).toBe(1);
        const rows = list.getByRole('listitem');
        expect(await rows.count()).toBe(ordinary.length);
        expect(await rows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-statement')))).toEqual(
          ordinary.map((item) => item.statement),
        );
        expect(await list.locator('[role="listitem"] [role="listitem"], li').count()).toBe(0);
        const titles = list.getByRole('link');
        expect(await titles.evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual(
          ordinaryDestinations,
        );
        expect(await titles.evaluateAll((links) => links.map((link) => link.getAttribute('lang')))).toEqual([
          'ja',
          'ja',
          'es',
        ]);
        expect(await list.getByRole('heading', { level: 3 }).allTextContents()).toEqual([
          '雪国',
          '雪国',
          'Un viaje al río',
        ]);
        expect(await list.locator('h3[lang="ja"] > a[data-custom-link="true"]').count()).toBe(2);
        for (const index of [0, 1]) {
          expect(await rows.nth(index).locator('[data-property]').allTextContents()).toEqual(['川端康成', '1948']);
          expect(await rows.nth(index).locator('[data-property="schema:author"]').getAttribute('lang')).toBe('ja');
          expect(await rows.nth(index).textContent()).toContain(index === 0 ? 'First appearance' : 'Second appearance');
        }
        expect(await rows.nth(2).textContent()).toContain('90 min');
        expect(await rows.nth(2).textContent()).toContain('Restored edition');
        expect(
          await list
            .locator('[data-slot="cover"]')
            .evaluateAll((covers) => covers.map((cover) => cover.getAttribute('data-ratio'))),
        ).toEqual(['3:4', '3:4', '16:9']);
        expect(await list.getByRole('button', { name: 'Show cover' }).count()).toBe(2);
        expect(await list.locator('img, source').count()).toBe(0);
        expect(await list.textContent()).not.toContain('Unselected fact');
        expect(await page.getByRole('link', { name: 'Hidden performer' }).count()).toBe(0);
        expect(await page.getByText('Secret note', { exact: true }).count()).toBe(0);

        const layout = preview && width === 390 ? 'cover-row' : 'cover-grid';
        expect(await list.getAttribute('data-layout')).toBe(layout);
        const container = list.locator(`[data-slot="${layout}"]`);
        expect(await container.locator(':scope > [role="listitem"]').count()).toBe(ordinary.length);
        expect(await container.evaluate((element) => getComputedStyle(element).display)).toBe(
          layout === 'cover-row' ? 'flex' : 'grid',
        );
        if (layout === 'cover-row') {
          expect(await container.getAttribute('tabindex')).toBe('0');
          expect(await container.evaluate((element) => getComputedStyle(element).scrollSnapType)).toBe('x mandatory');
          expect(await rows.first().evaluate((element) => getComputedStyle(element).scrollSnapAlign)).toBe('start');
          expect(await rows.first().evaluate((element) => getComputedStyle(element).flexShrink)).toBe('0');
          expect(
            await container.evaluate((element) =>
              Math.abs(element.children[0]!.getBoundingClientRect().width - (element.clientWidth - 16) / 3),
            ),
          ).toBeLessThan(1);
        }
        // Traverse the actual tab order: neither hidden responsive links nor their scroll region can be reached.
        await page.locator('#start').focus();
        const visited: (string | null)[] = [];
        let reachedEnd = false;
        for (let step = 0; step < 20; step++) {
          await page.keyboard.press('Tab');
          const focused = await page.evaluate(() => ({
            end: document.activeElement?.id === 'end',
            layout: document.activeElement?.closest('[data-layout]')?.getAttribute('data-layout'),
            href: document.activeElement?.matches('[data-slot="cover-card-title"]')
              ? document.activeElement.getAttribute('href')
              : undefined,
          }));
          if (focused.end) {
            reachedEnd = true;
            break;
          }
          expect(focused.layout).toBe(layout);
          if (focused.href !== undefined) visited.push(focused.href);
        }
        expect(reachedEnd).toBe(true);
        expect(visited).toEqual(ordinaryDestinations);
        await titles.first().focus();
        await page.keyboard.press('Enter');
        expect(await page.evaluate(() => (window as MountedWindow).coverDestinations.pop())).toBe(
          ordinaryDestinations[0],
        );
        await list.getByRole('button', { name: 'Show spoiler', exact: true }).click();
        expect(await list.getByRole('link', { name: 'Hidden performer', exact: true }).getAttribute('href')).toBe(
          `/en/subjects/secret/hidden-performer${contextQuery}`,
        );
        expect(await rows.nth(3).textContent()).toContain('Secret note');
        expect(await rows.nth(3).locator('[data-slot="cover"]').getAttribute('data-ratio')).toBe('2:3');
        await list.getByRole('button', { name: 'Hide spoilers', exact: true }).click();
        await list.getByRole('link', { name: 'Hidden performer', exact: true }).waitFor({ state: 'hidden' });
      }
    }

    const credit: Item = {
      id: 'performer',
      label: { text: 'Alex Player', lang: 'en' },
      type: 'schema:Person',
      statement: 'credit-first',
      notes: ['Original cast'],
      gated: false,
      qualified: [
        { property: 'schema:position', text: 'Order: 2' },
        { property: 'wdt:P3831', text: 'Role: Narrator', subject: { id: 'role', label: 'Narrator' } },
        { property: 'wdt:P1932', text: 'Credited as: 語り手', language: 'ja' },
        {
          property: 'wdt:P453',
          text: 'Character: The Traveller',
          subject: { id: 'character', label: 'The Traveller' },
        },
      ],
    };
    const mixed = [
      book,
      credit,
      { ...credit, statement: 'credit-second', notes: ['Additional voices'] },
      {
        ...ordinary[3]!,
        qualified: [
          { property: 'schema:position', text: 'Order: 9' },
          {
            property: 'wdt:P453',
            text: 'Character: Secret traveller',
            subject: { id: 'secret-character', label: 'Secret traveller' },
          },
        ],
      },
    ];
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await mount(page, [], true);
      await mount(page, mixed, true);
      const list = page.getByRole('list', { name: label, exact: true });
      expect(await list.count()).toBe(1);
      expect(await list.evaluate((element) => element.tagName)).toBe('UL');
      const rows = list.locator(':scope > li');
      expect(await rows.count()).toBe(mixed.length);
      expect(
        await rows
          .locator('[data-statement]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-statement'))),
      ).toEqual(mixed.map((item) => item.statement));
      expect(await list.locator('[role="list"], [role="listitem"]').count()).toBe(0);
      expect(await page.locator('ul > :not(li), a a, a button, [data-layout]').count()).toBe(0);
      expect(await rows.first().locator('[data-property]').allTextContents()).toEqual(['川端康成', '1948']);
      expect(await rows.nth(1).getByRole('listitem').allTextContents()).toEqual([
        'Original cast',
        'Order: 2',
        'Role: Narrator',
        'Credited as: 語り手 Japanese',
        'Character: The Traveller',
      ]);
      expect(await rows.nth(2).textContent()).toContain('Additional voices');
      expect(await rows.nth(1).locator('[lang="ja"]').textContent()).toBe('Credited as: 語り手');
      for (const index of [1, 2]) {
        const row = rows.nth(index);
        for (const [name, destination] of [
          ['Alex Player', `/en/subjects/performer/alex-player${contextQuery}`],
          ['Role: Narrator', `/en/subjects/role/narrator${contextQuery}`],
          ['Character: The Traveller', `/en/subjects/character/the-traveller${contextQuery}`],
        ]) {
          const link = row.getByRole('link', { name, exact: true });
          expect(await link.getAttribute('href')).toBe(destination);
          expect(await link.getAttribute('data-custom-link')).toBe('true');
          await link.focus();
          await page.keyboard.press('Enter');
          expect(await page.evaluate(() => (window as MountedWindow).coverDestinations.pop())).toBe(destination);
        }
      }
      expect(await list.getByRole('link', { name: 'Hidden performer' }).count()).toBe(0);
      expect(await list.getByRole('link', { name: 'Character: Secret traveller' }).count()).toBe(0);
      await list.getByRole('button', { name: 'Show spoiler', exact: true }).click();
      expect(await rows.nth(3).getByRole('link', { name: 'Hidden performer' }).getAttribute('href')).toBe(
        `/en/subjects/secret/hidden-performer${contextQuery}`,
      );
      expect(await rows.nth(3).textContent()).toContain('Secret note');
      const secretCharacter = rows.nth(3).getByRole('link', { name: 'Character: Secret traveller', exact: true });
      expect(await secretCharacter.getAttribute('href')).toBe(
        `/en/subjects/secret-character/secret-traveller${contextQuery}`,
      );
      await secretCharacter.focus();
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => (window as MountedWindow).coverDestinations.pop())).toBe(
        `/en/subjects/secret-character/secret-traveller${contextQuery}`,
      );
      await list.getByRole('button', { name: 'Hide spoilers', exact: true }).click();
      await secretCharacter.waitFor({ state: 'hidden' });
    }
    expect(requests).toEqual([]);
  } finally {
    await browser.close();
  }
}, 60_000);
