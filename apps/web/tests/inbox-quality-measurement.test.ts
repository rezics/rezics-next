import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { navigateStory, observeStorybook, settle } from '../scripts/screenshots.ts';
import { cleanupAll, ownBunProcess, type ProcessCustody } from './support/server-custody.ts';

type StoryEntry = { id: string; name: string; type: string; title: string; importPath?: string; tags?: string[] };
type StoryIndex = { entries: Record<string, StoryEntry> };
type ReviewStory = { key: string; entry: StoryEntry; family: 'page' | 'pattern'; reference?: boolean };
type State = {
  heading: string | null;
  text: string;
  noticeCount: number;
  unreadNoticeCount: number;
  targetLinkCount: number;
  statusCount: number;
  documentWidth: number;
  viewportWidth: number;
  focusedElement: string;
};

const root = resolve(import.meta.dir, '../../..');
const app = resolve(import.meta.dir, '..');
const evidenceDirectory = resolve(root, '.temp/goal/performance/evidence/inbox-current-dev');
const captureDirectory = join(evidenceDirectory, 'captures');
const manifestPath = join(evidenceDirectory, 'manifest.json');
const contractHash = '03ab88770d75965d46300530bd93e0012dc24d36c7749517888e0e4a1b431a65';
const launchLocales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const viewports = [
  { name: 'phone390', width: 390, height: 844 },
  { name: 'desktop1280', width: 1280, height: 900 },
] as const;

let child: Bun.Subprocess | undefined;
let storybookCustody: ProcessCustody | undefined;
let browser: Browser | undefined;
let origin = '';
let storyEntries: StoryEntry[] = [];
let storyIndexSha256 = '';
let assertionCount = 0;

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assertionCount++;
  expect(actual, message).toEqual(expected);
}

function assertTrue(actual: unknown, message: string): void {
  assertionCount++;
  expect(actual, message).toBeTruthy();
}

function assertGreater(actual: number, expected: number, message: string): void {
  assertionCount++;
  expect(actual, message).toBeGreaterThan(expected);
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findStory(title: string, source: string, names: string[]): StoryEntry {
  const expectedNames = new Set(names.map(normalizedName));
  const matches = storyEntries.filter(
    (entry) =>
      entry.type === 'story' &&
      entry.title === title &&
      entry.importPath?.endsWith(source) &&
      expectedNames.has(normalizedName(entry.name)),
  );
  assertEqual(matches.length, 1, `Served Storybook index resolves ${title}/${names[0]}`);
  if (matches.length !== 1) throw new Error(`Expected one served Storybook story for ${title}/${names.join(', ')}`);
  return matches[0]!;
}

function storyUrl(entry: StoryEntry, locale: string, theme: string): string {
  const url = new URL('/iframe.html', origin);
  url.searchParams.set('id', entry.id);
  url.searchParams.set('viewMode', 'story');
  url.searchParams.set('globals', `locale:${locale};theme:${theme}`);
  return url.toString();
}

async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((done, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', done);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No Inbox review Storybook port');
  await new Promise<void>((done, reject) => socket.close((error) => (error ? reject(error) : done())));
  return address.port;
}

async function readyPage(page: Page, entry: StoryEntry, locale: string, theme: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  const url = storyUrl(entry, locale, theme);
  const pageErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.message);
  page.on('pageerror', onPageError);
  try {
    await navigateStory(page, entry.id, url, () => {});
    const outcome = await settle(page, entry.id, pageErrors);
    assertEqual(outcome.status, 'success', `${entry.id} Storybook play succeeds`);
    if (entry.id.startsWith('pages-'))
      await page.locator('main:not([aria-busy="true"])').waitFor({ state: 'visible', timeout: 60_000 });
    return { url: page.url(), outcome };
  } finally {
    page.off('pageerror', onPageError);
  }
}

async function readState(page: Page): Promise<State> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('#storybook-root');
    const rows = [...(root?.querySelectorAll<HTMLElement>('[data-notice-id]') ?? [])];
    const active = document.activeElement as HTMLElement | null;
    return {
      heading: root?.querySelector('h1')?.innerText ?? null,
      text: root?.innerText ?? '',
      noticeCount: rows.length,
      unreadNoticeCount: rows.filter((row) => row.dataset.unread === 'true').length,
      targetLinkCount: rows.filter((row) => row.querySelector('a')).length,
      statusCount: root?.querySelectorAll('[role="status"]').length ?? 0,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      focusedElement: active ? `${active.tagName.toLowerCase()}${active.id ? `#${active.id}` : ''}` : '',
    };
  });
}

