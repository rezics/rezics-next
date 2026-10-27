import { afterAll, expect, test } from 'bun:test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const root = resolve(app, '../..');
const ui = join(root, 'packages/ui');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
const pages = ['home', 'subject', 'missing-subject', 'shell', 'board', 'thread', 'search', 'search-empty'];
const visitors = ['Signed In', 'Signed Out'];
const recorded = join(app, 'src/kernel/recorded');
mkdirSync(join(root, '.temp'), { recursive: true });
const temporary = mkdtempSync(join(root, '.temp/page-stories-'));
const timeout = 900_000;
const executable = (name: string) =>
  [app, ui].map((directory) => join(directory, 'node_modules/.bin', name)).find(existsSync)!;
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let serverPromise: Promise<string> | undefined;
let browserPromise: Promise<Browser> | undefined;

function recordings() {
  return existsSync(recorded) ? [...new Bun.Glob('**/*.json').scanSync({ cwd: recorded })].sort() : [];
}

async function command(args: string[], cwd = app) {
  const run = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1' } });
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

// Copied from session.test.ts: reserve a port and keep the server in its own process group.
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

async function storybook() {
  const port = await freePort();
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  child = spawn(executable('storybook'), ['dev', '--ci', '--host', '127.0.0.1', '--port', String(port)], {
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

function sharedStorybook(): Promise<string> {
  serverPromise ??= storybook();
  return serverPromise;
}

function sharedBrowser(): Promise<Browser> {
  browserPromise ??= chromium.launch().then((opened) => {
    browser = opened;
    return opened;
  });
  return browserPromise;
}

function storyUrl(origin: string, storyId: string, locale: string) {
  return `${origin}/iframe.html?id=${storyId}&viewMode=story&globals=locale:${locale};a11y.manual:!true`;
}

async function openStory(name: string, visitor: string, locale: string) {
  const origin = await sharedStorybook();
  const index = (await (await fetch(`${origin}/index.json`)).json()) as {
    entries: Record<string, { id: string; importPath: string; name: string; type: string }>;
  };
  const entry = Object.values(index.entries).find(
    (candidate) =>
      candidate.type === 'story' &&
      basename(candidate.importPath) === `${name}.stories.tsx` &&
      candidate.name === visitor,
  );
  if (!entry) throw new Error(`Missing ${name} story for ${visitor}.`);
  const context = await (
    await sharedBrowser()
  ).newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await watchStoryReports(page);
  await page.goto(storyUrl(origin, entry.id, locale), { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('main').waitFor();
  return { context, page };
}

async function watchStoryReports(page: Page) {
  await page.addInitScript(() => {
    const finished: { storyId?: string; reporters?: { type?: string }[] }[] = [];
    const target = window as Window & {
      __rezicsStoryFinishes?: typeof finished;
      __STORYBOOK_ADDONS_CHANNEL__?: {
        on?: (event: string, listener: (payload: (typeof finished)[number]) => void) => void;
      };
    };
    target.__rezicsStoryFinishes = finished;
    let attached: typeof target.__STORYBOOK_ADDONS_CHANNEL__;
    const attach = () => {
      const channel = target.__STORYBOOK_ADDONS_CHANNEL__;
      if (!channel) return false;
      if (channel !== attached) {
        attached = channel;
        channel.on?.('storyFinished', (payload) => finished.push(payload));
      }
      return true;
    };
    const interval = window.setInterval(() => {
      if (attach()) window.clearInterval(interval);
    }, 0);
    if (attach()) window.clearInterval(interval);
  });
}

async function finishedStory(page: Page, storyId: string) {
  await page.waitForFunction(
    (id) =>
      (window as Window & { __rezicsStoryFinishes?: { storyId?: string }[] }).__rezicsStoryFinishes?.some(
        (finish) => finish.storyId === id,
      ),
    storyId,
  );
  return page.evaluate((id) => {
    const finished = (
      window as Window & { __rezicsStoryFinishes?: { storyId?: string; reporters?: { type?: string }[] }[] }
    ).__rezicsStoryFinishes;
    return finished?.find((finish) => finish.storyId === id);
  }, storyId);
}

// Follow local imports, so shared replay helpers may own the recordings instead of each story importing JSON directly.
function dependencies(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  if (file.endsWith('.json')) return seen;
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
    const path = resolve(dirname(file), match[1]!);
    const target = [path, `${path}.ts`, `${path}.tsx`, join(path, 'index.ts'), join(path, 'index.tsx')].find(
      (candidate) => existsSync(candidate) && /\.(?:tsx?|json)$/.test(candidate),
    );
    if (target) dependencies(target, seen);
  }
  return seen;
}

afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  rmSync(temporary, { recursive: true, force: true });
});

// Change to test(...) when web has recorded page and shell stories running through the Storybook vitest addon.
test(
  'every page story renders from recorded kernel responses and passes as an accessible browser test',
  async () => {
    const report = join(temporary, 'stories.json');
    // An absent Storybook is an empty story suite, not a missing-config or missing-command failure.
    const fallback = join(temporary, 'empty.config.ts');
    writeFileSync(fallback, `export default { test: { include: ['src/**/*.stories.tsx'], passWithNoTests: true } };\n`);
    const config = existsSync(join(app, 'vitest.config.ts')) ? join(app, 'vitest.config.ts') : fallback;
    const run = await command([
      executable('vitest'),
      'run',
      '--config',
      config,
      '--reporter=json',
      `--outputFile=${report}`,
    ]);
    if (!existsSync(report)) throw new Error(`vitest did not write a JSON report:\n${run.output}`);
    const result = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { name: string; assertionResults: { title: string; status: string }[] }[];
    };
    for (const page of pages)
      for (const visitor of visitors) {
        const passed = result.testResults
          .filter((file) => basename(file.name) === `${page}.stories.tsx`)
          .flatMap((file) => file.assertionResults)
          .filter((assertion) => assertion.title === visitor && assertion.status === 'passed');
        expect(passed.length, `${page}: ${visitor} must pass in the browser`).toBeGreaterThan(0);
      }
    expect(run.code, run.output).toBe(0);
    const main = readFileSync(join(app, '.storybook/main.ts'), 'utf8');
    for (const feature of ['@storybook/react-vite', '@storybook/addon-vitest', '@storybook/addon-a11y'])
      expect(main).toContain(feature);
    expect(readFileSync(config, 'utf8')).toContain('storybookTest');
    expect(readFileSync(config, 'utf8')).toContain('browser');
    const preview = ['preview.ts', 'preview.tsx'].map((name) => join(app, '.storybook', name)).find(existsSync);
    expect(preview, 'the preview exposes the locale toolbar to every story').toBeDefined();
    const previewSource = readFileSync(preview!, 'utf8');
    for (const feature of ['globalTypes', 'locale', 'toolbar', ...locales]) expect(previewSource).toContain(feature);

    const origin = await sharedStorybook();
    const index = (await (await fetch(`${origin}/index.json`)).json()) as {
      entries: Record<string, { id: string; importPath: string; name: string; type: string }>;
    };
    await sharedBrowser();
    const entries = Object.values(index.entries).filter((entry) => entry.type === 'story');
    for (const name of pages)
      for (const visitor of visitors)
        expect(
          entries.some((entry) => basename(entry.importPath) === `${name}.stories.tsx` && entry.name === visitor),
        ).toBe(true);
    for (const entry of entries) {
      const name = basename(entry.importPath, '.stories.tsx');
      const imports = dependencies(resolve(app, entry.importPath));
      expect([...imports].some((file) => file.startsWith(`${recorded}/`) && file.endsWith('.json'))).toBe(true);
      for (const locale of locales) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const external: string[] = [];
        await page.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.origin === origin || !['http:', 'https:'].includes(url.protocol)) return route.continue();
          external.push(url.href);
          await route.abort();
        });
        await page.goto(storyUrl(origin, entry.id, locale), { waitUntil: 'networkidle' });
        await page.locator('html[data-hydrated]').waitFor();
        // Browser steps copied from shell.test.ts; every page includes the real shell landmarks.
        await page.getByRole('main').waitFor();
        expect(await page.getByRole('main').count()).toBe(1);
        expect(await page.getByRole('navigation').count()).toBe(1);
        expect(await page.evaluate(() => document.documentElement.lang)).toBe(locale);
        const own = await Bun.file(join(app, 'messages', `${locale}.json`)).json();
        expect(await page.getByRole('navigation', { name: own.shell_navigation, exact: true }).count()).toBe(1);
        if (entry.name === 'Signed Out')
          expect(
            await page.getByRole('banner').getByRole('link', { name: own.account_sign_in, exact: true }).count(),
          ).toBe(1);
        if (entry.name === 'Signed In') {
          expect(await page.getByRole('link', { name: own.account_sign_in, exact: true }).count()).toBe(0);
          const account = page.getByRole('button', { name: own.account_menu, exact: true });
          const menu = page.getByRole('group', { name: own.account_menu, exact: true });
          if ((await account.count()) && !(await menu.isVisible())) await account.click();
          expect(await page.getByRole('button', { name: own.account_sign_out, exact: true }).count()).toBe(1);
        }
        if (name === 'home' || name === 'missing-subject')
          expect((await page.getByRole('heading', { level: 1 }).textContent())?.trim()).toBe(
            name === 'home' ? own.home_heading : own.not_found_heading,
          );
        if (name === 'subject') {
          const recording = await Bun.file(join(recorded, 'subject.json')).json();
          expect((await page.getByRole('heading', { level: 1 }).textContent())?.trim()).toBe(
            recording.subject.labels[locale] ?? recording.subject.labels.en,
          );
        }
        const a11y = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
          .analyze();
        expect(
          a11y.violations.map((violation) => violation.id),
          `${entry.id} ${locale}`,
        ).toEqual([]);
        expect(external, 'stories replay recordings without contacting Auth or a live kernel').toEqual([]);
        await context.close();
      }
    }
  },
  timeout,
);

