import { stat } from 'node:fs/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { stackRun } from '../../../scripts/stack-run.ts';

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
type StoryPreview = {
  __STORYBOOK_PREVIEW__?: { currentRender?: { id?: string; phase?: string } };
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

async function settle(page: Page, id: string, pageErrors: readonly string[] = []): Promise<void> {
  const failure = (phase: string | undefined, timeout?: unknown) => {
    const errors = pageErrors.slice(0, 5);
    const details = errors.length ? ` First page errors: ${errors.join(' | ')}` : '';
    const wait = timeout instanceof Error ? ` ${timeout.name}: ${timeout.message}` : '';
    return new Error(`Story ${id} did not finish rendering (last phase: ${phase ?? 'missing'}).${details}${wait}`);
  };
  try {
    await page.waitForFunction(
      (storyId: string) => {
        const render = (globalThis as StoryPreview).__STORYBOOK_PREVIEW__?.currentRender;
        return render?.id === storyId && (render.phase === 'finished' || render.phase === 'errored');
      },
      id,
      { timeout: 60_000 },
    );
  } catch (error) {
    const phase = await Promise.race([
      page
        .evaluate(() => (globalThis as StoryPreview).__STORYBOOK_PREVIEW__?.currentRender?.phase)
        .then((value) => (typeof value === 'string' ? value : 'missing'))
        .catch(() => 'unavailable'),
      new Promise<string>((resolve) => setTimeout(() => resolve('unresponsive'), 1_000)),
    ]);
    throw failure(phase, error);
  }
  const phase = await page.evaluate(() => (globalThis as StoryPreview).__STORYBOOK_PREVIEW__?.currentRender?.phase);
  if (phase !== 'finished') throw failure(typeof phase === 'string' ? phase : undefined);
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.fonts.status !== 'loaded') await document.fonts.ready;
  });
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
  try {
    await navigateStory(page, job.id, url);
    await settle(page, job.id, pageErrors);
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
    const file = join(out, screenshotFilename(job));
    await page.screenshot({ path: file, type: 'png', fullPage: true, animations: 'disabled', scale: 'css' });
    return file;
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

function reportCaptureResults(files: string[], failures: CaptureFailure[], write: (text: string) => void): number {
  for (const file of files) write(`${file}\n`);
  write(`${files.length}\n`);
  for (const { job, error } of failures) {
    const width = job.widthSuffix && job.width !== undefined ? ` ${job.width}px` : '';
    write(`${job.id} ${job.locale} ${job.theme}${width}: ${error.replace(/\s+/g, ' ').trim()}\n`);
  }
  return failures.length === 0 ? 0 : 1;
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
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
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
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--out') {
      index += 1;
      continue;
    }
    command.push(argument);
  }
  command.push('--out', relativeOut);
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
    const stories = Object.values(index.entries ?? {})
      .flatMap((entry) => (entry.type === 'story' && entry.id ? [entry.id] : []))
      .filter((id) => options.stories.length === 0 || options.stories.some((pattern) => storyMatches(id, pattern)))
      .sort();
    if (stories.length === 0) throw new Error('No stories matched.');
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
    return reportCaptureResults(files, failures, (text) => process.stdout.write(text));
  } finally {
    await stop();
  }
}

/** Hands the capture to a check host. An output outside the workspace stays local, because nothing can copy it back. */
export async function runScreenshots(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const returned = workspaceRelative(options.out);
  return stackRun(
    {
      label: 'web screenshots',
      root,
      cwd: app,
      command: screenshotCommand(argv, returned),
      ...(returned === undefined ? { keepsFiles: true } : { returns: [returned] }),
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
