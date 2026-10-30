import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import fixturesJson from '../src/kernel/fixtures.json' with { type: 'json' };

const app = join(import.meta.dir, '..');
const root = join(app, '../..');
const recorded = join(app, 'src/kernel/recorded');
const locales = ['en', 'ja'];
const timeout = 900_000;
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let serverPromise: Promise<string> | undefined;

type Messages = Record<string, string>;
type Recording = Record<string, any>;
type Library = Record<string, Recording>;
type LibraryPage = {
  /** The story file, without `.stories.tsx`. */
  story: string;
  /** The route file the story enters and the id it declares. */
  route: { file: string; id: string };
  heading: (own: Messages, library: Library) => string;
  /** Texts of seeded items; the page shows the first one. */
  items: (library: Library, locale: string) => string[];
};
const fixtureSubjects = (fixturesJson as { subjects: { id: string; labels: Record<string, string> }[] }).subjects;

const pages: LibraryPage[] = [
  {
    story: 'library-entries',
    route: { file: 'library/index.tsx', id: '/library/' },
    heading: (own) => own.library_heading!,
    items: (library, locale) =>
      library['library-entries']!.libraryEntries.map((entry: Recording) => {
        const subjectId = entry.subject.id as string;
        const labels = fixtureSubjects.find((subject) => subject.id === subjectId)?.labels;
        return labels?.[locale] ?? entry.subject.label;
      }),
  },
  {
    story: 'library-collections',
    route: { file: 'library/collections.tsx', id: '/library/collections' },
    heading: (own) => own.library_collections_heading!,
    items: (library) => library['library-collections']!.collections.map((collection: Recording) => collection.title),
  },
  {
    story: 'library-copies',
    route: { file: 'library/copies.tsx', id: '/library/copies' },
    heading: (own) => own.library_copy_heading!,
    items: (library) => library['library-copies']!.copies.map((copy: Recording) => copy.subject.label),
  },
  {
    story: 'library-following',
    route: { file: 'library/following.tsx', id: '/library/following' },
    heading: (own) => own.library_following_heading!,
    items: (library) => library['library-follows']!.follows.map((follow: Recording) => follow.target.label),
  },
  {
    story: 'library-progress',
    route: { file: 'library/progress.index.tsx', id: '/library/progress/' },
    heading: (own) => own.library_progress_heading!,
    items: (library) =>
      library['library-progress-sessions']!.progressSessions.map((session: Recording) => session.subject.label),
  },
  {
    story: 'library-progress-session',
    route: { file: 'library/progress.$id.tsx', id: '/library/progress/$id' },
    heading: (own) => own.library_progress_heading!,
    items: (library) => library['library-progress-changes']!.changes.map((change: Recording) => change.intent.locator),
  },
  {
    story: 'library-collection',
    route: { file: 'collections/$id.tsx', id: '/collections/$id' },
    heading: (_own, library) => library['library-collection']!.collection.title,
    items: (library) => library['library-collection-members']!.members.map((member: Recording) => member.subject.label),
  },
  {
    story: 'library-log',
    route: { file: 'logs/$id.tsx', id: '/logs/$id' },
    heading: (own) => own.library_logs_page_heading!,
    items: (library) => [
      library['library-published-log']!.publishedLog.note,
      library['library-published-log']!.publishedLog.subject.label,
    ],
  },
];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function storybook(): Promise<string> {
  const port = await freePort();
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  const executable = join(app, 'node_modules/.bin/storybook');
  child = spawn(executable, ['dev', '--ci', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: app,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1' },
  });
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Storybook exited with ${child.exitCode}:\n${output}`);
    try {
      if ((await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(10_000) })).ok) return origin;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Storybook did not serve its index in time:\n${output}`);
    await Bun.sleep(500);
  }
}

afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

async function readLibrary(): Promise<Library> {
  const library: Library = {};
  for (const name of new Bun.Glob('library-*.json').scanSync({ cwd: recorded }))
    library[basename(name, '.json')] = await Bun.file(join(recorded, name)).json();
  return library;
}

async function readMessages(locale: string): Promise<Messages> {
  return Bun.file(join(app, 'messages', `${locale}.json`)).json();
}

