import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import { compile } from 'tailwindcss';
import { planReads, platformRegistry, type CompositionDocument, type SelectedContext } from '@rezics/composition';
import type { SubjectPageData } from '../src/features/pages/subject';
import type { TypeListTarget } from '../src/features/pages/type-list-model';
import recorded from '../src/kernel/recorded/home-page.json';

const app = join(import.meta.dir, '..');
const root = join(app, '../..');
const node = 'reading-books';
const cursor = 'opaque/next+page==&context=retained%2F';
const encodedCursor = 'opaque%2Fnext%2Bpage%3D%3D%26context%3Dretained%252F';
const currentCursor = 'opaque/current+page==';
const books = recorded.reads.r0.body;
const unique = books.subjects.filter((hit, index, all) => all.findIndex((other) => other.id === hit.id) === index);
const title = { ja: '本と物語 — ' + '長い見出しLongUnbrokenReadingLabel'.repeat(8) };
const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
const context: SelectedContext = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000301',
  population: { kind: 'realm', id: realm, title: 'Reading community' },
};
const targets: Array<{ target: TypeListTarget; encoded: string }> = [
  {
    target: { route: '/reading + books/文学' },
    encoded: '%7B%22route%22%3A%22%2Freading+%2B+books%2F%E6%96%87%E5%AD%A6%22%7D',
  },
  {
    target: { subject: unique[0]!.id, realm: realm, view: 'works' },
    encoded: `%7B%22subject%22%3A%22${unique[0]!.id}%22%2C%22realm%22%3A%22${realm}%22%2C%22view%22%3A%22works%22%7D`,
  },
  {
    target: { account: 'reader+name', view: 'collections' },
    encoded: '%7B%22account%22%3A%22reader%2Bname%22%2C%22view%22%3A%22collections%22%7D',
  },
];
type Mount = { page: SubjectPageData; full: boolean; target?: TypeListTarget; locale: string };
type MountedWindow = Window & { mountTypeList(input: Mount): void; followed: string[] };

function fixture(
  full: boolean,
  status = 200,
  body: unknown = { ...books, next: cursor },
  missing = false,
): SubjectPageData {
  const document: CompositionDocument = {
    root: { props: {} },
    content: [{ type: 'TypeList', props: { id: node, title, types: ['schema:Book'], sort: 'name', limit: 12 } }],
  };
  const continuation = full ? { node, cursor: currentCursor } : undefined;
  const plan = planReads(platformRegistry, document, {
    subject: null,
    context,
    ...(continuation ? { continuation } : {}),
  });
  return {
    subject: null,
    profile: recorded.profile,
    template: { scope: 'route', key: '/reading' },
    document,
    context,
    ...(continuation ? { continuation } : {}),
    reads: missing ? {} : { [plan.nodes[node]!]: { status, body } },
  };
}

