import { afterAll, expect, test } from 'bun:test';
import AxeBuilder from '@axe-core/playwright';
import { documentText } from '@rezics/document';
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
const englishTextExceptions: { story: string; locale: string; text: string }[] = [];
const englishHomeTypeNames = new Set(['Book', 'TV Series', 'Recipe']);
const englishMessages = Bun.file(join(app, 'messages/en.json')).json() as Promise<Record<string, unknown>>;
const definitionsRelease = Bun.file(join(recorded, 'definitions-release.json')).json() as Promise<{
  release: { types: Record<string, { labels?: Record<string, string> }> };
}>;
mkdirSync(join(root, '.temp'), { recursive: true });
const temporary = mkdtempSync(join(root, '.temp/page-stories-'));
const timeout = 1_800_000;
const executable = (name: string) =>
  [app, ui].map((directory) => join(directory, 'node_modules/.bin', name)).find(existsSync)!;
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let serverPromise: Promise<string> | undefined;
let browserPromise: Promise<Browser> | undefined;

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

async function visibleTextNodes(page: Page, selector?: string): Promise<string[]> {
  return page.evaluate((rootSelector) => {
    const roots = rootSelector ? [...document.querySelectorAll(rootSelector)] : [document.body];
    const result: string[] = [];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue ?? '';
        const element = node.parentElement;
        if (!text.trim() || !element || element.getClientRects().length === 0) continue;
        let visible = true;
        for (let current: HTMLElement | null = element; current; current = current.parentElement) {
          const style = window.getComputedStyle(current);
          if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) {
            visible = false;
            break;
          }
        }
        if (visible) result.push(text);
      }
    }
    return result;
  }, selector);
}

async function englishTextHits(page: Page, story: string, locale: string, own: Record<string, unknown>) {
  const [english, definitions] = await Promise.all([englishMessages, definitionsRelease]);
  const candidates = new Set<string>();
  for (const [key, value] of Object.entries(english))
    if (typeof value === 'string' && own[key] !== value) candidates.add(value);
  for (const type of Object.values(definitions.release.types))
    if (type.labels?.en && type.labels[locale] !== type.labels.en) candidates.add(type.labels.en);
  return (await visibleTextNodes(page)).filter(
    (text) =>
      candidates.has(text) &&
      !englishTextExceptions.some(
        (exception) => exception.story === story && exception.locale === locale && exception.text === text,
      ),
  );
}

