import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { cleanupAll, ownNodeProcess, type ProcessCustody } from './support/server-custody.ts';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { requestLanguages } from '../src/kernel/languages';
import searchRecording from '../src/kernel/recorded/search.json' with { type: 'json' };

const app = join(import.meta.dir, '..');
const timeout = 900_000;
const executable = (name: string) => join(app, 'node_modules/.bin', name);
let child: ChildProcess | undefined;
let storybookCustody: ProcessCustody | undefined;
let browser: Browser | undefined;
let serverPromise: Promise<string> | undefined;
const browserErrors = new WeakMap<Page, string[]>();
const expectedBasicSearchIds = ['01a1773a-f700-7078-8000-000000000001', '01a17dfd-5dbf-738a-9405-9dfa9a8ec069'];

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
  child = spawn(executable('storybook'), ['dev', '--ci', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: app,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1' },
  });
  const custody = (storybookCustody = ownNodeProcess(child, { label: 'Search identity Storybook' }));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Storybook exited with ${child.exitCode}:\n${custody.diagnostics()}`);
    try {
      if ((await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(10_000) })).ok) return origin;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Storybook did not serve its index in time:\n${custody.diagnostics()}`);
    await Bun.sleep(500);
  }
}

afterAll(async () => {
  await cleanupAll([
    { label: 'Search identity browser', run: () => browser?.close(), timeoutMs: 5000 },
    { label: 'Search identity Storybook group', run: () => storybookCustody?.close(), timeoutMs: 7000 },
  ]);
});

async function openStory(visitor: 'Signed In' | 'Signed Out', locale: string): Promise<Page> {
  serverPromise ??= storybook();
  const origin = await serverPromise;
  const index = (await (await fetch(`${origin}/index.json`)).json()) as {
    entries: Record<string, { id: string; importPath: string; name: string; type: string }>;
  };
  const storyName = visitor === 'Signed In' ? 'Member' : 'Signed out';
  const entry = Object.values(index.entries).find(
    (candidate) =>
      candidate.type === 'story' &&
      basename(candidate.importPath) === 'search-rating.stories.tsx' &&
      candidate.name === storyName,
  );
  if (!entry) throw new Error(`Missing Pages/Discovery/Search ${storyName} story.`);
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:'))
      errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const pathname = new URL(response.url()).pathname;
    const optionalStorybookInjector = pathname === '/vite-inject-mocker-entry.js';
    const blockedDevelopmentFont = /^\/@fs\/.*\/node_modules\/.*\.(?:woff2?|ttf|otf)$/.test(pathname);
    if (!optionalStorybookInjector && !blockedDevelopmentFont) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/iframe.html?id=${entry.id}&viewMode=story&globals=locale:${locale}`, {
    waitUntil: 'networkidle',
  });
  await page.getByRole('main').waitFor();
  return page;
}

async function storyTransportSubjects(locale: string): Promise<
  {
    id: string;
    labels: Record<string, string>;
    descriptions?: Record<string, string>;
  }[]
> {
  const fetchKernel = createStoryRecordedKernelFetch();
  const response = await fetchKernel('http://kernel.local/v1/subjects:search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: searchRecording.query,
      limit: 100,
      descriptions: true,
      languages: requestLanguages(locale),
    }),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    subjects: { id: string; labels: Record<string, string>; descriptions?: Record<string, string> }[];
  };
  return result.subjects;
}

function subjectIdFromHref(href: string): string {
  const id = /\/subjects\/([^/]+)/.exec(new URL(href, 'http://rezics.local').pathname)?.[1];
  if (!id) throw new Error(`A Search result link has no subject id: ${href}`);
  return decodeURIComponent(id);
}

test(
  'Pages/Search renders each actual localized transport subject once with its own route link',
  async () => {
    for (const locale of ['en', 'zh-Hans']) {
      const transportSubjects = await storyTransportSubjects(locale);
      const transportIds = transportSubjects.map(({ id }) => id);
      expect([...transportIds].sort(), `${locale} default Search subject identities`).toEqual(
        [...expectedBasicSearchIds].sort(),
      );
      expect(new Set(transportIds).size, `${locale} transport IDs`).toBe(transportIds.length);
      for (const visitor of ['Signed In', 'Signed Out'] as const) {
        const page = await openStory(visitor, locale);
        try {
          const renderedRows = page.locator('main [data-slot="list-row"]');
          await renderedRows.first().waitFor();
          const rows = await renderedRows.evaluateAll((elements) =>
            elements.map((element) => element.querySelector<HTMLAnchorElement>('a[href*="/subjects/"]')?.href ?? ''),
          );
          const renderedIds = rows.map(subjectIdFromHref);
          expect(renderedIds, `${visitor}, ${locale} rendered subject links`).toEqual(transportIds);
          expect(new Set(renderedIds).size, `${visitor}, ${locale} rendered IDs`).toBe(renderedIds.length);
          for (const [index, subject] of transportSubjects.entries()) {
            const row = renderedRows.nth(index);
            const title = row.getByRole('link');
            expect(Object.values(subject.labels)).toContain(await title.innerText());
            const descriptionValues = Object.values(subject.descriptions ?? {}).filter(Boolean);
            if (descriptionValues.length > 0) {
              const rowText = await row.innerText();
              expect(descriptionValues.some((description) => rowText.includes(description))).toBe(true);
            }
          }
          expect(browserErrors.get(page), `${visitor}, ${locale} browser console`).toEqual([]);
        } finally {
          await page.context().close();
        }
      }
    }
  },
  timeout,
);