async function openStory(story: string, visitor: 'Signed In' | 'Signed Out', locale: string, width = 1280) {
  serverPromise ??= storybook();
  const origin = await serverPromise;
  const index = (await (await fetch(`${origin}/index.json`)).json()) as {
    entries: Record<string, { id: string; importPath: string; name: string; type: string; title: string }>;
  };
  const entry = Object.values(index.entries).find(
    (candidate) =>
      candidate.type === 'story' &&
      basename(candidate.importPath) === `${story}.stories.tsx` &&
      candidate.name === visitor,
  );
  if (!entry) throw new Error(`Missing ${story} story for ${visitor}.`);
  expect(entry.title.startsWith('Pages/Library/'), `${story} is titled under Pages/Library`).toBe(true);
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height: 860 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${origin}/iframe.html?id=${entry.id}&viewMode=story&globals=locale:${locale}`, {
    waitUntil: 'networkidle',
  });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('main').waitFor();
  return { context, page };
}

function storyName(exportName: string): string {
  return exportName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

async function openNamedStory(file: string, exportName: string, locale: string, width: number) {
  serverPromise ??= storybook();
  const origin = await serverPromise;
  const source = await Bun.file(join(app, 'src/stories', file)).text();
  const declaration = source.slice(source.indexOf(`export const ${exportName}:`));
  const explicitName = /^\s*name:\s*['"]([^'"]+)['"]/m.exec(declaration)?.[1];
  const displayName = explicitName ?? storyName(exportName);
  const index = (await (await fetch(`${origin}/index.json`)).json()) as {
    entries: Record<string, { id: string; importPath: string; name: string; type: string; title: string }>;
  };
  const entry = Object.values(index.entries).find(
    (candidate) =>
      candidate.type === 'story' && basename(candidate.importPath) === file && candidate.name === displayName,
  );
  if (!entry) throw new Error(`Missing ${file}#${exportName} story.`);
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height: 860 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${origin}/iframe.html?id=${entry.id}&viewMode=story&globals=locale:en`, {
    waitUntil: 'networkidle',
  });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('main').waitFor();
  return { context, page };
}

/** The story renders the page, not an error: its heading and a seeded item are visible. */
async function expectRendered(page: Page, own: Messages, heading: string, item: string) {
  const main = page.getByRole('main');
  const title = main.getByRole('heading', { level: 1 });
  await title.waitFor();
  expect((await title.textContent())?.trim()).toBe(heading);
  await main.getByText(item).first().waitFor({ state: 'visible' });
  const text = (await main.textContent()) ?? '';
  for (const key of ['not_found_heading', 'error_heading', 'platform_closed_heading'])
    expect(text, `${heading} shows no ${key}`).not.toContain(own[key]!);
}

test(
  'every library page has a story that renders its real route with recorded content',
  async () => {
    const library = await readLibrary();
    const paths = await Bun.file(join(app, 'src/stories/page.tsx')).text();
    for (const spec of pages) {
      const route = await Bun.file(join(app, 'src/routes', spec.route.file)).text();
      expect(route, `${spec.route.file} declares ${spec.route.id}`).toContain(`createFileRoute('${spec.route.id}')`);
      const file = Bun.file(join(app, 'src/stories', `${spec.story}.stories.tsx`));
      expect(await file.exists(), `${spec.story} has a story file`).toBe(true);
      const source = await file.text();
      expect(source, `${spec.story} renders through PageStory`).toContain('<PageStory');
      expect(source, `${spec.story} enters the site through a page path`).toContain('pagePaths');
      expect(paths, `${spec.story} has its path in page.tsx`).toContain(`'${spec.story}'`);
      for (const locale of locales) {
        const own = await readMessages(locale);
        const opened = await openStory(spec.story, 'Signed In', locale);
        try {
          await expectRendered(opened.page, own, spec.heading(own, library), spec.items(library, locale)[0]!);
          const main = opened.page.getByRole('main');
          if (spec.story === 'library-collection')
            expect(await main.locator('[data-visibility]').count(), 'the owner sees visibility').toBe(1);
          if (spec.story === 'library-log')
            await main.getByRole('button', { name: own.library_logs_delete!, exact: true }).waitFor();
          expect(await opened.page.getByRole('link', { name: own.account_sign_in!, exact: true }).count()).toBe(0);
        } finally {
          await opened.context.close();
        }
      }
    }
  },
  timeout,
);

test(
  'the public collection and published log stories render for a signed-out visitor',
  async () => {
    const library = await readLibrary();
    for (const spec of pages.filter((page) => ['library-collection', 'library-log'].includes(page.story))) {
      for (const locale of locales) {
        const own = await readMessages(locale);
        const opened = await openStory(spec.story, 'Signed Out', locale);
        try {
          await expectRendered(opened.page, own, spec.heading(own, library), spec.items(library, locale)[0]!);
          expect(
            await opened.page
              .getByRole('banner')
              .getByRole('link', { name: own.account_sign_in!, exact: true })
              .count(),
          ).toBe(1);
          const main = opened.page.getByRole('main');
          expect(await main.locator('[data-visibility]').count(), 'a visitor does not see visibility').toBe(0);
          expect(await main.getByRole('button', { name: own.library_logs_delete!, exact: true }).count()).toBe(0);
        } finally {
          await opened.context.close();
        }
      }
    }
  },
  timeout,
);

test(
  'following and subject Library menus use sheets at phone width and dropdowns at desktop width',
  async () => {
    const locale = await readMessages('en');
    for (const width of [390, 1280]) {
      const following = await openStory('library-following', 'Signed In', 'en', width);
      try {
        await following.page
          .getByRole('button', { name: /more actions for/i })
          .first()
          .click();
        if (width === 390) {
          const sheet = following.page.locator('[data-slot="drawer-content"]');
          await sheet.waitFor({ state: 'visible' });
          await sheet.getByRole('button', { name: locale.library_follow_unfollow! }).waitFor();
        } else {
          const menu = following.page.getByRole('menu');
          await menu.waitFor({ state: 'visible' });
          await menu.getByRole('menuitem', { name: locale.library_follow_unfollow! }).waitFor();
        }
      } finally {
        await following.context.close();
      }

      const subject = await openNamedStory('subject.stories.tsx', 'SignedIn', 'en', width);
      try {
        await subject.page.getByRole('button', { name: locale.library_subject_add_collection! }).click();
        if (width === 390) {
          const sheet = subject.page.locator('[data-slot="drawer-content"]');
          await sheet.waitFor({ state: 'visible' });
          await sheet.getByRole('button', { name: locale.library_subject_load_collections! }).waitFor();
        } else {
          const menu = subject.page.getByRole('menu');
          await menu.waitFor({ state: 'visible' });
          await menu.getByRole('button', { name: locale.library_subject_load_collections! }).waitFor();
        }
      } finally {
        await subject.context.close();
      }
    }
  },
  timeout,
);

test(
  'the following ListRow link covers the row while its menu control keeps its own target',
  async () => {
    const locale = await readMessages('en');
    const opened = await openStory('library-following', 'Signed In', 'en', 1280);
    try {
      const link = opened.page.getByRole('link', { name: 'Kokoro' });
      const row = link.locator('xpath=..');
      await expect(row).toHaveAttribute('data-slot', 'list-row');
      const bounds = await row.boundingBox();
      expect(bounds).not.toBeNull();
      const pageUrl = opened.page.url();
      await opened.page.mouse.click(bounds!.x + 4, bounds!.y + bounds!.height / 2);
      await expect(opened.page.getByRole('main').getByRole('heading', { level: 1, name: /Kokoro/ })).toBeVisible();

      await opened.page.reload({ waitUntil: 'networkidle' });
      await opened.page.locator('html[data-hydrated]').waitFor();
      const refreshedButton = opened.page.getByRole('button', { name: /more actions for/i }).first();
      const refreshedBounds = await refreshedButton.boundingBox();
      expect(refreshedBounds).not.toBeNull();
      await opened.page.mouse.click(
        refreshedBounds!.x + refreshedBounds!.width / 2,
        refreshedBounds!.y + refreshedBounds!.height / 2,
      );
      await expect(opened.page.getByRole('menuitem', { name: locale.library_follow_unfollow! })).toBeVisible();
      expect(opened.page.url()).toBe(pageUrl);
    } finally {
      await opened.context.close();
    }
  },
  timeout,
);

test(
  'Library and All Collections navigation with pins do not scroll horizontally on a phone',
  async () => {
    for (const [file, exportName] of [
      ['library-page-states.stories.tsx', 'PinnedCollections'],
      ['library-collections.stories.tsx', 'CollectionsNinePins'],
      ['library-navigation-patterns.stories.tsx', 'PhoneSelectorOpen'],
    ]) {
      const opened = await openNamedStory(file, exportName, 'en', 390);
      try {
        const canvas = opened.page.locator('body');
        const menu = opened.page.locator('[data-slot="drawer-content"]');
        if (exportName === 'PhoneSelectorOpen') await menu.waitFor({ state: 'visible' });
        await expect(canvas).toBeVisible();
        const width = await opened.page.evaluate(() => ({
          client: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        expect(width.scroll, `${file}#${exportName} fits within ${width.client}px`).toBeLessThanOrEqual(width.client);
      } finally {
        await opened.context.close();
      }
    }
  },
  timeout,
);