async function expectHomeCardsWithoutTypeLines(page: Page, story: string, locale: string) {
  expect(
    await page.locator('[data-slot="cover-card-secondary"]').count(),
    `${story} ${locale}: home type rows and Continue cards have no type line under the title`,
  ).toBe(0);
  if (locale === 'zh-Hans') {
    const cardTexts = await visibleTextNodes(page, '[data-slot="cover-card"]');
    expect(
      cardTexts.filter((text) => englishHomeTypeNames.has(text)),
      `${story} ${locale}: home cards do not show English type names`,
    ).toEqual([]);
  }
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
    const a11yFailures: string[] = [];
    for (const entry of entries) {
      const name = basename(entry.importPath, '.stories.tsx');
      const imports = dependencies(resolve(app, entry.importPath));
      expect([...imports].some((file) => file.startsWith(`${recorded}/`) && file.endsWith('.json'))).toBe(true);
      // The locales are separate pages with separate axe runs, so they check side by side.
      await Promise.all(
        locales.map(async (locale) => {
          const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
          const page = await context.newPage();
          const external: string[] = [];
          await page.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.origin === origin || !['http:', 'https:'].includes(url.protocol)) return route.continue();
            external.push(url.href);
            await route.abort();
          });
          // The a11y addon runs axe after every story unless its manual global is set; two runs in one page collide, so
          // this page is checked by AxeBuilder alone.
          await page.goto(
            `${origin}/iframe.html?id=${entry.id}&viewMode=story&globals=locale:${locale};a11y.manual:!true`,
            {
              waitUntil: 'networkidle',
            },
          );
          await page.locator('html[data-hydrated]').waitFor();
          // Browser steps copied from shell.test.ts; every page includes the real shell landmarks.
          const main = page.getByRole('main');
          await main.waitFor();
          expect(await main.count()).toBe(1);
          // Secondary navigation is allowed when every navigation landmark has a name.
          expect(await page.getByRole('navigation', { name: /\S/ }).count()).toBe(
            await page.getByRole('navigation').count(),
          );
          expect(await page.evaluate(() => document.documentElement.lang)).toBe(locale);
          const own = await Bun.file(join(app, 'messages', `${locale}.json`)).json();
          if (name === 'home') await expectHomeCardsWithoutTypeLines(page, entry.id, locale);
          expect(await page.getByRole('navigation', { name: own.shell_navigation, exact: true }).count()).toBe(1);
          const heading = main.getByRole('heading', { level: 1 }).first();
          await heading.waitFor();
          const headingText = (await heading.textContent())?.trim();
          if (!/(missing|error)/i.test(name))
            for (const key of ['not_found_heading', 'error_heading', 'platform_closed_heading'])
              expect(headingText, `${name} does not show ${key} in ${locale}`).not.toBe(own[key]);
          if (entry.name === 'Signed Out')
            expect(
              await page.getByRole('banner').getByRole('link', { name: own.account_sign_in, exact: true }).count(),
            ).toBe(1);
          if (entry.name === 'Signed In') {
            expect(await page.getByRole('link', { name: own.account_sign_in, exact: true }).count()).toBe(0);
            const account = page.getByRole('button', { name: own.account_menu, exact: true });
            const menu = page.getByRole('group', { name: own.account_menu, exact: true });
            if ((await account.count()) && !(await menu.isVisible())) await account.click();
            expect(await menu.getByRole('button', { name: own.account_sign_out, exact: true }).count()).toBe(1);
          }
          if (name === 'home' || name === 'missing-subject')
            expect(headingText).toBe(name === 'home' ? own.home_heading : own.not_found_heading);
          if (name === 'subject') {
            const recording = await Bun.file(join(recorded, 'subject.json')).json();
            expect(headingText).toBe(recording.subject.labels[locale] ?? recording.subject.labels.en);
          }
          if (locale !== 'en') {
            const hits = await englishTextHits(page, entry.id, locale, own);
            expect(
              hits.map((text) => `${entry.id}, ${locale}, ${text}`),
              'non-English page stories contain no English message or type label text nodes',
            ).toEqual([]);
          }
          const a11y = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
            .analyze();
          a11yFailures.push(...a11y.violations.map((violation) => `${entry.id} ${locale}: ${violation.id}`));
          expect(external, 'stories replay recordings without contacting Auth or a live kernel').toEqual([]);
          await context.close();
        }),
      );
    }
    expect(a11yFailures).toEqual([]);
    expect(run.code, run.output).toBe(0);
  },
  timeout,
);

test(
  'every non-English page story contains no untranslated message or type-name text',
  async () => {
    const origin = await sharedStorybook();
    const index = (await (await fetch(`${origin}/index.json`)).json()) as {
      entries: Record<string, { id: string; importPath: string; name: string; type: string }>;
    };
    const entries = Object.values(index.entries).filter(
      (entry) => entry.type === 'story' && pages.includes(basename(entry.importPath, '.stories.tsx')),
    );
    const checked = new Set<string>();
    for (const pageName of pages)
      for (const visitor of visitors) {
        const entry = entries.find(
          (candidate) => basename(candidate.importPath, '.stories.tsx') === pageName && candidate.name === visitor,
        );
        expect(entry, `${pageName}: ${visitor} page story exists`).toBeDefined();
        checked.add(entry!.id);
      }
    expect(checked.size, 'language checks include every page story').toBe(pages.length * visitors.length);

    const allHits: string[] = [];
    for (const entry of entries) {
      const pageName = basename(entry.importPath, '.stories.tsx');
      const localeHits = await Promise.all(
        locales
          .filter((locale) => locale !== 'en')
          .map(async (locale) => {
            const context = await (
              await sharedBrowser()
            ).newContext({
              viewport: { width: 1280, height: 860 },
              reducedMotion: 'reduce',
            });
            const page = await context.newPage();
            await page.route('**/*', async (route) => {
              const url = new URL(route.request().url());
              if (url.origin === origin || !['http:', 'https:'].includes(url.protocol)) return route.continue();
              await route.abort();
            });
            try {
              await page.goto(storyUrl(origin, entry.id, locale), { waitUntil: 'networkidle' });
              await page.locator('html[data-hydrated]').waitFor();
              const main = page.getByRole('main');
              await main.waitFor();
              expect(await page.evaluate(() => document.documentElement.lang)).toBe(locale);
              const own = await Bun.file(join(app, 'messages', `${locale}.json`)).json();
              const hits = await englishTextHits(page, entry.id, locale, own);
              if (pageName === 'home') await expectHomeCardsWithoutTypeLines(page, entry.id, locale);
              return hits.map((text) => `${entry.id}, ${locale}, ${text}`);
            } finally {
              await context.close();
            }
          }),
      );
      allHits.push(...localeHits.flat());
    }
    expect(allHits, 'non-English page stories contain no untranslated message or type-name text').toEqual([]);
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
        expect(await main.getByRole('link', { name: own.board_sign_in_to_start, exact: true }).count()).toBe(1);
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
        expect(await main.getByRole('link', { name: own.threads_sign_in_to_reply, exact: true }).count()).toBe(1);
        expect(await main.getByRole('textbox', { name: own.thread_reply_body_label, exact: true }).count()).toBe(0);
        expect(await main.getByRole('button', { name: own.thread_write_send, exact: true }).count()).toBe(0);
      } finally {
        await signedOut.context.close();
      }
    }
  },
  timeout,
);