test(
  'the board story renders the board route for signed-in and signed-out visitors in English and Traditional Chinese',
  async () => {
    for (const locale of ['en', 'zh-Hant']) {
      const own = await Bun.file(join(app, 'messages', `${locale}.json`)).json();
      const signedIn = await openStory('board', 'Signed In', locale);
      try {
        const main = signedIn.page.getByRole('main');
        expect(await main.getByRole('link', { name: own.board_start_thread, exact: true }).count()).toBe(1);
        expect(await main.getByRole('link', { name: own.account_sign_in, exact: true }).count()).toBe(0);
      } finally {
        await signedIn.context.close();
      }

      const signedOut = await openStory('board', 'Signed Out', locale);
      try {
        const main = signedOut.page.getByRole('main');
        expect(await main.getByRole('link', { name: own.account_sign_in, exact: true }).count()).toBe(1);
        expect(await main.getByRole('link', { name: own.board_start_thread, exact: true }).count()).toBe(0);
      } finally {
        await signedOut.context.close();
      }
    }
  },
  timeout,
);

test(
  'page story iframes disable Storybook accessibility reports before the browser axe check',
  async () => {
    const { context, page } = await openStory('home', 'Signed In', 'en');
    try {
      const storyUrl = new URL(page.url());
      expect(storyUrl.searchParams.get('globals')).toBe('locale:en;a11y.manual:!true');
      const finished = await finishedStory(page, storyUrl.searchParams.get('id')!);
      expect(finished?.reporters?.filter((report) => report.type === 'a11y')).toEqual([]);
      const a11y = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      expect(a11y.violations.map((violation) => violation.id)).toEqual([]);
    } finally {
      await context.close();
    }
  },
  timeout,
);