async function componentBundle() {
  const result = await Bun.build({
    entrypoints: ['type-list-reading-fixture'],
    target: 'browser',
    format: 'iife',
    plugins: [
      {
        name: 'mounted-type-list-reading',
        setup(build) {
          // The installed Storybook bridge replaces the server runtime, not any renderer/provider/read descriptor.
          build.onResolve({ filter: /^@tanstack\/react-start(?:\/server)?$/ }, () => ({
            path: join(app, '.storybook/react-start.ts'),
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: 'workers',
            namespace: 'reading-runtime',
          }));
          build.onLoad({ filter: /.*/, namespace: 'reading-runtime' }, () => ({
            contents: 'export const env = {};',
            loader: 'js',
          }));
          build.onResolve({ filter: /^type-list-reading-fixture$/ }, () => ({
            path: 'entry',
            namespace: 'reading-entry',
          }));
          build.onLoad({ filter: /.*/, namespace: 'reading-entry' }, () => ({
            loader: 'tsx',
            resolveDir: app,
            contents: `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { flushSync } from 'react-dom';
            import { TypeList } from ${JSON.stringify(join(app, 'src/features/pages/type-list.tsx'))};
            import { TypeListPage } from ${JSON.stringify(join(app, 'src/features/pages/type-list-page.tsx'))};
            import { PageData } from ${JSON.stringify(join(app, 'src/features/pages/data.tsx'))};
            import { subjectPageMessages } from ${JSON.stringify(join(app, 'src/features/pages/route-support.tsx'))};
            import { setLocale } from ${JSON.stringify(join(app, 'src/paraglide/runtime.js'))};
            const root = createRoot(document.getElementById('app'));
            window.followed = [];
            document.addEventListener('click', event => {
              const link = event.target.closest('a');
              if (link) { event.preventDefault(); window.followed.push(link.getAttribute('href')); }
            });
            window.mountTypeList = ({ page, full, target, locale }) => {
              setLocale(locale, { reload: false });
              document.documentElement.lang = locale;
              flushSync(() => root.render(full && target
                ? <TypeListPage page={page} target={target} node=${JSON.stringify(node)} locale={locale} />
                : <PageData {...page} locale={locale} listTarget={target}
                    fullList={full ? ${JSON.stringify(node)} : undefined} messages={subjectPageMessages()}>
                    <TypeList {...page.document.content[0].props} />
                  </PageData>
              ));
            };
          `,
          }));
        },
      },
    ],
  });
  expect(result.success, result.logs.map(String).join('\n')).toBe(true);
  return result.outputs[0]!.text();
}

