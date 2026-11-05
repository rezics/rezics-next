import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import { compile } from 'tailwindcss';
import type { CoverSummary } from '@rezics/ui/cover';
import type { ThreadSubject } from '../src/threads/subjects';
import { sharedRatio } from '@rezics/ui/cover';
import { coverSrc } from '../src/media/cover-src';
import { subjectHref } from '../src/subject/subject-href';
import { m } from '../src/paraglide/messages.js';
import { setLocale, type Locale } from '../src/paraglide/runtime.js';
import recorded from '../src/kernel/recorded/subject.json';
import uncovered from '../src/kernel/recorded/subject-uncovered.json';

const app = join(import.meta.dir, '..');
const root = join(app, '../..');
const cover = recorded.summary.cover as CoverSummary;
const covered: ThreadSubject = {
  id: recorded.subject.id,
  types: recorded.summary.types,
  label: recorded.summary.label.value,
  labels: recorded.subject.labels,
  cover,
};
const missing: ThreadSubject = {
  id: uncovered.subject.id,
  types: uncovered.summary.types,
  label: uncovered.summary.label.value,
  labels: uncovered.subject.labels,
  cover: null,
};
const sensitive: ThreadSubject = { ...covered, cover: { ...cover, withheld: 'suitability' } };
const longTitle = 'RelatedSubject'.repeat(36);
const dense: ThreadSubject[] = [
  { ...missing, id: 'long/title + identity', label: longTitle, labels: {} },
  sensitive,
  { ...missing, id: 'multilingual', label: null, labels: { ja: '夜間飛行'.repeat(35) } },
  { ...missing, id: 'untitled', label: null, labels: {} },
];
type Mount = { lists: ThreadSubject[][]; locale: Locale; dir: 'ltr' | 'rtl'; viewer?: boolean };
type MountedWindow = Window & { mountThreadSubjects(props: Mount): void };

