import { stat } from 'node:fs/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { placeWebCheck } from './check-placement.ts';

export { observeStorybook, settle };

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const themes = ['light', 'dark'] as const;
// Only the width is a command option. 720 is the review viewport height.
const viewportHeight = 720;
const captureLimit = 4;
const buildTimeout = 480_000;
let building: ReturnType<typeof Bun.spawn> | undefined;

type Theme = (typeof themes)[number];
type Options = {
  stories: string[];
  locales: string[];
  themes: Theme[];
  widths: number[];
  out: string;
  help: boolean;
};
type Job = { id: string; locale: string; theme: string; width?: number; widthSuffix?: boolean };
type CaptureFailure = { job: Job; error: string };
type CaptureResult = { files: string[]; failures: CaptureFailure[] };
export type StoryOutcome = {
  storyId: string;
  renderId?: number;
  cycle: number;
  phase?: string;
  status?: string;
  errors: string[];
};
export type StoryPreview = {
  __STORYBOOK_PREVIEW__?: {
    currentRender?: { id: string; renderId: number; phase?: string; abortController: { signal: AbortSignal } };
  };
  __STORYBOOK_ADDONS_CHANNEL__?: { on: <T>(event: string, listener: (data: T) => void) => void };
  __REZICS_STORY_OUTCOME__?: { read: () => StoryOutcome | undefined };
};

type ProgressReporter = ReturnType<typeof createProgressReporter>;

/** Writes capture progress to stderr while leaving stdout available for the file list. */
export function createProgressReporter(
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  now: () => number = Date.now,
) {
  let buildStartedAt: number | undefined;
  return {
    buildStarted() {
      buildStartedAt = now();
      write('Storybook build started.');
    },
    buildFinished() {
      const duration = buildStartedAt === undefined ? 0 : Math.max(0, now() - buildStartedAt);
      write(`Storybook build finished in ${(duration / 1_000).toFixed(1)}s.`);
      buildStartedAt = undefined;
    },
    captured(index: number, total: number, file: string) {
      write(`captured ${index}/${total} ${file}`);
    },
  };
}

function usage(): string {
  return 'Usage: bun run screenshots [--story <id or glob>] [--locale <code>]... [--theme light|dark]... [--width <px>]... [--out <dir>]';
}

function unique<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function storyMatches(id: string, pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return id === pattern;
  const expression = `^${pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')}$`;
  return new RegExp(expression).test(id);
}

function selectStories(
  availableStories: readonly string[],
  selectors: readonly string[],
): { stories: string[]; unmatchedSelectors: string[] } {
  const unmatchedSelectors = selectors.filter((selector) => !availableStories.some((id) => storyMatches(id, selector)));
  const stories = availableStories
    .filter((id) => selectors.length === 0 || selectors.some((selector) => storyMatches(id, selector)))
    .sort();
  return { stories, unmatchedSelectors };
}

export function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    stories: [],
    locales: [],
    themes: [],
    widths: [],
    out: resolve(root, '.temp/screenshots'),
    help: false,
  };
  const take = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${usage()}\nMissing value for ${flag}.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) continue;
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--story') {
      const story = take(flag, index);
      index += 1;
      if (story === '') throw new Error(`${usage()}\nMissing story id.`);
      options.stories.push(story);
      continue;
    }
    if (flag === '--locale') {
      const locale = take(flag, index);
      index += 1;
      if (locale === '') throw new Error(`${usage()}\nMissing locale code.`);
      options.locales.push(locale);
      continue;
    }
    if (flag === '--theme') {
      const theme = take(flag, index);
      index += 1;
      if (theme !== 'light' && theme !== 'dark') throw new Error(`${usage()}\nUnknown theme ${theme}.`);
      options.themes.push(theme);
      continue;
    }
    if (flag === '--width') {
      const width = Number(take(flag, index));
      index += 1;
      if (!Number.isInteger(width) || width <= 0) throw new Error(`${usage()}\nWidth must be a positive integer.`);
      options.widths.push(width);
      continue;
    }
    if (flag === '--out') {
      const value = take(flag, index);
      // A relative directory is from the workspace root, so a check host writes into its copy of the same path.
      options.out = isAbsolute(value) ? resolve(value) : resolve(root, value);
      index += 1;
      continue;
    }
    throw new Error(`${usage()}\nUnknown argument ${flag}.`);
  }
  if (options.locales.length === 0) options.locales = [...locales];
  if (options.themes.length === 0) options.themes = [...themes];
  options.stories = unique(options.stories);
  options.locales = unique(options.locales);
  options.themes = unique(options.themes);
  options.widths = unique(options.widths.length === 0 ? [1280] : options.widths);
  return options;
}