test(
  'the offer page and the order page have stories from recorded responses: paid, pending and failed orders, a long CJK title and a missing cover',
  async () => {
    const read = (name: string) => Bun.file(join(recorded, `${name}.json`)).json();
    const offer = await read('offer');
    const cjk = await read('offer-cjk');
    const delisted = await read('offer-delisted');
    const orders = {
      Paid: await read('order-paid'),
      Pending: await read('order-pending'),
      Failed: await read('order-failed'),
    };
    expect(orders.Paid.order.settlement).toBe('paid');
    expect(orders.Pending.order.settlement).toBe('pending');
    expect(orders.Failed.order.settlement).toBe('failed');
    expect(cjk.offer.title, 'the long title is CJK text').toMatch(/\p{Script=Han}/u);
    expect([...cjk.offer.title].length).toBeGreaterThanOrEqual(30);
    expect(delisted.offer.state).toBe('delisted');
    for (const recording of [offer, cjk, delisted])
      expect(Object.keys(recording.offer), 'the kernel offer carries no cover').not.toContain('cover');

    const price = (locale: string, recording: typeof offer) => {
      const currency = recording.offer.currency.toUpperCase();
      const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits!;
      return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
        recording.offer.unitAmountMinor / 10 ** digits,
      );
    };
    for (const locale of ['en', 'zh-Hans']) {
      const own = await Bun.file(join(app, 'messages', `${locale}.json`)).json();
      for (const [name, recording] of [
        ['Signed In', offer],
        ['Signed Out', offer],
        ['Long CJK Title', cjk],
      ] as const) {
        const opened = await openStory('offer', name, locale);
        try {
          const main = opened.page.getByRole('main');
          expect((await main.getByRole('heading', { level: 1 }).textContent())?.trim()).toBe(recording.offer.title);
          await main.getByText(price(locale, recording), { exact: true }).waitFor();
          expect(await main.getByRole('button', { name: own.offer_buy, exact: true }).isEnabled()).toBe(true);
          expect(await main.locator('img').count(), 'a missing cover leaves no broken image').toBe(0);
        } finally {
          await opened.context.close();
        }
      }
      const unavailable = await openStory('offer', 'Delisted', locale);
      try {
        const main = unavailable.page.getByRole('main');
        await main.getByText(own.offer_unavailable, { exact: true }).waitFor();
        expect(await main.getByRole('button', { name: own.offer_buy, exact: true }).isDisabled()).toBe(true);
      } finally {
        await unavailable.context.close();
      }
      for (const [name, key] of [
        ['Paid', 'order_paid'],
        ['Pending', 'order_pending'],
        ['Failed', 'order_failed'],
      ] as const) {
        const opened = await openStory('order', name, locale);
        try {
          const main = opened.page.getByRole('main');
          expect((await main.getByRole('heading', { level: 1 }).textContent())?.trim()).toBe(own[key]);
        } finally {
          await opened.context.close();
        }
      }
      const canceled = await openStory('order', 'Canceled', locale);
      try {
        const main = canceled.page.getByRole('main');
        await main.getByText(own.order_canceled, { exact: true }).waitFor();
        expect(await main.getByRole('link', { name: own.order_back, exact: true }).count()).toBe(1);
      } finally {
        await canceled.context.close();
      }
    }
  },
  timeout,
);