async function assertVisualState(page: Page, story: ReviewStory): Promise<void> {
  const rootLocator = page.locator('#storybook-root');
  assertEqual(await rootLocator.count(), 1, `${story.key} has one Storybook root`);
  const rootText = await rootLocator.innerText();
  assertGreater(rootText.trim().length, 0, `${story.key} renders visible content`);

  if (story.key === 'long-content') {
    assertEqual(await page.getByRole('heading', { level: 1 }).count(), 1, 'LongContent has one page heading');
    assertEqual(await page.getByRole('listitem').count(), 3, 'LongContent renders all three notices');
  } else {
    const main = page.getByRole('main');
    assertEqual(await main.count(), 1, `${story.key} uses a single AppShell main region`);
    assertEqual(await main.getByRole('heading', { level: 1 }).count(), 1, `${story.key} has a page heading`);

    if (story.key === 'empty') {
      assertEqual(await main.locator('[data-notice-id]').count(), 0, 'Empty contains no notice rows');
    } else if (story.key === 'mixed') {
      const list = main.getByRole('list');
      assertTrue(await list.getAttribute('aria-label'), 'Mixed notice list has an accessible name');
      assertGreater(await main.locator('[data-notice-id]').count(), 0, 'Mixed includes notice rows');
      assertGreater(await main.locator('[data-unread="true"]').count(), 0, 'Mixed identifies unread notices');
      assertGreater(await main.getByRole('link').count(), 0, 'Mixed exposes readable targets as links');
    } else if (story.key === 'unavailable' || story.key === 'hidden-target') {
      assertGreater(await main.locator('[data-notice-id]').count(), 0, `${story.key} renders the unavailable notice`);
      assertEqual(await main.getByRole('link').count(), 0, `${story.key} does not link a hidden target`);
    } else if (story.key === 'preparing' || story.key === 'closed' || story.key === 'unavailable-operation') {
      const status = main.getByRole('status');
      assertEqual(await status.count(), 1, `${story.key} exposes one status notice`);
      const expectedStatus = story.key === 'preparing' ? '503' : story.key === 'closed' ? '403' : '500';
      assertEqual(
        await status.getAttribute('data-response-status'),
        expectedStatus,
        `${story.key} preserves response status`,
      );
      assertGreater(await status.getByRole('button', { name: /retry/i }).count(), 0, `${story.key} offers retry`);
    } else if (story.key === 'more-than-ninety-nine') {
      assertGreater(await main.locator('[data-notice-id]').count(), 0, 'MoreThanNinetyNine renders notice rows');
      assertGreater(await rootLocator.locator('[aria-label*="99+"]').count(), 0, 'Unread navigation count caps at 99+');
    }
  }

  const geometry = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-notice-id]')];
    const blocks = rows.flatMap((row) => [
      row.querySelector<HTMLElement>('p'),
      row.querySelector<HTMLElement>('[data-notice-byline]')?.parentElement,
    ]);
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      overflow: blocks
        .filter((block): block is HTMLElement => Boolean(block && block.clientWidth > 0))
        .filter((block) => block.scrollWidth > block.clientWidth)
        .map((block) => block.innerText.slice(0, 80)),
    };
  });
  assertEqual(geometry.documentWidth, geometry.viewportWidth, `${story.key} has no horizontal page overflow`);
  assertEqual(geometry.overflow.length, 0, `${story.key} notice text wraps without horizontal overflow`);
}