function safePath(directory: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relativePath = decoded.replace(/^\/+/, '');
  if (relativePath.split('/').includes('..')) return undefined;
  const target = resolve(directory, relativePath);
  if (target !== directory && !target.startsWith(`${directory}/`)) return undefined;
  return target;
}

export function screenshotFilename(job: Job): string {
  const width = job.widthSuffix && job.width !== undefined ? `.${job.width}px` : '';
  return `${job.id}.${job.locale}.${job.theme}${width}.png`;
}

function serve(directory: string) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const target = safePath(directory, new URL(request.url).pathname);
      if (!target) return new Response(null, { status: 400 });
      const info = await stat(target).catch(() => undefined);
      if (!info) return new Response(null, { status: 404 });
      const file = info.isDirectory() ? join(target, 'index.html') : target;
      if (!(await Bun.file(file).exists())) return new Response(null, { status: 404 });
      return new Response(Bun.file(file));
    },
  });
}

async function build(directory: string, cacheDir: string, progress: ProgressReporter): Promise<void> {
  const storybook = join(app, 'node_modules/.bin/storybook');
  await mkdir(cacheDir, { recursive: true });
  progress.buildStarted();
  const child = Bun.spawn([storybook, 'build', '--test', '--output-dir', directory, '--disable-telemetry', '--quiet'], {
    cwd: app,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1', CACHE_DIR: cacheDir },
  });
  building = child;
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(new Error('Storybook build timed out.'));
    }, buildTimeout);
  });
  try {
    const [stdout, stderr, code] = await Promise.race([output, timeout]);
    if (code !== 0) throw new Error(`Storybook build failed (${code}):\n${stdout}\n${stderr}`);
  } finally {
    clearTimeout(timer);
    building = undefined;
    progress.buildFinished();
  }
}

/** Navigates to a story, retrying only a browser network-interface change once. */
export async function navigateStory(
  page: Pick<Page, 'goto'>,
  id: string,
  url: string,
  writeProgress: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): ReturnType<Page['goto']> {
  const options = { waitUntil: 'load' as const, timeout: 60_000 };
  try {
    return await page.goto(url, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('net::ERR_NETWORK_CHANGED')) throw error;
    writeProgress(`Retrying navigation for story ${id} after net::ERR_NETWORK_CHANGED.`);
    try {
      return await page.goto(url, options);
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`Story ${id} navigation failed after retry: ${retryMessage}`, { cause: retryError });
    }
  }
}