async function componentBundle() {
  const result = await Bun.build({
    entrypoints: ['thread-subjects-fixture'],
    target: 'browser',
    format: 'iife',
    plugins: [
      {
        name: 'actual-thread-subjects',
        setup(build) {
          build.onResolve({ filter: /^thread-subjects-fixture$/ }, () => ({ path: 'entry', namespace: 'subjects' }));
          build.onLoad({ filter: /.*/, namespace: 'subjects' }, () => ({
            loader: 'tsx',
            resolveDir: app,
            contents: `
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { flushSync } from 'react-dom';
            import { ThreadSubjects } from ${JSON.stringify(join(app, 'src/threads/thread-subjects.tsx'))};
            import { SubjectPageCover } from ${JSON.stringify(join(app, 'src/features/pages/subject-page-cover.tsx'))};
            import { coverSrc } from ${JSON.stringify(join(app, 'src/media/cover-src.ts'))};
            import { setLocale } from ${JSON.stringify(join(app, 'src/paraglide/runtime.js'))};
            const covered = ${JSON.stringify(covered)};
            const root = createRoot(document.getElementById('app'));
            window.mountThreadSubjects = ({ lists, locale, dir, viewer }) => {
              setLocale(locale, { reload: false });
              document.documentElement.lang = locale;
              document.documentElement.dir = dir;
              flushSync(() => root.render(<>
                {lists.map((subjects, index) => <section key={index} aria-label={'Thread ' + (index + 1)}>
                  <ThreadSubjects subjects={subjects} />
                </section>)}
                {viewer ? <SubjectPageCover
                  subject={{ id: covered.id, title: covered.labels.en, types: covered.types }}
                  cover={covered.cover} size="sm" src={coverSrc} suitability="blur" labels={{}}
                  title="Cover credit" via="via" openLabel="Open source cover" closeLabel="Close cover"
                /> : null}
              </>));
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
  const files = [
    'apps/web/src/threads/thread-subjects.tsx',
    'packages/ui/src/components/content-item.tsx',
    'packages/ui/src/components/list-row.tsx',
    'packages/ui/src/components/cover.tsx',
    'packages/ui/src/components/cover-viewer.tsx',
    'packages/ui/src/shadcn/button.tsx',
    'packages/ui/src/shadcn/dialog.tsx',
  ];
  const [sources, theme, preflight, ui, hitbox] = await Promise.all([
    Promise.all(files.map((path) => Bun.file(join(root, path)).text())),
    Bun.file(Bun.resolveSync('tailwindcss/theme.css', app)).text(),
    Bun.file(Bun.resolveSync('tailwindcss/preflight.css', app)).text(),
    Bun.file(join(root, 'packages/ui/src/styles.css')).text(),
    Bun.file(join(root, 'packages/ui/src/hitbox.css')).text(),
  ]);
  const compiler = await compile(
    `${theme}\n${preflight}\n${ui.replace(/^@import .*;$/gm, '')}\n${hitbox}\n@tailwind utilities;`,
  );
  return compiler.build(sources.flatMap((source) => source.match(/[^\s"'`{}]+/g) ?? []));
}

async function mount(page: Page, props: Mount) {
  setLocale(props.locale, { reload: false });
  await page.evaluate((value) => (window as MountedWindow).mountThreadSubjects(value), props);
}

async function assertList(list: Locator, subjects: ThreadSubject[], titles: string[], locale: Locale) {
  expect(await list.evaluate((element) => element.tagName)).toBe('UL');
  const rows = list.locator(':scope > li');
  expect(await rows.count()).toBe(subjects.length);
  expect(await list.locator('ul, ol, [role="list"], [role="listitem"]').count()).toBe(0);
  const headings = rows.getByRole('heading', { level: 2 });
  expect(await headings.allTextContents()).toEqual(titles);
  const links = rows.locator('[data-slot="list-row-link"]');
  expect(await links.evaluateAll((elements) => elements.map((element) => element.getAttribute('href')))).toEqual(
    subjects.map((subject, index) => subjectHref({ id: subject.id, label: titles[index]! }, locale).href),
  );
  for (const [index, title] of titles.entries()) {
    const link = rows.nth(index).getByRole('link', { name: title, exact: true });
    expect(await link.getAttribute('aria-labelledby')).toBe(await headings.nth(index).getAttribute('id'));
    const target = await link.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(44);
    expect(target!.height).toBeGreaterThanOrEqual(44);
    await link.focus();
    expect(await link.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await link.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
  }
  expect(await list.locator('a a, a button, a input, a select, a textarea').count()).toBe(0);
  expect(
    await list
      .locator('[data-slot="cover"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-ratio'))),
  ).toEqual(subjects.map(() => sharedRatio(subjects)));
}

// Authored UNRUN for integration: actual client-rendered production components and real generated utilities.
// Presentation fixtures and media interception do not establish native disclosure or published evidence.
test('Finish the related thread subjects shared-family list', async () => {
  const [bundle, css, image] = await Promise.all([
    componentBundle(),
    componentStyles(),
    readFile(join(app, '.storybook/media', cover.media, 'webp-320')),
  ]);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.route('https://rezics.test/fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><body><button id="start">Start</button><main style="max-width:768px;margin:auto;padding:16px"><h1>Flight notes</h1><div id="app"></div></main><button id="end">End</button></body></html>',
      }),
    );
    await page.route(`https://rezics.test${coverSrc(cover.media, 'webp', 320)}`, (route) =>
      route.fulfill({ contentType: 'image/webp', body: image }),
    );
    await page.goto('https://rezics.test/fixture');
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle });

    await mount(page, { lists: [[]], locale: 'en', dir: 'ltr' });
    expect(await page.getByRole('list').count()).toBe(0);
    expect(await page.locator('[data-slot="cover"], [data-slot="list-row-link"]').count()).toBe(0);
    expect(requests).toEqual([]);

    // Every fallback is observed through the delivered view, including the exact localized destination.
    const fallbacks: ThreadSubject[] = [
      { ...missing, id: 'localized/id +', label: 'Kernel label', labels: { fr: 'Titre français', en: 'English' } },
      { ...missing, id: 'kernel', label: 'Kernel label', labels: { en: 'English' } },
      { ...missing, id: 'english', label: null, labels: { en: 'English', ja: '日本語' } },
      { ...missing, id: 'any-language', label: null, labels: { ja: '日本語' } },
    ];
    await mount(page, { lists: [fallbacks], locale: 'fr', dir: 'ltr' });
    await assertList(page.getByRole('list'), fallbacks, ['Titre français', 'Kernel label', 'English', '日本語'], 'fr');
    expect(await page.getByRole('link', { name: 'Titre français' }).getAttribute('href')).toBe(
      '/fr/subjects/localized%2Fid%20%2B/titre-français',
    );

    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dir of ['ltr', 'rtl'] as const) {
        await mount(page, { lists: [], locale: 'en', dir });
        await mount(page, { lists: [dense, dense], locale: 'en', dir });
        const lists = page.getByRole('list', { name: m.thread_subjects_heading() });
        expect(await lists.count()).toBe(2);
        const titles = [longTitle, 'The Little Prince', '夜間飛行'.repeat(35), m.threads_untitled()];
        for (const index of [0, 1]) await assertList(lists.nth(index), dense, titles, 'en');
        const headingIds = await lists
          .getByRole('heading')
          .evaluateAll((elements) => elements.map((element) => element.id));
        expect(new Set(headingIds).size).toBe(dense.length * 2);
        expect(await page.locator('img, source').count()).toBe(0);
        expect(await page.locator('[data-slot="cover"][data-state="placeholder"]').count()).toBe(6);
        expect(await page.locator('[data-slot="cover"][data-state="withheld"]').count()).toBe(2);
        expect(await lists.getByText(m.thread_cover_withheld(), { exact: true }).count()).toBe(2);
        expect(await lists.locator('[data-state="placeholder"][aria-hidden="true"]').count()).toBe(6);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const title = lists.first().getByRole('heading', { name: longTitle });
        expect(await title.evaluate((element) => getComputedStyle(element).overflowWrap)).toBe('anywhere');
        expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await title.evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe('none');

        // Visit each primary link once; reveal remains an independent keyboard target in each instance.
        await page.locator('#start').focus();
        const visited: string[] = [];
        for (let step = 0; step < dense.length * 2 + 2; step++) {
          await page.keyboard.press('Tab');
          const focus = await page.evaluate(() => ({
            href: document.activeElement?.getAttribute('href'),
            tag: document.activeElement?.tagName,
          }));
          if (focus.href) visited.push(focus.href);
          else expect(focus.tag).toBe('BUTTON');
        }
        const destinations = dense.map(
          (subject, index) => subjectHref({ id: subject.id, label: titles[index]! }, 'en').href,
        );
        expect(visited).toEqual([...destinations, ...destinations]);

        const reveal = lists.first().getByRole('button', { name: m.thread_cover_reveal() });
        await reveal.focus();
        await page.keyboard.press('Enter');
        await lists.first().locator('img').waitFor();
        expect(await lists.first().locator('img').getAttribute('src')).toBe(coverSrc(cover.media, 'webp', 320));
        expect(await lists.first().locator('img').getAttribute('alt')).toBe('');
        expect(await lists.nth(1).locator('img, source').count()).toBe(0);
        expect(await lists.nth(1).getByRole('button', { name: m.thread_cover_reveal() }).count()).toBe(1);
        expect(await lists.getByRole('link', { name: 'Generated fixture' }).count()).toBe(0);
        expect(await page.locator('figcaption').count()).toBe(0);
      }
    }

    // Credits belong to the existing source viewer; opening it must not reveal a related-list cover.
    await mount(page, { lists: [], locale: 'en', dir: 'ltr' });
    await mount(page, { lists: [[sensitive, missing]], locale: 'en', dir: 'ltr', viewer: true });
    const trigger = page.getByRole('button', { name: 'Open source cover' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Cover credit' });
    const source = dialog.getByRole('link', { name: 'Generated fixture' });
    await source.waitFor();
    expect(await source.getAttribute('href')).toBe(cover.credit!.via!.url);
    await source.focus();
    expect(await source.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await dialog.textContent()).toContain(cover.credit!.rightsHolder);
    expect(await dialog.textContent()).toContain(cover.credit!.license!);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await page.getByRole('list').locator('img, source').count()).toBe(0);
    expect(requests.every((url) => url === `https://rezics.test${coverSrc(cover.media, 'webp', 320)}`)).toBe(true);
  } finally {
    await browser.close();
  }
}, 60_000);