test(
  'pinning at the 100-pin maximum keeps the Collection unpinned and explains the limit',
  async () => {
    const own = await readMessages('en');
    const opened = await openNamedStory('library-collections.stories.tsx', 'PinAtCapacity', 'en', 1280);
    try {
      const status = opened.page.getByRole('status');
      await status.waitFor({ state: 'visible' });
      expect(await status.innerText()).toBe(own.library_pin_limit);
      const main = opened.page.getByRole('main');
      const pinned = main.locator('#library-pinned-heading').locator('..').getByRole('listitem');
      expect(await pinned.count()).toBe(100);
      await expect(main.getByRole('link', { name: 'To read this winter' })).toBeVisible();
    } finally {
      await opened.context.close();
    }
  },
  timeout,
);

test(
  'every Library map cell is covered by a rendering story or an explicit planned capability',
  async () => {
    const map = await Bun.file(join(root, 'docs/development/page-stories.md')).text();
    const sections = map.split(/^## /m).filter((section) => section.startsWith('apps/web/src/routes/library/'));
    expect(sections.length, 'the Library routes are present in the coverage map').toBeGreaterThan(0);

    const references = new Map<string, Set<string>>();
    for (const section of sections) {
      const route = section.split('\n', 1)[0]!;
      const rows = section.split('\n').filter((line) => line.startsWith(`| ${route} |`));
      expect(rows.length, `${route} has page-state coverage rows`).toBeGreaterThan(0);
      for (const row of rows) {
        const cells = row
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim());
        for (const cell of cells.slice(3)) {
          expect(cell, `Library map cell is filled: ${row}`).not.toBe('missing');
          if (cell.startsWith('planned: ')) continue;
          const match = /apps\/web\/src\/stories\/([^#]+)#([A-Za-z][A-Za-z0-9]*)/.exec(cell);
          expect(match, `Library map cell names a story export: ${cell}`).not.toBeNull();
          const [, file, exportName] = match!;
          const source = await Bun.file(join(app, 'src/stories', file!)).text();
          expect(source, `${file} exports ${exportName}`).toMatch(new RegExp(`export const ${exportName}\\b`));
          const exports = references.get(file!) ?? new Set<string>();
          exports.add(exportName!);
          references.set(file!, exports);
        }
      }
    }

    for (const [file, exports] of references) {
      for (const exportName of exports) {
        for (const width of [390, 1280]) {
          const opened = await openNamedStory(file, exportName, 'en', width);
          try {
            await expect(opened.page.getByRole('main')).toBeVisible();
            const body = (await opened.page.locator('body').innerText()).trim();
            expect(body, `${file}#${exportName} renders at ${width}px`).not.toBe('');
            expect(body).not.toMatch(/A story errored|Failed to load story|Minified React error/i);
          } finally {
            await opened.context.close();
          }
        }
      }
    }
  },
  timeout,
);
