import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, '../scripts/screenshots.ts'), 'utf8');

function extracted<T>(
  startName: string,
  endName: string,
  ending = `\nreturn ${startName};`,
  scope: Record<string, unknown> = {},
): T {
  const asyncStart = source.indexOf(`async function ${startName}(`);
  const ordinaryStart = source.indexOf(`function ${startName}(`);
  const start = asyncStart >= 0 ? asyncStart : ordinaryStart;
  const asyncEnd = source.indexOf(`\nasync function ${endName}(`, start);
  const ordinaryEnd = source.indexOf(`\nfunction ${endName}(`, start);
  const end = asyncEnd < 0 ? ordinaryEnd : ordinaryEnd < 0 ? asyncEnd : Math.min(asyncEnd, ordinaryEnd);
  if (start < 0 || end < 0) throw new Error(`Could not extract ${startName}.`);
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${source.slice(start, end)}${ending}`);
  return new Function(...Object.keys(scope), code)(...Object.values(scope)) as T;
}

type Job = { id: string; locale: string; theme: string };
type CaptureResult = { files: string[]; failures: { job: Job; error: string }[] };
type CaptureJobs = (jobs: readonly Job[], run: (job: Job, worker: number) => Promise<string>) => Promise<CaptureResult>;
type StorySelection = (
  availableStories: readonly string[],
  selectors: readonly string[],
) => {
  stories: string[];
  unmatchedSelectors: string[];
};

function storybook(id = 'components-example--ready') {
  type Outcome = { storyId: string; renderId: number; cycle: number; phase: string; status?: string; errors: string[] };
  const render = { id, renderId: 1, phase: 'preparing', abortController: new AbortController() };
  const global = {
    __STORYBOOK_PREVIEW__: { currentRender: render },
    __STORYBOOK_ADDONS_CHANNEL__: undefined as unknown,
    __REZICS_STORY_OUTCOME__: undefined as { read: () => Outcome | undefined } | undefined,
  };
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const microtasks: (() => void)[] = [];
  const observe = extracted<() => void>('observeStorybook', 'settle', '\nreturn observeStorybook;', {
    globalThis: global,
    queueMicrotask: (callback: () => void) => microtasks.push(callback),
  });
  observe();
  global.__STORYBOOK_ADDONS_CHANNEL__ = {
    on: (event: string, listener: (data: unknown) => void) =>
      listeners.set(event, [...(listeners.get(event) ?? []), listener]),
  };
  const emit = (event: string, data: unknown = {}) => listeners.get(event)?.forEach((listener) => listener(data));
  const phase = (newPhase: string, identity = { storyId: id, renderId: render.renderId }) => {
    render.phase = newPhase;
    emit('storyRenderPhaseChanged', { ...identity, newPhase });
  };
  let fontsSettled = false;
  const evaluate = async (fn: Function, arg?: unknown) =>
    Function(
      'globalThis',
      'document',
      'arg',
      `return (${fn.toString()})(arg);`,
    )(
      global,
      {
        fonts: {
          get ready() {
            fontsSettled = true;
            return Promise.resolve();
          },
          status: 'loaded',
        },
      },
      arg,
    );
  const page = {
    evaluate,
    waitForFunction: async (fn: Function, arg: unknown, options: { timeout: number }) => {
      expect(options.timeout).toBe(60_000);
      if (!(await evaluate(fn, arg))) throw new Error('Synthetic readiness timeout');
    },
  };
  const settle = extracted<(target: typeof page, id: string, errors?: readonly string[]) => Promise<Outcome>>(
    'settle',
    'prepareFullPageCapture',
  );
  phase('preparing');
  phase('loading');
  return {
    id,
    global,
    render,
    emit,
    phase,
    page,
    settle: (errors?: readonly string[]) => settle(page, id, errors),
    fontsSettled: () => fontsSettled,
    flush: () => {
      for (const callback of microtasks.splice(0)) callback();
    },
    finish: (status = 'success', reporters: unknown[] = []) => {
      phase('finished');
      emit('storyFinished', { storyId: id, status, reporters });
    },
  };
}

test('a matching finished-success outcome observed before readiness settles fonts', async () => {
  const story = storybook();
  story.finish();
  expect((await story.settle()).status).toBe('success');
  expect(story.fontsSettled()).toBe(true);
});

test('finished-error and failed reporters retain original play and report errors', async () => {
  const story = storybook();
  story.emit('playFunctionThrewException', { message: 'Expected decoded blob preview and enabled Save' });
  story.finish('error');
  await expect(story.settle()).rejects.toThrow('Expected decoded blob preview and enabled Save');
  const reported = storybook();
  reported.finish('success', [
    { type: 'interaction', status: 'failed', result: { message: 'Save remained disabled' } },
  ]);
  await expect(reported.settle()).rejects.toThrow('Save remained disabled');
});

test('missing, mismatched and late outcomes fail within the readiness bound with timeout diagnostics', async () => {
  for (const scenario of ['missing', 'story', 'render', 'late']) {
    const story = storybook();
    if (scenario === 'render') {
      story.phase('finished', { storyId: story.id, renderId: 999 });
    } else {
      story.phase('finished');
    }
    if (scenario === 'late') story.flush();
    if (scenario !== 'missing') {
      story.emit('storyFinished', {
        storyId: scenario === 'story' ? 'another-story' : story.id,
        status: 'success',
        reporters: [],
      });
    }
    await expect(story.settle(['Original page failure'])).rejects.toThrow('Synthetic readiness timeout');
    await expect(story.settle(['Original page failure'])).rejects.toThrow('Original page failure');
    expect(story.fontsSettled()).toBe(false);
  }
});

test('old success cannot satisfy a replaced, remounted or changed render and aborted renders fail', async () => {
  for (const change of ['replace', 'remount', 'loading', 'updateStoryArgs', 'updateGlobals', 'forceRemount']) {
    const story = storybook();
    story.finish();
    story.flush();
    if (change === 'replace') story.global.__STORYBOOK_PREVIEW__.currentRender = { ...story.render, renderId: 2 };
    else if (change === 'remount') story.render.abortController = new AbortController();
    else if (change === 'loading') story.phase('loading');
    else story.emit(change, { storyId: story.id });
    story.emit('storyFinished', { storyId: story.id, status: 'success', reporters: [] });
    await expect(story.settle()).rejects.toThrow('Synthetic readiness timeout');
  }
  const story = storybook();
  story.render.abortController.abort();
  await expect(story.settle()).rejects.toThrow('aborted');
});

test('a Storybook finished render with error outcome is reported as a failed review job while successful jobs and useful diagnostic images remain retained', async () => {
  const jobs = ['first', 'failed-play', 'last'].map((id) => ({ id, locale: 'ja', theme: 'dark' }));
  const images = new Map([['old.png', 'old artifact']]);
  const captureJobs = extracted<CaptureJobs>('captureJobs', 'reportCaptureResults');
  const result = await captureJobs(jobs, async (job) => {
    const story = storybook(job.id);
    const captureOne = extracted<(page: unknown, origin: string, job: Job, out: string) => Promise<string>>(
      'captureOne',
      'captureJobs',
      '\nreturn captureOne;',
      {
        join,
        screenshotFilename: (job: Job) => `${job.id}.${job.locale}.${job.theme}.png`,
        navigateStory: async () => {
          if (job.id === 'failed-play')
            story.emit('playFunctionThrewException', { message: 'Expected ready decoded blob preview' });
          story.finish(job.id === 'failed-play' ? 'error' : 'success');
        },
        settle: () => story.settle(),
        prepareFullPageCapture: async () => undefined,
      },
    );
    return captureOne(
      {
        ...story.page,
        on: () => undefined,
        off: () => undefined,
        screenshot: async ({ path }: { path: string }) => {
          images.set(path, job.id === 'failed-play' ? 'failed preview' : 'successful preview');
        },
      },
      'http://storybook.invalid',
      job,
      '/review',
    );
  });
  expect(result.files).toEqual(['/review/first.ja.dark.png', '/review/last.ja.dark.png']);
  expect(images.get('old.png')).toBe('old artifact');
  expect(images.get('/review/failed-play.ja.dark.diagnostic.png')).toBe('failed preview');
  expect(images.has('/review/failed-play.ja.dark.png')).toBe(false);
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]!.error).toContain('Expected ready decoded blob preview');
  expect(result.failures[0]!.error).toContain('Diagnostic artifact (not a successful review):');
  const report = extracted<
    (files: string[], failures: CaptureResult['failures'], write: (line: string) => void) => number
  >('reportCaptureResults', 'capture');
  const output: string[] = [];
  expect(report(result.files, result.failures, (line) => output.push(line))).toBe(1);
  expect(output.join('')).toContain('/review/last.ja.dark.png\n2\nfailed-play ja dark:');
});

test('one failed story does not stop later screenshot jobs', async () => {
  const captureJobs = extracted<CaptureJobs>('captureJobs', 'reportCaptureResults');
  const jobs = [
    { id: 'first', locale: 'en', theme: 'light' },
    { id: 'broken', locale: 'ja', theme: 'dark' },
    { id: 'last', locale: 'zh-Hant', theme: 'light' },
  ];
  const visited: string[] = [];
  const result = await captureJobs(jobs, async (job) => {
    visited.push(job.id);
    if (job.id === 'broken') throw new Error('Synthetic render failure');
    return `${job.id}.png`;
  });
  expect(visited).toEqual(['first', 'broken', 'last']);
  expect(result.files).toEqual(['first.png', 'last.png']);
  expect(result.failures).toEqual([{ job: jobs[1], error: 'Synthetic render failure' }]);
});

test('failures print one line per failed job after files and produce a nonzero result', () => {
  const report = extracted<
    (files: string[], failures: { job: Job; error: string }[], write: (s: string) => void) => number
  >('reportCaptureResults', 'capture');
  const lines: string[] = [];
  const code = report(
    ['one.png', 'two.png'],
    [
      { job: { id: 'broken-a', locale: 'en', theme: 'dark' }, error: 'render exploded' },
      { job: { id: 'broken-b', locale: 'ja', theme: 'light' }, error: 'timeout\nsecond line' },
    ],
    (line) => lines.push(line),
  );
  expect(code).toBe(1);
  expect(lines.join('')).toBe(
    'one.png\ntwo.png\n2\nbroken-a en dark: render exploded\nbroken-b ja light: timeout second line\n',
  );
});

test('a run without failures retains its zero exit status and output', () => {
  const report = extracted<
    (files: string[], failures: { job: Job; error: string }[], write: (s: string) => void) => number
  >('reportCaptureResults', 'capture');
  const lines: string[] = [];
  expect(report(['one.png'], [], (line) => lines.push(line))).toBe(0);
  expect(lines.join('')).toBe('one.png\n1\n');
});

test('unmatched explicit selectors are reported while matched stories retain their capture jobs', async () => {
  const selectStories = extracted<StorySelection>('storyMatches', 'parseOptions', '\nreturn selectStories;');
  const selection = selectStories(
    ['pages-collection--purchase', 'pages-community-thread-reading--selected-parent'],
    ['pages-collection--purchase', 'pages-community-thread--selected-reply-target', 'pages-community-thread--*'],
  );
  expect(selection.stories).toEqual(['pages-collection--purchase']);
  expect(selection.unmatchedSelectors).toEqual([
    'pages-community-thread--selected-reply-target',
    'pages-community-thread--*',
  ]);

  const captureJobs = extracted<CaptureJobs>('captureJobs', 'reportCaptureResults');
  const jobs = selection.stories.map((id) => ({ id, locale: 'en', theme: 'light' }));
  const captures = await captureJobs(jobs, async (job) => `${job.id}.png`);
  expect(captures.files).toEqual(['pages-collection--purchase.png']);

  const report = extracted<
    (
      files: string[],
      failures: { job: Job; error: string }[],
      write: (s: string) => void,
      unmatchedSelectors?: readonly string[],
    ) => number
  >('reportCaptureResults', 'capture');
  const lines: string[] = [];
  expect(report(captures.files, captures.failures, (line) => lines.push(line), selection.unmatchedSelectors)).toBe(1);
  expect(lines.join('')).toBe(
    'pages-collection--purchase.png\n1\n' +
      'No stories matched --story "pages-community-thread--selected-reply-target".\n' +
      'No stories matched --story "pages-community-thread--*".\n',
  );
});

test('full page capture resets scroll only when no viewport overlay is open', async () => {
  const prepare = extracted<(page: { evaluate: (fn: () => unknown) => Promise<unknown> }) => Promise<void>>(
    'prepareFullPageCapture',
    'captureOne',
  );
  let overlay = false;
  let scrolled = false;
  let framed = false;
  const page = {
    evaluate: async (fn: () => unknown) => {
      return Function(
        'window',
        'requestAnimationFrame',
        'document',
        `return (${fn.toString()})();`,
      )(
        {
          scrollTo: () => {
            scrolled = true;
          },
        },
        (callback: () => void) => {
          framed = true;
          callback();
        },
        { querySelector: () => (overlay ? {} : null) },
      );
    },
  };
  await prepare(page);
  expect(scrolled).toBe(true);
  expect(framed).toBe(true);
  overlay = true;
  scrolled = false;
  framed = false;
  await prepare(page);
  expect(scrolled).toBe(false);
  expect(framed).toBe(false);
});

test('page story captures wait for the route content after Storybook finishes rendering', () => {
  const start = source.indexOf('async function captureOne(');
  const end = source.indexOf('\nasync function captureJobs(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const captureOne = source.slice(start, end);
  expect(captureOne).toContain("job.id.startsWith('pages-')");
  expect(captureOne).toContain(
    "page.locator('main:not([aria-busy=\"true\"])').waitFor({ state: 'visible', timeout: 60_000 })",
  );
});