test(
  'the post editor has stories for a new thread, a reply and an edit of an existing post, from recorded responses',
  async () => {
    const owned = await Bun.file(join(recorded, 'thread-owned-posts.json')).json();
    const text = JSON.stringify(owned.posts[0].body);
    const phrase: string = /"text":"([^"]+)"/.exec(text)![1]!;
    for (const locale of ['en', 'zh-Hant']) {
      const own = await Bun.file(join(app, 'messages', `${locale}.json`)).json();
      const created = await openStory('composer', 'New Thread', locale);
      try {
        const main = created.page.getByRole('main');
        await main.getByRole('textbox', { name: own.thread_title_label, exact: true }).waitFor();
        await main.getByText(own.thread_new_body_label, { exact: true }).first().waitFor();
        expect(await main.getByRole('button', { name: own.thread_write_send, exact: true }).isDisabled()).toBe(true);
      } finally {
        await created.context.close();
      }

      const reply = await openStory('composer', 'Reply', locale);
      try {
        const main = reply.page.getByRole('main');
        await main.getByRole('textbox', { name: own.thread_reply_body_label, exact: true }).waitFor();
        expect(await main.getByRole('textbox', { name: own.thread_title_label, exact: true }).count()).toBe(0);
        await main.getByRole('button', { name: own.thread_write_send, exact: true }).waitFor();
        expect(await main.getByRole('button', { name: own.thread_edit_save, exact: true }).count()).toBe(0);
      } finally {
        await reply.context.close();
      }

      const edit = await openStory('composer', 'Edit', locale);
      try {
        const main = edit.page.getByRole('main');
        await main.getByRole('button', { name: own.thread_edit_save, exact: true }).waitFor();
        await main.getByRole('button', { name: own.thread_edit_cancel, exact: true }).waitFor();
        await main.getByText(phrase, { exact: false }).first().waitFor();
      } finally {
        await edit.context.close();
      }
    }
  },
  timeout,
);