test(
  'the thread story renders the thread route for signed-in and signed-out visitors in English and Traditional Chinese',
  async () => {
    for (const locale of ['en', 'zh-Hant']) {
      const own = await Bun.file(join(app, 'messages', `${locale}.json`)).json();
      const signedIn = await openStory('thread', 'Signed In', locale);
      try {
        const main = signedIn.page.getByRole('main');
        await main.getByRole('textbox', { name: own.thread_reply_body_label, exact: true }).waitFor();
        expect(await main.getByRole('button', { name: own.thread_write_send, exact: true }).count()).toBe(1);
        expect(await main.getByRole('link', { name: own.account_sign_in, exact: true }).count()).toBe(0);
      } finally {
        await signedIn.context.close();
      }

      const signedOut = await openStory('thread', 'Signed Out', locale);
      try {
        const main = signedOut.page.getByRole('main');
        expect(await main.getByRole('link', { name: own.account_sign_in, exact: true }).count()).toBe(1);
        expect(await main.getByRole('textbox', { name: own.thread_reply_body_label, exact: true }).count()).toBe(0);
        expect(await main.getByRole('button', { name: own.thread_write_send, exact: true }).count()).toBe(0);
      } finally {
        await signedOut.context.close();
      }
    }
  },
  timeout,
);