async function componentStyles() {
  const sources = await Promise.all(
    [
      'apps/web/src/features/pages/type-list.tsx',
      'apps/web/src/features/pages/type-list-page.tsx',
      'apps/web/src/features/pages/cover-list.tsx',
      'apps/web/src/library/section-heading.tsx',
      'apps/web/src/shell/page-heading.tsx',
      'packages/ui/src/components/cover-card.tsx',
      'packages/ui/src/components/content-item.tsx',
      'packages/ui/src/components/list-row.tsx',
      'packages/ui/src/components/cover.tsx',
    ].map((path) => Bun.file(join(root, path)).text()),
  );
  const [theme, preflight] = await Promise.all([
    Bun.file(Bun.resolveSync('tailwindcss/theme.css', app)).text(),
    Bun.file(Bun.resolveSync('tailwindcss/preflight.css', app)).text(),
  ]);
  // The real theme's focus token is normally supplied by the app stylesheet.
  const compiler = await compile(
    `${theme}\n${preflight}\n@theme { --color-ring: #2563eb; --color-primary: #164e63; }\n@tailwind utilities;`,
  );
  return compiler.build(sources.flatMap((source) => source.match(/[^\s"'\x60{}]+/g) ?? []));
}

async function mount(page: Page, input: Mount) {
  await page.evaluate((input) => (window as MountedWindow).mountTypeList(input), input);
}

async function independent(page: Page, link: Locator, destination: string) {
  expect(await link.getAttribute('href')).toBe(destination);
  expect(await link.getAttribute('role')).toBeNull();
  expect(await link.getAttribute('tabindex')).toBeNull();
  await link.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  expect(
    await link.evaluate((element) => element === document.activeElement && element.matches(':focus-visible')),
  ).toBe(true);
  expect(await link.evaluate((element) => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(
    0,
  );
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as MountedWindow).followed.pop())).toBe(destination);
  await link.scrollIntoViewIfNeeded();
  // A real click hits this anchor rather than a neighboring primary-title overlay.
  await link.click();
  expect(await page.evaluate(() => (window as MountedWindow).followed.pop())).toBe(destination);
}

async function geometry(link: Locator) {
  const result = await link.evaluate((element) => {
    element.scrollIntoView({ block: 'start' });
    const box = element.getBoundingClientRect();
    const section = element.closest('section')!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = [...range.getClientRects()];
    const style = getComputedStyle(element);
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(22, box.height / 2));
    return {
      width: box.width,
      height: box.height,
      contained: box.left >= section.left - 1 && box.right <= section.right + 1,
      overflow: element.scrollWidth - element.clientWidth,
      lines: text.length,
      textContained: text.every(
        (rect) =>
          rect.left >= box.left - 1 &&
          rect.right <= box.right + 1 &&
          rect.top >= box.top - 1 &&
          rect.bottom <= box.bottom + 1,
      ),
      hit: hit === element || element.contains(hit),
      clipped: ['hidden', 'clip'].includes(style.overflow) || style.textOverflow === 'ellipsis',
    };
  });
  expect(result.width).toBeGreaterThanOrEqual(44);
  expect(result.height).toBeGreaterThanOrEqual(44);
  expect(result.contained).toBe(true);
  expect(result.overflow).toBeLessThanOrEqual(1);
  expect(result.lines).toBeGreaterThan(1);
  expect(result.textContained).toBe(true);
  expect(result.hit).toBe(true);
  expect(result.clipped).toBe(false);
}

// Authored acceptance, UNRUN under MINIMAL. Recorded rows plus explicit protocol variants do not prove native production.
test('embedded and full configured Type lists retain native navigation, failures and independent readable controls', async () => {
  const [bundle, css] = await Promise.all([componentBundle(), componentStyles()]);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    await page.route('**/*', (route) => route.abort());
    await page.route('https://rezics.test/en/type-list-reading', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html lang="en"><body><button id="start">Start</button><main id="app" style="padding:16px"></main><button id="end">End</button></body></html>',
      }),
    );
    await page.goto('https://rezics.test/en/type-list-reading');
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle });

    for (const full of [false, true]) {
      for (const { target, encoded } of targets) {
        const href = `/en/search/list?list=${node}&page=${encoded}`;
        await mount(page, { page: fixture(full), target, full, locale: 'en' });
        const section = page.getByRole('region', { name: title.ja, exact: true });
        expect(await section.count()).toBe(1);
        expect(await section.getAttribute('aria-labelledby')).toBe(`${node}-title`);
        const heading = section.getByRole('heading', { level: full ? 1 : 2, name: title.ja });
        expect(await heading.getAttribute('id')).toBe(`${node}-title`);
        expect(await heading.getAttribute('lang')).toBe('ja');
        expect(await section.locator('[role="alert"], [role="status"]').count()).toBe(0);
        const list = section.getByRole('list', { name: title.ja, exact: true });
        expect(await list.count()).toBe(1);
        expect(await list.getAttribute('data-layout')).toBe(full ? 'cover-grid' : 'cover-row');
        expect(await list.getByRole('heading', { level: 3 }).allTextContents()).toEqual(
          unique.map((hit) => hit.labels.en),
        );
        const subjectHrefs = unique.map(
          (hit) => `/en/subjects/${hit.id}/${hit.labels.en.toLowerCase().replaceAll(' ', '-')}?realm=${realm}`,
        );
        expect(
          await list.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
        ).toEqual(subjectHrefs);
        const seeAll = section.getByRole('link', { name: 'See all', exact: true });
        expect(await seeAll.count()).toBe(full ? 0 : 1);
        if (!full) await independent(page, seeAll, href);
        const next = section.locator('[data-slot="next-page"]');
        expect(await next.textContent()).toBeTruthy();
        await independent(page, next, `${href}&cursor=${encodedCursor}`);
        await independent(page, list.getByRole('link').first(), subjectHrefs[0]!);
        // Actual sequential tabbing reaches the controls once and the native rows in their supplied/deduplicated order.
        await page.locator('#start').focus();
        const tabbed: string[] = [];
        for (let step = 0; step < unique.length + 6; step++) {
          await page.keyboard.press('Tab');
          const active = await page.evaluate(() => ({
            id: document.activeElement?.id,
            href: document.activeElement?.getAttribute('href'),
          }));
          if (active.id === 'end') break;
          if (active.href) tabbed.push(active.href);
        }
        expect(tabbed).toEqual([...(full ? [] : [href]), ...subjectHrefs, `${href}&cursor=${encodedCursor}`]);
        expect(await page.locator('#end').evaluate((element) => element === document.activeElement)).toBe(true);
      }

      const target = targets[0]!.target;
      const href = `/en/search/list?list=${node}&page=${targets[0]!.encoded}`;
      for (const variant of [
        { status: 503, body: { code: 'index_not_ready' } },
        { status: 403, body: { code: 'forbidden' } },
        { status: 200, body: {} },
        { status: 200, body: { subjects: [], next: cursor } },
        { status: 200, body: { subjects: unique, next: '' } },
        { status: 200, body: { subjects: unique } },
        { status: 200, body: { subjects: 'unavailable', next: null } },
        { status: 200, body: null },
        { status: 200, body: undefined, missing: true },
      ]) {
        await mount(page, {
          page: fixture(full, variant.status, variant.body, variant.missing),
          target,
          full,
          locale: 'en',
        });
        const alert = page.getByRole('alert');
        expect(await alert.count()).toBe(1);
        expect(await alert.textContent()).toContain('This section could not be loaded.');
        expect(await page.getByRole('status').count()).toBe(0);
        expect(await page.getByRole('list').count()).toBe(0);
        expect(await page.locator('[data-slot="next-page"]').count()).toBe(0);
        await independent(page, alert.getByRole('link', { name: 'Retry', exact: true }), href);
      }

      await mount(page, { page: fixture(full, 200, { subjects: [], next: null }), target, full, locale: 'en' });
      expect(await page.getByRole('status').textContent()).toBe('No results found.');
      expect(await page.getByRole('alert').count()).toBe(0);
      expect(await page.locator('[data-slot="next-page"]').count()).toBe(0);
      expect(await page.locator('[data-slot="see-all"]').count()).toBe(full ? 0 : 1);
      await mount(page, { page: fixture(full, 200, { ...books, next: null }), target, full, locale: 'en' });
      expect(await page.locator('[data-slot="next-page"]').count()).toBe(0);
      expect(await page.getByRole('status').count()).toBe(0);
      await mount(page, { page: fixture(full, 204, null), target, full, locale: 'en' });
      expect(await page.locator('[data-slot="type-list"]').count()).toBe(0);

      for (const failed of [false, true]) {
        await mount(page, { page: fixture(full, failed ? 503 : 200), full, locale: 'en' });
        expect(await page.locator('[data-slot="see-all"], [data-slot="next-page"], [role="alert"] a').count()).toBe(0);
        expect(await page.getByRole('alert').count()).toBe(failed ? 1 : 0);
        expect(await page.getByRole('status').count()).toBe(0);
      }
    }

    for (const full of [false, true]) {
      for (const locale of ['en', 'de', 'ja', 'zh-Hant']) {
        for (const direction of ['ltr', 'rtl']) {
          for (const scale of [1, 2]) {
            await page.evaluate(
              ({ direction, scale }) => {
                document.documentElement.dir = direction;
                document.documentElement.style.fontSize = `${scale * 100}%`;
              },
              { direction, scale },
            );
            for (const failed of [false, true]) {
              const target = targets[0]!.target;
              await mount(page, { page: fixture(full, failed ? 503 : 200), full, target, locale });
              const controls = page.locator('[data-slot="see-all"], [role="alert"] > a, [data-slot="next-page"]');
              for (const control of await controls.all()) {
                const destination = (await control.getAttribute('href'))!;
                // Stress installed localized messages on the actual production anchor, with both spaced and unbroken text.
                await control.evaluate((element) => {
                  const label = element.textContent!;
                  element.textContent = `${Array(5).fill(label).join(' ')} ${label.replaceAll(' ', '').repeat(8)} 読書 안내`;
                });
                await geometry(control);
                await independent(page, control, destination);
              }
              const heading = page.getByRole('heading', { level: full ? 1 : 2 });
              expect(await heading.textContent()).toBe(title.ja);
              expect(
                await heading.evaluate((element) => element.scrollWidth - element.clientWidth),
              ).toBeLessThanOrEqual(1);
              expect(
                await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
              ).toBeLessThanOrEqual(1);
              expect(await page.locator('a a, a button').count()).toBe(0);
            }
          }
        }
      }
    }
    expect(requests).toEqual([]);
  } finally {
    await browser.close();
  }
}, 60_000);