test(
  'the subject story shows its description, its statements with linked values, and its editions',
  async () => {
    const recording = await Bun.file(join(recorded, 'subject.json')).json();
    const page = await Bun.file(join(recorded, 'subject-page.json')).json();
    const statements = recording.subject.statements;
    const description: string | undefined = recording.subject.descriptions.en;
    const author: string | undefined = recording.related[statements['schema:author']?.[0]?.value.content]?.labels.en;
    const published = statements['schema:datePublished']?.[0]?.value.content;
    const edition: string | undefined = Object.values<{ body: { links?: { label?: string }[] } }>(page.reads).find(
      (read) => read.body.links,
    )?.body.links?.[0]?.label;
    expect(description, 'the recorded subject has an English description').toBeTruthy();
    expect(Object.keys(recording.subject.descriptions)).toEqual(expect.arrayContaining(['en', 'ja']));
    expect(author, 'the recorded subject has a linked author').toBeTruthy();
    expect(published, 'the recorded subject has a publication date').toBeTruthy();
    expect(edition, 'the recorded page lists an edition').toBeTruthy();
    const date = new Intl.DateTimeFormat('en', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date(published.time.replace(/^\+/, '').replace('T00:00:00Z', 'T00:00:00.000Z')));

    const opened = await openStory('subject', 'Signed Out', 'en');
    try {
      const main = opened.page.getByRole('main');
      const summary = statements['schema:abstract'][0].value.content.document;
      await main.getByText(documentText(summary), { exact: true }).first().waitFor({ state: 'visible' });
      await main.getByRole('link', { name: author!, exact: true }).first().waitFor({ state: 'visible' });
      await main.getByText(date, { exact: true }).first().waitFor({ state: 'visible' });
      await main.getByRole('link', { name: edition!, exact: true }).first().waitFor({ state: 'visible' });
    } finally {
      await opened.context.close();
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
      "type LinksRead = Awaited<ReturnType<ReturnType<KernelClient['subjects']>['links']['get']>>;",
      "type LinksResponse = NonNullable<LinksRead['data']>;",
      "type MissingResponse = Extract<NonNullable<Read['error']>, { status: 404 | '404' }>['value'];",
      "type SubjectReactionsResponse = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['reactions']['get']>>['data']>;",
      // The generated client declarations do not carry the subject's own-reaction route yet.
      "type SubjectOwnReactionResponse = { kind: 'like' | 'love' | 'laugh' | 'insightful' | 'sad' | null };",
      "type BoardResource = ReturnType<KernelClient['boards']>;",
      "type BoardResponse = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>;",
      "type BoardThreadsResponse = NonNullable<Awaited<ReturnType<BoardResource['threads']['get']>>['data']>;",
      "type AccountsResponse = NonNullable<Awaited<ReturnType<KernelClient['accounts']['get']>>['data']>;",
      // Eden merges threads/:id with threads/:threadId, so ReturnType of threads() has no get or posts.
      "type Routes = Kernel extends { '~Routes': infer Schema } ? Schema : never;",
      'type ThreadRoutes = Routes extends { v1: { threads: infer Threads } } ? Threads : never;',
      "type ThreadNode = ThreadRoutes extends { ':id': infer Node } ? Node : never;",
      'type ThreadResponse = ThreadNode extends { get: { response: { 200: infer Body } } } ? Body : never;',
      'type PostsResponse = ThreadNode extends { posts: { get: { response: { 200: infer Body } } } } ? Body : never;',
      "type SearchResponse = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>;",
      'type DefinitionRoutes = Routes extends { v1: { definitions: infer Definitions } } ? Definitions : never;',
      'type DefinitionsActiveResponse = DefinitionRoutes extends { active: { get: { response: { 200: infer Body } } } } ? Body : never;',
      "type DefinitionsReleaseResponse = DefinitionRoutes extends { releases: { ':digest': { get: { response: { 200: infer Body } } } } } ? Body : never;",
      "type PageReadResult = Awaited<ReturnType<KernelClient['pages']['$read']['post']>>;",
      "type PageResponse = NonNullable<PageReadResult['data']>;",
      "type PageMissingResponse = Extract<NonNullable<PageReadResult['error']>, { status: 404 | '404' }>['value'];",
      "type Data<T extends Promise<{ data: unknown }>> = NonNullable<Awaited<T>['data']>;",
      "type SubjectRoutes = ReturnType<KernelClient['subjects']>;",
      "type SubjectThreadsResponse = Data<ReturnType<SubjectRoutes['threads']['get']>>;",
      "type SubjectRatingRoutes = ReturnType<SubjectRoutes['ratings']>;",
      "type SubjectVoteResponse = Data<ReturnType<SubjectRatingRoutes['vote']['get']>>;",
      "type SessionRoutes = ReturnType<KernelClient['progressSessions']>;",
      "type CollectionRoutes = ReturnType<KernelClient['collections']>;",
      "type LibraryEntriesResponse = Data<ReturnType<KernelClient['libraryEntries']['get']>>;",
      "type CollectionsResponse = Data<ReturnType<KernelClient['collections']['get']>>;",
      "type CollectionResponse = Data<ReturnType<CollectionRoutes['get']>>;",
      "type CollectionMembersResponse = Data<ReturnType<CollectionRoutes['members']['get']>>;",
      "type CopiesResponse = Data<ReturnType<KernelClient['copies']['get']>>;",
      "type FollowsResponse = Data<ReturnType<KernelClient['follows']['get']>>;",
      "type ProgressSessionsResponse = Data<ReturnType<KernelClient['progressSessions']['get']>>;",
      "type ProgressSessionResponse = Data<ReturnType<SessionRoutes['get']>>;",
      "type ProgressChangesResponse = Data<ReturnType<SessionRoutes['changes']['get']>>;",
      "type ProgressUnitsResponse = Data<ReturnType<SessionRoutes['completedUnits']['get']>>;",
      "type PublishedLogsResponse = Data<ReturnType<KernelClient['publishedLogs']['get']>>;",
      "type PublishedLogResponse = Data<ReturnType<ReturnType<KernelClient['publishedLogs']>['get']>>;",
      "type PreferencesResponse = Data<ReturnType<ReturnType<KernelClient['accounts']>['preferences']['get']>>;",
      "type SpaceAddressResponse = Data<ReturnType<ReturnType<KernelClient['spaceAddresses']>['get']>>;",
      "type SpaceResponse = Data<ReturnType<ReturnType<KernelClient['spaces']>['get']>>;",
      "type RealmRoutes = ReturnType<KernelClient['realms']>;",
      "type RealmResponse = Data<ReturnType<RealmRoutes['get']>>;",
      "type RealmBoardsResponse = Data<ReturnType<RealmRoutes['boards']['get']>>;",
      "type RealmPublicationsResponse = Data<ReturnType<RealmRoutes['publications']['get']>>;",
      "type RealmMemberResponse = Data<ReturnType<RealmRoutes['members']['me']['get']>>;",
      'type RealmSubjectsResponse = { subjects: Record<string, SubjectResponse> };',
      'type NoContentResponse = { status: 204 };',
      "type MyRealmsResponse = Data<ReturnType<KernelClient['me']['realms']['get']>>;",
      "type OfferResponse = Data<ReturnType<ReturnType<KernelClient['offers']>['get']>>;",
      "type OrderResponse = Data<ReturnType<ReturnType<KernelClient['orders']>['get']>>;",
    ];
    const responseType: Record<string, string> = {
      'accounts.json': 'AccountsResponse',
      'missing-subject.json': 'MissingResponse',
      'missing-subject-page.json': 'PageMissingResponse',
      'home-page.json': 'PageResponse',
      'agent-page.json': 'PageResponse',
      'agent-page-reader.json': 'PageResponse',
      'subject.json': 'SubjectResponse',
      'subject-page.json': 'PageResponse',
      'subject-reactions.json': 'SubjectReactionsResponse',
      'subject-reaction.json': 'SubjectOwnReactionResponse',
      'subject-review-threads.json': 'SubjectThreadsResponse',
      'rating-vote.json': 'SubjectVoteResponse',
      'board.json': 'BoardResponse',
      'board-threads.json': 'BoardThreadsResponse',
      'thread.json': 'ThreadResponse',
      'thread-posts.json': 'PostsResponse',
      'search.json': 'SearchResponse',
      'search-empty.json': 'SearchResponse',
      'search-typed.json': 'SearchResponse',
      'definitions-active.json': 'DefinitionsActiveResponse',
      'definitions-release.json': 'DefinitionsReleaseResponse',
      'library-entries.json': 'LibraryEntriesResponse',
      'library-collections.json': 'CollectionsResponse',
      'subject-links.json': 'LinksResponse',
      'library-collection.json': 'CollectionResponse',
      'library-collection-members.json': 'CollectionMembersResponse',
      'library-copies.json': 'CopiesResponse',
      'library-follows.json': 'FollowsResponse',
      'library-progress-sessions.json': 'ProgressSessionsResponse',
      'library-progress-session.json': 'ProgressSessionResponse',
      'library-progress-changes.json': 'ProgressChangesResponse',
      'library-progress-units.json': 'ProgressUnitsResponse',
      'library-published-log.json': 'PublishedLogResponse',
      'library-published-logs.json': 'PublishedLogsResponse',
      'settings-preferences.json': 'PreferencesResponse',
      'space-address.json': 'SpaceAddressResponse',
      'space.json': 'SpaceResponse',
      'realm.json': 'RealmResponse',
      'realm-boards.json': 'RealmBoardsResponse',
      'realm-publications.json': 'RealmPublicationsResponse',
      'realm-member.json': 'RealmMemberResponse',
      'realm-subjects.json': 'RealmSubjectsResponse',
      'realm-participation.json': 'NoContentResponse',
      'my-realms.json': 'MyRealmsResponse',
      'offer.json': 'OfferResponse',
      'offer-cjk.json': 'OfferResponse',
      'offer-delisted.json': 'OfferResponse',
      'order-paid.json': 'OrderResponse',
      'order-pending.json': 'OrderResponse',
      'order-failed.json': 'OrderResponse',
      'thread-owned.json': 'ThreadResponse',
      'thread-owned-posts.json': 'PostsResponse',
      'board-realm.json': 'BoardResponse',
      'board-realm-realm.json': 'RealmResponse',
      'board-realm-threads.json': 'BoardThreadsResponse',
      'board-realm-thread.json': 'ThreadResponse',
      'board-realm-thread-posts.json': 'PostsResponse',
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
        'offer.json',
        'order-paid.json',
        'thread-owned.json',
      ]),
    );
  },
  timeout,
);