// Change to test(...) when every recorded JSON response satisfies its kernel client response contract.
test(
  'each recorded response type-checks against the kernel client',
  async () => {
    const files = recordings();
    const module = join(temporary, 'recordings.ts');
    const source = [
      "import type { Kernel, KernelClient } from '@rezics/client';",
      'type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };',
      "type Read = Awaited<ReturnType<ReturnType<KernelClient['subjects']>['get']>>;",
      "type SubjectResponse = NonNullable<Read['data']>;",
      "type MissingResponse = Extract<NonNullable<Read['error']>, { status: 404 | '404' }>['value'];",
      "type BoardResource = ReturnType<KernelClient['boards']>;",
      "type BoardResponse = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>;",
      "type BoardThreadsResponse = NonNullable<Awaited<ReturnType<BoardResource['threads']['get']>>['data']>;",
      // Eden merges threads/:id with threads/:threadId, so ReturnType of threads() has no get or posts.
      "type Routes = Kernel extends { '~Routes': infer Schema } ? Schema : never;",
      'type ThreadRoutes = Routes extends { v1: { threads: infer Threads } } ? Threads : never;',
      "type ThreadNode = ThreadRoutes extends { ':id': infer Node } ? Node : never;",
      'type ThreadResponse = ThreadNode extends { get: { response: { 200: infer Body } } } ? Body : never;',
      'type PostsResponse = ThreadNode extends { posts: { get: { response: { 200: infer Body } } } } ? Body : never;',
      "type SearchResponse = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>;",
      "type PageReadResult = Awaited<ReturnType<KernelClient['pages']['$read']['post']>>;",
      "type PageResponse = NonNullable<PageReadResult['data']>;",
      "type PageMissingResponse = Extract<NonNullable<PageReadResult['error']>, { status: 404 | '404' }>['value'];",
    ];
    const responseType: Record<string, string> = {
      'missing-subject.json': 'MissingResponse',
      'missing-subject-page.json': 'PageMissingResponse',
      'home-page.json': 'PageResponse',
      'subject.json': 'SubjectResponse',
      'subject-page.json': 'PageResponse',
      'board.json': 'BoardResponse',
      'board-threads.json': 'BoardThreadsResponse',
      'thread.json': 'ThreadResponse',
      'thread-posts.json': 'PostsResponse',
      'search.json': 'SearchResponse',
      'search-empty.json': 'SearchResponse',
    };
    files.forEach((file, index) => {
      const path = join(recorded, file);
      const json = readFileSync(path, 'utf8').trim();
      source.push(`import recording${index} from ${JSON.stringify(path)};`);
      // JSON imports widen discriminants to string. Restore only the exact literal shape read from that same file.
      source.push(`const literal${index} = ${json} as const;`);
      source.push(
        `(recording${index} as Mutable<typeof literal${index}>) satisfies ${responseType[basename(file)] ?? 'SubjectResponse'};`,
      );
    });
    writeFileSync(module, `${source.join('\n')}\n`);
    const config = join(temporary, 'tsconfig.json');
    writeFileSync(
      config,
      JSON.stringify({
        extends: join(root, 'tsconfig.base.json'),
        compilerOptions: {
          resolveJsonModule: true,
          types: ['bun'],
          paths: { '@rezics/client': [join(root, 'packages/client/src/index.ts')] },
        },
        files: [module],
      }),
    );
    const run = await command([join(root, 'node_modules/.bin/tsc'), '--noEmit', '-p', config]);
    expect(run.code, run.output).toBe(0);
    expect(files, 'a successful empty compilation does not cover the recorded page responses').toEqual(
      expect.arrayContaining([
        'subject.json',
        'missing-subject.json',
        'board.json',
        'board-threads.json',
        'thread.json',
        'thread-posts.json',
        'search.json',
        'search-empty.json',
      ]),
    );
  },
  timeout,
);