async function stateHash(state: State): Promise<string> {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

beforeAll(async () => {
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  mkdirSync(captureDirectory, { recursive: true });
  child = Bun.spawn(
    ['bun', 'run', 'storybook', '--ci', '--host', '127.0.0.1', '--port', String(port), '--exact-port'],
    {
      cwd: app,
      env: {
        ...process.env,
        CACHE_DIR: join(evidenceDirectory, 'storybook-cache'),
        STORYBOOK_DISABLE_TELEMETRY: '1',
      },
      detached: true,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  storybookCustody = ownBunProcess(child, { label: 'Inbox quality Storybook' });
  const deadline = Date.now() + 180_000;
  let indexBody = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Inbox quality Storybook exited with ${child.exitCode}:\n${storybookCustody.diagnostics()}`);
    try {
      const response = await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        indexBody = await response.text();
        break;
      }
    } catch {}
    await Bun.sleep(250);
  }
  if (!indexBody) throw new Error(`Inbox quality Storybook did not start:\n${storybookCustody.diagnostics()}`);
  storyIndexSha256 = createHash('sha256').update(indexBody).digest('hex');
  storyEntries = Object.values((JSON.parse(indexBody) as StoryIndex).entries);
  browser = await chromium.launch();
}, 210_000);

afterAll(async () => {
  await cleanupAll([
    { label: 'Inbox quality browser', run: () => browser?.close(), timeoutMs: 5000 },
    { label: 'Inbox quality Storybook process group', run: () => storybookCustody?.close(), timeoutMs: 7000 },
  ]);
});

test('measure the existing Inbox Page and pattern review matrix with source-bound route/story evidence', async () => {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assertTrue(/^[0-9a-f]{40}$/u.test(sourceCommit), 'Captures bind to a full source commit');
  const visualStories: ReviewStory[] = [
    { key: 'empty', family: 'page', entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', ['Empty']) },
    {
      key: 'mixed',
      family: 'page',
      reference: true,
      entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', ['Mixed replies and moderation']),
    },
    {
      key: 'unavailable',
      family: 'page',
      entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', ['Unavailable item']),
    },
    {
      key: 'preparing',
      family: 'page',
      entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', ['Service unavailable (503)']),
    },
    {
      key: 'closed',
      family: 'page',
      entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', ['Inbox closed']),
    },
    {
      key: 'unavailable-operation',
      family: 'page',
      entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', ['Inbox unavailable']),
    },
    {
      key: 'more-than-ninety-nine',
      family: 'page',
      entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', ['More than 99 unread']),
    },
    {
      key: 'hidden-target',
      family: 'pattern',
      entry: findStory('Patterns/Account/Inbox', '/stories/inbox-patterns.stories.tsx', [
        'Hidden Target',
        'HiddenTarget',
      ]),
    },
    {
      key: 'long-content',
      family: 'pattern',
      entry: findStory('Patterns/Account/Inbox', '/stories/inbox-patterns.stories.tsx', [
        'Long Content',
        'LongContent',
      ]),
    },
  ];
  const interactionStories = [
    {
      key: 'viewer-becomes-unknown',
      entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', ['Signed-in viewer becomes unknown']),
      viewport: viewports[0],
      verify: async (page: Page) => {
        assertEqual(
          await page.getByRole('main').locator('[data-notice-id]').count(),
          0,
          'Unknown viewer sees no stale notice rows',
        );
        assertEqual(await page.getByRole('main').getByRole('list').count(), 0, 'Unknown viewer receives no stale list');
      },
    },
    {
      key: 'seen-viewer-becomes-unknown',
      entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', [
        'Viewer changes while mark seen is waiting',
      ]),
      viewport: viewports[0],
      verify: async (page: Page) => {
        assertEqual(
          await page.getByRole('main').locator('[data-notice-id]').count(),
          0,
          'Viewer change retires notices during mark-seen',
        );
        assertEqual(
          await page.getByRole('main').getByRole('button', { name: /retry/i }).count(),
          0,
          'Retired viewer gets no stale retry',
        );
      },
    },
    {
      key: 'seen-retry-after-recovery',
      entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', [
        'Mark seen waits, then retries the original notice after pagination',
      ]),
      viewport: viewports[0],
      verify: async (page: Page) => {
        assertGreater(
          await page.getByRole('main').locator('[data-notice-id]').count(),
          0,
          'Mark-seen recovery retains the Inbox rows',
        );
        assertEqual(
          await page.getByRole('main').locator('[data-response-status="429"]').count(),
          0,
          'Successful deliberate retry clears the rate-limit notice',
        );
      },
    },
    {
      key: 'pagination-recovery',
      entry: findStory('Patterns/Account/Inbox', '/stories/inbox-patterns.stories.tsx', [
        'Pagination Recovery',
        'PaginationRecovery',
      ]),
      viewport: viewports[1],
      verify: async (page: Page) => {
        assertEqual(await page.getByRole('listitem').count(), 3, 'Continuation recovery retains all three notice rows');
        assertEqual(
          await page.getByRole('button', { name: /load more/i }).count(),
          0,
          'Completed continuation removes its control',
        );
      },
    },
    {
      key: 'rejected-continuation',
      entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', [
        'Rejected continuation with separate first-page choice',
      ]),
      viewport: viewports[0],
      verify: async (page: Page) => {
        assertEqual(
          await page.getByRole('main').getByRole('status').getAttribute('data-response-status'),
          '409',
          'Rejected continuation remains explicit',
        );
        assertTrue(
          await page
            .getByRole('main')
            .getByRole('button', { name: /start first page/i })
            .isEnabled(),
          'First-page restart remains deliberate',
        );
      },
    },
    {
      key: 'first-page-restart-retry',
      entry: findStory('Pages/Account/Inbox', '/stories/inbox.stories.tsx', [
        'First-page restart unavailable, then deliberate retry',
      ]),
      viewport: viewports[0],
      verify: async (page: Page) => {
        assertEqual(
          await page.getByRole('main').locator('[data-notice-id]').count(),
          1,
          'Deliberate retry restores the selected first-page result',
        );
        assertEqual(
          await page.getByRole('main').locator('[data-response-status]').count(),
          0,
          'Deliberate retry clears the first-page failure',
        );
      },
    },
  ];

  const context = await browser!.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await context.addInitScript(observeStorybook);
  const page = await context.newPage();
  const captures: Record<string, unknown>[] = [];
  const interactions: Record<string, unknown>[] = [];
  const referenceVariants = [
    ...launchLocales.map((locale) => ({ locale, theme: 'light' as const })),
    { locale: 'en', theme: 'dark' as const },
    { locale: 'ja', theme: 'dark' as const },
  ];
  const otherVariants = ['en', 'zh-Hans'].flatMap((locale) =>
    (['light', 'dark'] as const).map((theme) => ({ locale, theme })),
  );

  try {
    for (const viewport of viewports) {
      for (const story of visualStories) {
        const variants = story.reference ? referenceVariants : otherVariants;
        for (const { locale, theme } of variants) {
          const { url } = await readyPage(page, story.entry, locale, theme, viewport.width, viewport.height);
          await assertVisualState(page, story);
          const pageState = await readState(page);
          assertEqual(pageState.viewportWidth, viewport.width, `${story.key} renders at the requested viewport width`);
          await page.evaluate(() => window.scrollTo(0, 0));
          const imagePath = join(captureDirectory, `${story.entry.id}.${viewport.width}.${locale}.${theme}.png`);
          await page.screenshot({ path: imagePath, type: 'png', fullPage: true, animations: 'disabled', scale: 'css' });
          const imageSha256 = createHash('sha256').update(readFileSync(imagePath)).digest('hex');
          captures.push({
            storyKey: story.key,
            storyId: story.entry.id,
            storyTitle: story.entry.title,
            sourceCommit,
            url,
            viewport: { name: viewport.name, width: viewport.width, height: viewport.height },
            globals: { locale, theme },
            stateSha256: await stateHash(pageState),
            pageState,
            image: relative(root, imagePath).replaceAll('\\', '/'),
            sha256: imageSha256,
          });
        }
      }
    }

    for (const story of interactionStories) {
      const { url } = await readyPage(page, story.entry, 'en', 'light', story.viewport.width, story.viewport.height);
      await story.verify(page);
      const pageState = await readState(page);
      interactions.push({
        storyKey: story.key,
        storyId: story.entry.id,
        sourceCommit,
        url,
        viewport: { name: story.viewport.name, width: story.viewport.width, height: story.viewport.height },
        globals: { locale: 'en', theme: 'light' },
        stateSha256: await stateHash(pageState),
        pageState,
      });
    }
  } finally {
    await page.close();
    await context.close();
  }

  assertEqual(captures.length, 84, 'The documented Inbox review matrix has 84 source-bound captures');
  assertEqual(visualStories.length, 9, 'All seven Page and both named Pattern stories are measured');
  assertGreater(interactions.length, 0, 'Interaction recovery cases are measured');
  assertGreater(assertionCount, 0, 'Review records nonzero route/story assertions');

  const manifest = {
    schemaVersion: 1,
    contractHash,
    sourceCommit,
    storybook: { origin, indexUrl: `${origin}/index.json`, indexSha256: storyIndexSha256 },
    evidenceBoundary: 'Storybook route/story fixtures only; these are not native persona or API evidence.',
    reviewMatrix: {
      referenceStory: 'Pages/Account/Inbox Mixed',
      locales: [...launchLocales],
      referenceThemes: { light: [...launchLocales], dark: ['en', 'ja'] },
      otherStories: visualStories.filter((story) => !story.reference).map((story) => story.key),
      otherLocales: ['en', 'zh-Hans'],
      otherThemes: ['light', 'dark'],
      viewports: viewports.map(({ name, width, height }) => ({ name, width, height })),
    },
    counts: {
      visualStories: visualStories.length,
      visualCases: captures.length,
      interactionCases: interactions.length,
      assertions: assertionCount,
      totalCases: captures.length + interactions.length,
    },
    stories: [
      ...visualStories,
      ...interactionStories.map(({ key, entry }) => ({ key, entry, family: 'interaction' as const })),
    ].map(({ key, entry, family }) => ({
      key,
      family,
      storyId: entry.id,
      title: entry.title,
      name: entry.name,
      importPath: entry.importPath,
    })),
    captures,
    interactions,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assertTrue(readFileSync(manifestPath, 'utf8').includes(sourceCommit), 'Manifest records the checked source revision');
}, 900_000);