/** Installed before preview code: Storybook's channel slot is assigned before it emits render events. */
function observeStorybook(): void {
  const preview = globalThis as StoryPreview;
  let channel: StoryPreview['__STORYBOOK_ADDONS_CHANNEL__'];
  let render: NonNullable<StoryPreview['__STORYBOOK_PREVIEW__']>['currentRender'];
  let signal: AbortSignal | undefined;
  let outcome: StoryOutcome | undefined;
  let finishing = false;
  let running = false;
  let cycle = 0;
  const errors: string[] = [];
  const current = () => preview.__STORYBOOK_PREVIEW__?.currentRender;
  preview.__REZICS_STORY_OUTCOME__ = {
    read: () => {
      if (!render || current() !== render || render.abortController.signal !== signal) return undefined;
      if (signal?.aborted)
        return {
          storyId: render.id,
          renderId: render.renderId,
          cycle,
          phase: 'aborted',
          status: 'error',
          errors: [...errors],
        };
      if (render.phase !== outcome?.phase) return undefined;
      return outcome && { ...outcome, ...(errors.length ? { status: 'error' } : {}), errors: [...errors] };
    },
  };
  Object.defineProperty(preview, '__STORYBOOK_ADDONS_CHANNEL__', {
    configurable: true,
    get: () => channel,
    set: (next: typeof channel) => {
      if (!next || next === channel) {
        channel = next;
        return;
      }
      channel = next;
      next.on('storyRenderPhaseChanged', (event: { storyId: string; renderId: number; newPhase: string }) => {
        const active = current();
        if (
          !active ||
          active.id !== event.storyId ||
          active.renderId !== event.renderId ||
          active.phase !== event.newPhase
        )
          return;
        if (active !== render || active.abortController.signal !== signal || event.newPhase === 'loading') {
          // Concurrent cycles reuse renderId in Storybook. Their outcomes cannot be attributed safely.
          if (running) errors.push('Overlapping Storybook render cycles have no attributable outcome.');
          render = active;
          signal = active.abortController.signal;
          cycle += 1;
        }
        if (event.newPhase === 'loading') running = true;
        if (['finished', 'aborted', 'errored'].includes(event.newPhase)) running = false;
        outcome = { storyId: event.storyId, renderId: event.renderId, cycle, phase: event.newPhase, errors: [] };
        finishing = event.newPhase === 'finished';
        // STORY_FINISHED has no renderId; StoryRender emits it synchronously inside this finished phase.
        queueMicrotask(() => {
          finishing = false;
        });
      });
      next.on(
        'storyFinished',
        (event: {
          storyId: string;
          status: string;
          reporters: { type: string; status: string; result: unknown }[];
        }) => {
          if (
            !finishing ||
            !outcome ||
            event.storyId !== render?.id ||
            current() !== render ||
            signal !== render.abortController.signal ||
            signal.aborted
          )
            return;
          finishing = false;
          for (const report of event.reporters ?? []) {
            if (report.status === 'failed') {
              let detail: string | undefined;
              try {
                detail = JSON.stringify(report.result);
              } catch {
                detail = String(report.result);
              }
              errors.push(`${report.type}: ${detail}`);
            }
          }
          outcome.status = event.status === 'success' && errors.length === 0 ? 'success' : 'error';
        },
      );
      const recordError = (error: { message?: string; title?: string; description?: string }) => {
        if (current() === render)
          errors.push(error.message ?? [error.title, error.description].filter(Boolean).join(': '));
      };
      for (const event of ['playFunctionThrewException', 'storyThrewException', 'storyErrored'])
        next.on(event, recordError);
      next.on('unhandledErrorsWhilePlaying', (errors: Parameters<typeof recordError>[0][]) =>
        errors.forEach(recordError),
      );
      // Requests invalidate an earlier result even before Storybook starts the next render cycle.
      for (const event of ['updateStoryArgs', 'resetStoryArgs', 'updateGlobals', 'forceRemount', 'forceReRender']) {
        next.on(event, (data: { storyId?: string } = {}) => {
          if (!data.storyId || data.storyId === render?.id) {
            outcome = undefined;
            finishing = false;
          }
        });
      }
    },
  });
}

async function settle(
  page: Pick<Page, 'waitForFunction' | 'evaluate'>,
  id: string,
  pageErrors: readonly string[] = [],
  { timeout = 60_000, fonts = true } = {},
): Promise<StoryOutcome> {
  const failure = (outcome: StoryOutcome | undefined, timeout?: unknown) => {
    const errors = [...(outcome?.errors ?? []), ...pageErrors].slice(0, 5);
    const details = errors.length ? ` First page errors: ${errors.join(' | ')}` : '';
    const wait = timeout instanceof Error ? ` ${timeout.name}: ${timeout.message}` : '';
    return new Error(
      `Story ${id} did not finish rendering successfully (last phase: ${outcome?.phase ?? 'missing'}, outcome: ${outcome?.status ?? 'missing'}).${details}${wait}`,
    );
  };
  try {
    await page.waitForFunction(
      (storyId: string) => {
        const outcome = (globalThis as StoryPreview).__REZICS_STORY_OUTCOME__?.read();
        return (
          outcome?.storyId === storyId &&
          (outcome.status !== undefined || outcome.phase === 'errored' || outcome.phase === 'aborted')
        );
      },
      id,
      { timeout },
    );
  } catch (error) {
    const unavailable = (phase: string): StoryOutcome => ({ storyId: id, cycle: 0, phase, errors: [] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      page
        .evaluate(() => {
          const preview = globalThis as StoryPreview;
          const render = preview.__STORYBOOK_PREVIEW__?.currentRender;
          return (
            preview.__REZICS_STORY_OUTCOME__?.read() ??
            (render && {
              storyId: render.id,
              renderId: render.renderId,
              cycle: 0,
              phase: render.phase ?? 'missing',
              errors: [],
            })
          );
        })
        .catch(() => unavailable('unavailable')),
      new Promise<StoryOutcome>((resolve) => {
        timer = setTimeout(() => resolve(unavailable('unresponsive')), 1_000);
      }),
    ]).finally(() => clearTimeout(timer));
    throw failure(outcome, error);
  }
  const outcome = await page.evaluate(() => (globalThis as StoryPreview).__REZICS_STORY_OUTCOME__?.read());
  if (outcome?.storyId !== id || outcome.phase !== 'finished' || outcome.status !== 'success') throw failure(outcome);
  if (fonts) {
    await page.evaluate(async () => {
      await document.fonts.ready;
      if (document.fonts.status !== 'loaded') await document.fonts.ready;
    });
  }
  return outcome;
}

