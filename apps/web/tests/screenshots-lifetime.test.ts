import { expect, test } from 'bun:test';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  createProgressReporter,
  parseOptions,
  runCaptureLifecycle,
  type ScreenshotRuntime,
} from '../scripts/screenshots.ts';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function stream(text = '', open = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      if (!open) controller.close();
    },
  });
}

function child(
  options: {
    exit?: Promise<number>;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    kill?: (signal?: number) => void;
  } = {},
): ReturnType<typeof Bun.spawn> {
  return {
    stdout: options.stdout ?? stream(),
    stderr: options.stderr ?? stream(),
    exited: options.exit ?? Promise.resolve(0),
    kill: options.kill ?? (() => undefined),
  } as unknown as ReturnType<typeof Bun.spawn>;
}

function signalHarness() {
  const listeners = new Map<'SIGINT' | 'SIGTERM', Set<() => void>>();
  return {
    signals: {
      listen(signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
        const set = listeners.get(signal) ?? new Set<() => void>();
        set.add(listener);
        listeners.set(signal, set);
        return () => set.delete(listener);
      },
    },
    fire(signal: 'SIGINT' | 'SIGTERM') {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
    count() {
      return [...listeners.values()].reduce((count, set) => count + set.size, 0);
    },
  };
}

type Harness = {
  widths: number[];
  files: string[];
  progress: string[];
  removed: string[];
  serverClosed: number;
  browserClosed: number;
  contextClosed: number[];
  pageClosed: number[];
  navigations: string[];
  output: string;
};

type Hooks = {
  goto?: (index: number, url: string) => Promise<unknown>;
  newContext?: (index: number, width: number) => Promise<BrowserContext>;
  newPage?: (index: number) => Promise<Page>;
  addInitScript?: (index: number) => Promise<void>;
  closeContext?: (index: number) => Promise<void>;
  closePage?: (index: number) => Promise<void>;
  launch?: () => Promise<Browser>;
  child?: () => ReturnType<typeof Bun.spawn>;
  stories?: string[];
  signals?: ReturnType<typeof signalHarness>;
  cleanupTimeoutMs?: number;
  buildTimeoutMs?: number;
};

function setup(hooks: Hooks = {}): {
  runtime: ScreenshotRuntime;
  events: Harness;
  signals: ReturnType<typeof signalHarness>;
} {
  const events: Harness = {
    widths: [],
    files: [],
    progress: [],
    removed: [],
    serverClosed: 0,
    browserClosed: 0,
    contextClosed: [],
    pageClosed: [],
    navigations: [],
    output: '',
  };
  const signals = hooks.signals ?? signalHarness();
  let contextIndex = 0;
  const context = (index: number): BrowserContext => {
    let currentStoryId = '';
    const pageIndex = index;
    const page = {
      async goto(url: string) {
        currentStoryId = new URL(url).searchParams.get('id') ?? '';
        events.navigations.push(currentStoryId);
        return (await hooks.goto?.(pageIndex, url)) ?? null;
      },
      async waitForFunction() {
        return undefined;
      },
      async evaluate() {
        return { storyId: currentStoryId, renderId: 1, cycle: 1, phase: 'finished', status: 'success', errors: [] };
      },
      locator() {
        return { waitFor: async () => undefined };
      },
      async screenshot({ path }: { path: string }) {
        events.files.push(path);
      },
      async close() {
        events.pageClosed.push(pageIndex);
        await hooks.closePage?.(pageIndex);
      },
      on() {
        return this;
      },
      off() {
        return this;
      },
    } as unknown as Page;
    const currentPageIndex = pageIndex;
    return {
      async addInitScript() {
        await hooks.addInitScript?.(index);
      },
      async newPage() {
        if (hooks.newPage) return hooks.newPage(currentPageIndex);
        return page;
      },
      async close() {
        events.contextClosed.push(index);
        await hooks.closeContext?.(index);
      },
    } as unknown as BrowserContext;
  };
  const browser = {
    async newContext(options: { viewport?: { width?: number } }) {
      const index = contextIndex++;
      const width = options.viewport?.width ?? 0;
      events.widths.push(width);
      if (hooks.newContext) return hooks.newContext(index, width);
      return context(index);
    },
    async close() {
      events.browserClosed += 1;
    },
  } as unknown as Browser;
  const runtime: ScreenshotRuntime = {
    spawn: (() => hooks.child?.() ?? child()) as unknown as typeof Bun.spawn,
    serve() {
      return {
        port: 6006,
        close() {
          events.serverClosed += 1;
        },
      };
    },
    launch: hooks.launch ?? (async () => browser),
    readStories: async () => hooks.stories ?? ['components-example--a', 'components-example--b'],
    mkdir: (async () => undefined) as ScreenshotRuntime['mkdir'],
    mkdtemp: (async () => '/fake/.temp/storybook-build-lifetime') as ScreenshotRuntime['mkdtemp'],
    rm: (async (path: string) => {
      events.removed.push(path);
    }) as ScreenshotRuntime['rm'],
    cleanupTimeoutMs: hooks.cleanupTimeoutMs ?? 20,
    buildTimeoutMs: hooks.buildTimeoutMs ?? 500,
    signals: signals.signals,
    stdout(text) {
      events.output += text;
    },
    stderr() {},
    progress: () =>
      createProgressReporter(
        (line) => events.progress.push(line),
        () => 1_000,
      ),
  };
  return { runtime, events, signals };
}

function options(args: string[] = []): ReturnType<typeof parseOptions> {
  return parseOptions(['--locale', 'en', '--theme', 'dark', '--out', '.temp/lifetime-review', ...args]);
}

test('the injected production composition preserves file order, progress and width batches', async () => {
  const { runtime, events } = setup();
  const captureOptions = options(['--story', 'components-example--*', '--width', '390', '--width', '1280']);
  const result = await runCaptureLifecycle(captureOptions, runtime);

  expect(result).toBe(0);
  expect(events.widths).toEqual([390, 390, 1280, 1280]);
  expect(events.output).toBe(
    `${captureOptions.out}/components-example--a.en.dark.390px.png\n` +
      `${captureOptions.out}/components-example--b.en.dark.390px.png\n` +
      `${captureOptions.out}/components-example--a.en.dark.1280px.png\n` +
      `${captureOptions.out}/components-example--b.en.dark.1280px.png\n` +
      '4\n',
  );
  expect(events.progress[0]).toBe('Storybook build started.');
  expect(events.progress[1]).toBe('Storybook build finished in 0.0s.');
  expect(events.progress.slice(2)).toHaveLength(4);
  expect(events.progress.slice(2).map((line) => line.replace(/^captured \d+\/\d+ /, ''))).toEqual(events.files);
  expect(events.removed).toEqual(['/fake/.temp/storybook-build-lifetime']);
});

test('the injected production composition retains matched work and reports unmatched selectors afterward', async () => {
  const { runtime, events } = setup({ stories: ['components-example--a'] });
  const captureOptions = options(['--story', 'components-example--a', '--story', 'components-example--missing']);
  const result = await runCaptureLifecycle(captureOptions, runtime);

  expect(result).toBe(1);
  expect(events.output).toBe(
    `${captureOptions.out}/components-example--a.en.dark.png\n1\n` +
      'No stories matched --story "components-example--missing".\n',
  );
});

test('a build parent that never exits is killed, bounded, and keeps its build directory occupied', async () => {
  const kills: (number | undefined)[] = [];
  const { runtime, events } = setup({
    child: () => child({ stdout: stream('', true), stderr: stream('', true), kill: (signal) => kills.push(signal) }),
    cleanupTimeoutMs: 8,
    buildTimeoutMs: 5,
  });

  await expect(runCaptureLifecycle(options(), runtime)).rejects.toThrow(
    'Build directory retained at /fake/.temp/storybook-build-lifetime',
  );
  expect(kills).toContain(undefined);
  expect(kills).toContain(9);
  expect(events.removed).toEqual([]);
  expect(events.serverClosed).toBe(0);
  expect(events.browserClosed).toBe(0);
});

test('an exited build parent does not release the directory while an inherited output pipe stays open', async () => {
  const kills: (number | undefined)[] = [];
  const { runtime, events } = setup({
    child: () => child({ stdout: stream('', true), stderr: stream(), kill: (signal) => kills.push(signal) }),
    cleanupTimeoutMs: 8,
    buildTimeoutMs: 5,
  });

  await expect(runCaptureLifecycle(options(), runtime)).rejects.toThrow('Storybook build stdout did not settle');
  expect(kills).toEqual([]);
  expect(events.removed).toEqual([]);
});

test('a signal during a pending build fences later server and browser work and detaches listeners', async () => {
  const signals = signalHarness();
  const started = deferred<void>();
  const exited = deferred<number>();
  const { runtime, events } = setup({
    signals,
    child: () => {
      started.resolve();
      return child({ exit: exited.promise, kill: () => exited.resolve(0) });
    },
  });
  const running = runCaptureLifecycle(options(), runtime);
  await started.promise;
  signals.fire('SIGINT');

  await expect(running).rejects.toThrow('Capture interrupted by SIGINT');
  expect(events.serverClosed).toBe(0);
  expect(events.browserClosed).toBe(0);
  expect(events.removed).toHaveLength(1);
  expect(signals.count()).toBe(0);
});

test('a successful context is retired when a sibling context acquisition rejects', async () => {
  const { runtime, events } = setup({
    newContext: async (index, width) => {
      if (index === 1) throw new Error('second context rejected');
      const context = {
        async addInitScript() {},
        async newPage() {
          return {} as unknown as Page;
        },
        async close() {
          events.contextClosed.push(index);
        },
      } as unknown as BrowserContext;
      expect(width).toBe(1280);
      return context;
    },
  });

  await expect(runCaptureLifecycle(options(['--story', 'components-example--*']), runtime)).rejects.toThrow(
    'second context rejected',
  );
  expect(events.contextClosed).toEqual([0]);
  expect(events.navigations).toEqual([]);
  expect(events.removed).toEqual(['/fake/.temp/storybook-build-lifetime']);
});

test.each(['addInitScript', 'newPage'] as const)('%s setup failure retires every acquired resource', async (stage) => {
  const { runtime, events } = setup({
    stories: ['components-example--a'],
    addInitScript: async () => {
      if (stage === 'addInitScript') throw new Error('init script rejected');
    },
    newPage: async () => {
      if (stage === 'newPage') throw new Error('new page rejected');
      return {} as unknown as Page;
    },
  });

  await expect(runCaptureLifecycle(options(['--story', 'components-example--a']), runtime)).rejects.toThrow(
    stage === 'addInitScript' ? 'init script rejected' : 'new page rejected',
  );
  expect(events.contextClosed).toEqual([0]);
  expect(events.navigations).toEqual([]);
  expect(events.browserClosed).toBe(1);
  expect(events.serverClosed).toBe(1);
  expect(events.removed).toEqual(['/fake/.temp/storybook-build-lifetime']);
});

test.each(['reject', 'hang'] as const)(
  'a retired width scope whose context close %s keeps the build occupied after independent outer cleanup',
  async (mode) => {
    const { runtime, events } = setup({
      closeContext: async (index) => {
        if (index === 2 && mode === 'reject') throw new Error('context close rejected');
        if (index === 2 && mode === 'hang') await new Promise<void>(() => undefined);
      },
      cleanupTimeoutMs: 8,
    });

    const running = runCaptureLifecycle(
      options(['--story', 'components-example--*', '--width', '390', '--width', '1280']),
      runtime,
    );
    const failure = await running.then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain('Build directory retained at /fake/.temp/storybook-build-lifetime');
    expect(failure!.message).toContain(
      mode === 'reject'
        ? 'context 1 at 1280px close failed: context close rejected'
        : 'context 1 at 1280px close did not settle within 8ms.',
    );
    expect(events.widths).toEqual([390, 390, 1280, 1280]);
    expect(events.contextClosed.sort()).toEqual([0, 1, 2, 3]);
    expect(events.pageClosed.sort()).toEqual([0, 1, 2, 3]);
    expect(events.serverClosed).toBe(1);
    expect(events.browserClosed).toBe(1);
    expect(events.removed).toEqual([]);
  },
);

test.each(['browser', 'context', 'page'] as const)(
  'a late %s acquisition closes once after signal without starting jobs',
  async (target) => {
    const signals = signalHarness();
    const reached = deferred<void>();
    const late = deferred<Browser | BrowserContext | Page>();
    const closed = deferred<void>();
    let closeCount = 0;
    const closeLate = async () => {
      closeCount += 1;
      closed.resolve();
    };
    const lateHandle = {
      async close() {
        await closeLate();
      },
      async newContext() {
        reached.resolve();
        return (await late.promise) as unknown as BrowserContext;
      },
      async newPage() {
        reached.resolve();
        return (await late.promise) as unknown as Page;
      },
      async addInitScript() {},
    };
    const base = setup({ signals, stories: ['components-example--a'], cleanupTimeoutMs: 8 });
    const runtime: ScreenshotRuntime = {
      ...base.runtime,
      launch:
        target === 'browser'
          ? async () => {
              reached.resolve();
              return (await late.promise) as unknown as Browser;
            }
          : async () =>
              ({
                async newContext() {
                  reached.resolve();
                  return (await late.promise) as unknown as BrowserContext;
                },
                async close() {
                  base.events.browserClosed += 1;
                },
              }) as unknown as Browser,
    };
    if (target === 'page') {
      runtime.launch = async () =>
        ({
          async newContext() {
            return {
              async addInitScript() {},
              async newPage() {
                reached.resolve();
                return (await late.promise) as unknown as Page;
              },
              async close() {
                base.events.contextClosed.push(0);
              },
            } as unknown as BrowserContext;
          },
          async close() {
            base.events.browserClosed += 1;
          },
        }) as unknown as Browser;
    }
    const running = runCaptureLifecycle(options(['--story', 'components-example--a']), runtime);
    await reached.promise;
    signals.fire('SIGTERM');
    const failure = await running.then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    expect(failure).toBeInstanceOf(Error);
    const reason =
      target === 'browser'
        ? 'Playwright browser acquisition did not settle within 8ms.'
        : target === 'context'
          ? 'context 1 at 1280px acquisition did not settle within 8ms.'
          : 'page 1 at 1280px acquisition did not settle within 8ms.';
    expect(failure!.message).toContain(
      `Build directory retained at /fake/.temp/storybook-build-lifetime because ${reason}`,
    );
    expect(base.events.navigations).toEqual([]);
    expect(base.events.removed).toEqual([]);

    late.resolve(lateHandle as unknown as Browser | BrowserContext | Page);
    await closed.promise;
    await Promise.resolve();
    expect(closeCount).toBe(1);
    expect(signals.count()).toBe(0);
  },
);

test('an in-flight capture job that outlives page close keeps the build occupied through late completion', async () => {
  const signals = signalHarness();
  const started = deferred<void>();
  const navigation = deferred<unknown>();
  const { runtime, events } = setup({
    signals,
    stories: ['components-example--a'],
    cleanupTimeoutMs: 8,
    goto: async () => {
      started.resolve();
      return navigation.promise;
    },
  });

  const running = runCaptureLifecycle(options(['--story', 'components-example--a']), runtime);
  await started.promise;
  signals.fire('SIGTERM');
  const failure = await running.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );

  expect(failure).toBeInstanceOf(Error);
  expect(failure!.message).toContain(
    'Build directory retained at /fake/.temp/storybook-build-lifetime because capture job components-example--a en dark at 1280px acquisition did not settle within 8ms.',
  );
  expect(events.pageClosed).toEqual([0]);
  expect(events.contextClosed).toEqual([0]);
  expect(events.serverClosed).toBe(1);
  expect(events.browserClosed).toBe(1);
  expect(events.removed).toEqual([]);
  expect(events.navigations).toEqual(['components-example--a']);
  expect(signals.count()).toBe(0);

  navigation.resolve(null);
  await Promise.resolve();
  expect(events.removed).toEqual([]);
});