async function prepareFullPageCapture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const overlay = document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
    if (overlay) return;
    window.scrollTo(0, 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function captureOne(page: Page, origin: string, job: Job, out: string): Promise<string> {
  const url = `${origin}/iframe.html?id=${encodeURIComponent(job.id)}&globals=locale:${job.locale};theme:${job.theme}`;
  const pageErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.message);
  const onConsole = (message: import('playwright').ConsoleMessage) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  let navigated = false;
  try {
    await navigateStory(page, job.id, url);
    navigated = true;
    const outcome = await settle(page, job.id, pageErrors);
    // Page route stories render their router asynchronously after Storybook finishes the story render.
    if (job.id.startsWith('pages-')) {
      try {
        await page.locator('main:not([aria-busy="true"])').waitFor({ state: 'visible', timeout: 60_000 });
      } catch (error) {
        const details = pageErrors.slice(0, 5);
        const firstErrors = details.length ? ` Page errors: ${details.join(' | ')}` : '';
        throw new Error(`Page story ${job.id} did not render its main content.${firstErrors} ${String(error)}`);
      }
    }
    await prepareFullPageCapture(page);
    const latest = await page.evaluate(() => (globalThis as StoryPreview).__REZICS_STORY_OUTCOME__?.read());
    if (
      latest?.storyId !== job.id ||
      latest.renderId !== outcome.renderId ||
      latest.cycle !== outcome.cycle ||
      latest.status !== 'success' ||
      latest.phase !== 'finished'
    ) {
      throw new Error(`Story ${job.id} render outcome changed before capture. ${latest?.errors.join(' | ') ?? ''}`);
    }
    const file = join(out, screenshotFilename(job));
    await page.screenshot({ path: file, type: 'png', fullPage: true, animations: 'disabled', scale: 'css' });
    return file;
  } catch (error) {
    if (navigated) {
      const diagnostic = join(out, screenshotFilename(job).replace(/\.png$/, '.diagnostic.png'));
      const retained = await page
        .screenshot({
          path: diagnostic,
          type: 'png',
          fullPage: true,
          animations: 'disabled',
          scale: 'css',
          timeout: 5_000,
        })
        .then(
          () => true,
          () => false,
        );
      if (retained) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Diagnostic artifact (not a successful review): ${diagnostic}`,
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
  }
}

async function captureJobs(
  jobs: readonly Job[],
  run: (job: Job, worker: number) => Promise<string>,
  workerCount = 1,
): Promise<CaptureResult> {
  const files = new Array<string | undefined>(jobs.length);
  const failures: { index: number; value: CaptureFailure }[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(workerCount, jobs.length) }, (_, worker) =>
      (async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= jobs.length) return;
          const job = jobs[index];
          if (!job) return;
          try {
            files[index] = await run(job, worker);
          } catch (error) {
            failures.push({
              index,
              value: {
                job,
                error: (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim(),
              },
            });
          }
        }
      })(),
    ),
  );
  return {
    files: files.filter((file): file is string => file !== undefined),
    failures: failures.sort((left, right) => left.index - right.index).map(({ value }) => value),
  };
}

function reportCaptureResults(
  files: string[],
  failures: CaptureFailure[],
  write: (text: string) => void,
  unmatchedSelectors: readonly string[] = [],
): number {
  for (const file of files) write(`${file}\n`);
  write(`${files.length}\n`);
  for (const { job, error } of failures) {
    const width = job.widthSuffix && job.width !== undefined ? ` ${job.width}px` : '';
    write(`${job.id} ${job.locale} ${job.theme}${width}: ${error.replace(/\s+/g, ' ').trim()}\n`);
  }
  for (const selector of unmatchedSelectors) {
    write(`No stories matched --story ${JSON.stringify(selector)}.\n`);
  }
  return failures.length === 0 && unmatchedSelectors.length === 0 ? 0 : 1;
}

async function capture(
  browser: Browser,
  origin: string,
  jobs: readonly Job[],
  out: string,
  progress: ProgressReporter,
): Promise<CaptureResult> {
  let completed = 0;
  const files: string[] = [];
  const failures: CaptureFailure[] = [];
  const widths = [...new Set(jobs.map((job) => job.width ?? 1280))];
  for (const width of widths) {
    const widthJobs = jobs.filter((job) => (job.width ?? 1280) === width);
    const contexts = await Promise.all(
      Array.from({ length: Math.min(captureLimit, widthJobs.length) }, () =>
        browser.newContext({
          viewport: { width, height: viewportHeight },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
        }),
      ),
    );
    const pages = await Promise.all(
      contexts.map(async (context) => {
        await context.addInitScript(observeStorybook);
        return context.newPage();
      }),
    );
    try {
      const result = await captureJobs(
        widthJobs,
        async (job, worker) => {
          const file = await captureOne(pages[worker]!, origin, job, out);
          completed += 1;
          progress.captured(completed, jobs.length, file);
          return file;
        },
        pages.length,
      );
      files.push(...result.files);
      failures.push(...result.failures);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  }
  return { files, failures };
}

function workspaceRelative(path: string): string | undefined {
  const inside = relative(root, resolve(path));
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  return inside.split(sep).join('/');
}

/** Keeps every flag, and rewrites `--out` to the workspace-relative directory a host can copy back. */
function screenshotCommand(argv: readonly string[], relativeOut: string | undefined): string[] {
  if (relativeOut === undefined) return ['bun', 'scripts/screenshots.ts', ...argv];
  const command = ['bun', 'scripts/screenshots.ts'];
  let outputSpecified = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    command.push(argument);
    if (argument === '--out') {
      index += 1;
      command.push(relativeOut);
      outputSpecified = true;
    }
  }
  if (!outputSpecified) command.push('--out', relativeOut);
  return command;
}

async function captureScreenshots(options: Options): Promise<number> {
  await mkdir(join(root, '.temp'), { recursive: true });
  await mkdir(options.out, { recursive: true });
  const buildDir = await mkdtemp(join(root, '.temp/storybook-build-'));
  const site = join(buildDir, 'site');
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Browser | undefined;
  const progress = createProgressReporter();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (building && building.exitCode === null) building.kill();
    server?.stop(true);
    await browser?.close().catch(() => undefined);
    await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void stop().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    });
  }
  try {
    await build(site, join(buildDir, 'cache'), progress);
    const indexFile = Bun.file(join(site, 'index.json'));
    if (!(await indexFile.exists())) throw new Error('Storybook build did not write index.json.');
    const index = (await indexFile.json()) as { entries?: Record<string, { id?: string; type?: string }> };
    const availableStories = Object.values(index.entries ?? {}).flatMap((entry) =>
      entry.type === 'story' && entry.id ? [entry.id] : [],
    );
    const { stories, unmatchedSelectors } = selectStories(availableStories, options.stories);
    if (stories.length === 0 && unmatchedSelectors.length === 0) throw new Error('No stories matched.');
    if (stories.length === 0) {
      return reportCaptureResults([], [], (text) => process.stdout.write(text), unmatchedSelectors);
    }
    server = serve(site);
    const origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch();
    const jobs = stories.flatMap((id) =>
      options.locales.flatMap((locale) =>
        options.themes.flatMap((theme) =>
          options.widths.map((width) => ({
            id,
            locale,
            theme,
            width,
            widthSuffix: options.widths.length > 1,
          })),
        ),
      ),
    );
    const { files, failures } = await capture(browser, origin, jobs, options.out, progress);
    return reportCaptureResults(files, failures, (text) => process.stdout.write(text), unmatchedSelectors);
  } finally {
    await stop();
  }
}

/** Routes capture before building or starting a browser; unsupported destinations fail closed. */
export async function runScreenshots(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const returned = workspaceRelative(options.out);
  if (returned === undefined) throw new Error('Web screenshots unavailable: --out must be inside the candidate workspace.');
  return placeWebCheck(
    {
      label: 'web screenshots',
      root,
      cwd: app,
      command: screenshotCommand(argv, returned),
      returns: [returned],
    },
    async () => {
      return captureScreenshots(options);
    },
  );
}

if (import.meta.main) {
  runScreenshots()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
