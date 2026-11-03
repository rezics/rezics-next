import { expect, test } from 'bun:test';
import { EventEmitter, getEventListeners } from 'node:events';
import { basename } from 'node:path';
import type { Server } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  runCapture,
  freePort,
  captureMatrix,
  captureDependencies,
  type CaptureDependencies,
  type SiteChild,
} from '../scripts/screenshots';
import {
  CaptureLifetime,
  CaptureTimeout,
  runIsolatedChild,
  runIsolatedCommand,
  type CaptureClock,
} from '../scripts/isolated';

// These scenarios run the production composition with handles only. They never start a server,
// browser, subprocess or screenshot, and do not replace the original native PNG assertions.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class Timers implements CaptureClock {
  now = 0;
  next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  set = (callback: () => void, milliseconds: number) => {
    const id = ++this.next;
    this.tasks.set(id, { at: this.now + milliseconds, callback });
    return id;
  };
  clear = (id: unknown) => {
    this.tasks.delete(id as number);
  };
  advance() {
    const at = Math.min(...[...this.tasks.values()].map((task) => task.at));
    if (!Number.isFinite(at)) throw new Error('No owned deadline can make progress.');
    this.now = at;
    for (const [id, task] of [...this.tasks]) {
      if (task.at <= at && this.tasks.delete(id)) task.callback();
    }
  }
}
const turn = () => new Promise<void>((done) => setImmediate(done));

function observe(promise: Promise<unknown>) {
  const result: { done: boolean; error?: unknown } = { done: false };
  void promise.then(
    () => {
      result.done = true;
    },
    (error) => {
      result.done = true;
      result.error = error;
    },
  );
  return result;
}
async function settle(result: ReturnType<typeof observe>, timers: Timers) {
  for (let count = 0; count < 16; count += 1) {
    await turn();
    if (result.done) return;
    timers.advance();
  }
  throw new Error('Composition exceeded its finite retirement deadlines.');
}
function errors(error: unknown): unknown[] {
  return error instanceof AggregateError ? [error, ...error.errors.flatMap(errors)] : [error];
}

type Stage =
  | 'port'
  | 'spawn'
  | 'readiness'
  | 'launch'
  | 'context'
  | 'cookies'
  | 'page'
  | 'goto'
  | 'hydration'
  | 'fonts'
  | 'capture';
function fixture(
  options: {
    fail?: Stage;
    failAt?: number;
    hold?: Stage;
    cleanup?: 'reject' | 'hang';
    outputOpen?: boolean;
    outputCancelHang?: boolean;
    exitAlready?: boolean;
    childHang?: boolean;
  } = {},
) {
  const timers = new Timers();
  const owner = new CaptureLifetime(timers, 400);
  const source = new EventEmitter() as unknown as typeof process;
  const events: string[] = [];
  const counts = new Map<string, number>();
  const operationError = new Error('original operation failure');
  const cleanupErrors = new Map<string, Error>();
  const arrived = deferred<void>();
  const release = deferred<void>();
  async function stage(name: Stage) {
    events.push(name);
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (options.fail === name && count === (options.failAt ?? 1)) throw operationError;
    if (options.hold === name) {
      arrived.resolve();
      await release.promise;
    }
  }
  function close(name: string) {
    events.push(name);
    if (options.cleanup === 'hang') return new Promise<void>(() => {});
    if (options.cleanup === 'reject') {
      const error = new Error(name + ' failure');
      cleanupErrors.set(name, error);
      return Promise.reject(error);
    }
    return Promise.resolve();
  }
  const exited = deferred<number>();
  const outputCancelled: string[] = [];
  const output = (name: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (!options.outputOpen) controller.close();
      },
      cancel() {
        outputCancelled.push(name);
        if (options.outputCancelHang) return new Promise<void>(() => {});
      },
    });
  const child: SiteChild = {
    exitCode: options.exitAlready ? 1 : null,
    exited: exited.promise,
    stdout: output('stdout'),
    stderr: output('stderr'),
    kill(signal) {
      events.push('kill:' + signal);
      if (options.cleanup === 'reject') {
        const error = new Error('kill failure');
        cleanupErrors.set('kill', error);
        throw error;
      }
      if (!options.childHang && options.cleanup !== 'hang') {
        child.exitCode = 0;
        exited.resolve(0);
      }
    },
  };
  if (options.exitAlready) exited.resolve(1);
  const contextOptions: unknown[] = [];
  const cookies: unknown[] = [];
  const captures: {
    path: string;
    fullPage: boolean;
    animations: string;
    viewport: unknown;
    theme: unknown;
    url: string;
    ready: string[];
  }[] = [];
  const manifests: Array<{ path: string; manifest: { version: number; sourceRevision: string; captures: any[] } }> = [];
  let activePages = 0;
  let activeContexts = 0;
  let maxPages = 0;
  let maxContexts = 0;
  let serial = 0;
  const browser = {
    async newContext(config: unknown) {
      await stage('context');
      contextOptions.push(config);
      activeContexts += 1;
      maxContexts = Math.max(maxContexts, activeContexts);
      const contextId = ++serial;
      return {
        async addCookies(value: unknown) {
          cookies.push(value);
          await stage('cookies');
        },
        async newPage() {
          await stage('page');
          activePages += 1;
          maxPages = Math.max(maxPages, activePages);
          const pageId = ++serial;
          let viewport: unknown;
          let theme: unknown;
          let url = '';
          const listeners = new Map<string, Array<(...args: any[]) => void>>();
          const ready: string[] = [];
          const locator = (selector: string) => ({
            first() {
              return this;
            },
            nth() {
              return this;
            },
            async fill() {},
            async click() {},
            async waitFor() {
              if (selector === 'html[data-hydrated]') {
                await stage('hydration');
                ready.push('hydration');
              }
            },
          });
          return {
            setDefaultTimeout() {},
            async setViewportSize(value: unknown) {
              viewport = value;
            },
            async emulateMedia(value: unknown) {
              theme = value;
            },
            async goto(value: string) {
              url = value;
              await stage('goto');
              if (!captures.length) {
                for (const listener of listeners.get('console') ?? [])
                  listener({ type: () => 'error', text: () => 'auth_session=auth-screenshot-session token=screenshot-token' });
                for (const listener of listeners.get('pageerror') ?? []) listener(new Error('login failed: reader@example.test'));
              }
              return { status: () => 200 };
            },
            on(event: string, listener: (...args: any[]) => void) {
              listeners.set(event, [...(listeners.get(event) ?? []), listener]);
              return this;
            },
            locator,
            getByRole: locator,
            async evaluate() {
              await stage('fonts');
              ready.push('fonts');
            },
            async waitForResponse() {},
            async screenshot(value: { path: string; fullPage: boolean; animations: string }) {
              await stage('capture');
              captures.push({ ...value, viewport, theme, url, ready: [...ready] });
            },
            async close() {
              activePages -= 1;
              await close('page.close:' + pageId);
            },
          } as unknown as Page;
        },
        async close() {
          activeContexts -= 1;
          await close('context.close:' + contextId);
        },
      } as unknown as BrowserContext;
    },
    close: () => close('browser.close'),
  } as unknown as Browser;
  const deps: CaptureDependencies = {
    mkdir: async () => {
      events.push('mkdir');
    },
    sourceRevision: () => 'c'.repeat(40),
    writeManifest: async (path, manifest) => {
      manifests.push({ path, manifest });
    },
    startFake: () => ({
      url: new URL('http://127.0.0.1:9000'),
      stop: (force) => {
        expect(force).toBe(true);
        return close('fake.stop');
      },
    }),
    freePort: async () => {
      await stage('port');
      return 4200;
    },
    spawn: async () => {
      await stage('spawn');
      return child;
    },
    fetch: async () => {
      await stage('readiness');
      return { status: 200 };
    },
    launch: async () => {
      await stage('launch');
      return browser;
    },
    sleep: async () => {},
  };
  const begin = () => observe(runCapture('/capture-output', deps, owner, source));
  const detached = () => {
    expect(source.listenerCount('SIGINT')).toBe(0);
    expect(source.listenerCount('SIGTERM')).toBe(0);
    expect(timers.tasks.size).toBe(0);
    expect(getEventListeners(owner.controller.signal, 'abort')).toEqual([]);
  };
  return {
    timers,
    owner,
    source,
    events,
    operationError,
    cleanupErrors,
    arrived,
    release,
    child,
    exited,
    deps,
    contextOptions,
    cookies,
    captures,
    manifests,
    outputCancelled,
    begin,
    detached,
    maximum: () => ({ pages: maxPages, contexts: maxContexts }),
  };
}

test('full capture matrix, output identity, manifest, cookies and readiness use bounded handles', async () => {
  const f = fixture();
  const result = f.begin();
  await settle(result, f.timers);
  expect(result.error).toBeUndefined();
  const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
  const matrix = captureMatrix();
  expect(f.captures.map((capture) => basename(capture.path))).toEqual(matrix.map((target) => target.imagePath));
  expect(matrix).toHaveLength(320);
  expect(f.manifests).toHaveLength(1);
  const { path: manifestPath, manifest } = f.manifests[0]!;
  expect(manifestPath).toBe('/capture-output/manifest.json');
  expect(manifest.version).toBe(1);
  expect(manifest.sourceRevision).toBe('c'.repeat(40));
  expect(manifest.captures.map((capture) => capture.imagePath)).toEqual(matrix.map((target) => target.imagePath));
  expect(manifest.captures[0]).toMatchObject({
    state: 'login',
    route: '/login',
    persona: 'fresh reader session',
    locale: 'en',
    theme: 'light',
    viewport: { name: 'desktop1280', width: 1280, height: 900 },
    errors: [
      { source: 'console', message: 'auth_session=[redacted] token=[redacted]' },
      { source: 'pageerror', message: 'login failed: [redacted]' },
    ],
  });
  const manifestJson = JSON.stringify(manifest);
  expect(manifestJson).not.toContain('auth-screenshot-session');
  expect(manifestJson).not.toContain('screenshot-token');
  expect(manifestJson).not.toContain('reader@example.test');
  expect(f.contextOptions).toEqual(
    locales.map((locale) => ({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
      locale,
      extraHTTPHeaders: { 'Accept-Language': locale },
      javaScriptEnabled: true,
    })),
  );
  expect(f.cookies).toEqual(
    locales.map(() => [{ name: 'auth_session', value: 'auth-screenshot-session', url: 'http://127.0.0.1:4200' }]),
  );
  for (const [index, capture] of f.captures.entries()) {
    const target = matrix[index]!;
    expect(capture.url).toBe('http://127.0.0.1:4200' + target.route);
    expect(capture.viewport).toEqual({ width: target.viewport.width, height: target.viewport.height });
    expect(capture.theme).toEqual({ colorScheme: target.theme });
    expect(capture.fullPage).toBe(true);
    expect(capture.animations).toBe('disabled');
    expect(capture.ready).toEqual(['hydration', 'fonts', 'hydration', 'fonts']);
  }
  expect(f.maximum()).toEqual({ pages: 1, contexts: 1 });
  expect(f.events.filter((event) => event.startsWith('page.close:'))).toHaveLength(320);
  expect(f.events.filter((event) => event.startsWith('context.close:'))).toHaveLength(8);
  expect(f.events.filter((event) => event === 'fake.stop')).toHaveLength(1);
  f.detached();
});

for (const fail of ['context', 'cookies', 'goto', 'hydration', 'fonts'] as const) {
  test(`${fail} failure retires the handle acquired before the failing await`, async () => {
    const f = fixture({ fail, failAt: fail === 'cookies' || fail === 'context' ? 2 : 1 });
    const result = f.begin();
    await settle(result, f.timers);
    expect(errors(result.error)).toContain(f.operationError);
    expect((result.error as AggregateError).errors[0]).toBe(f.operationError);
    expect(f.events.filter((event) => event.startsWith('context.close:'))).toHaveLength(fail === 'cookies' ? 2 : 1);
    expect(f.events.filter((event) => event.startsWith('page.close:'))).toHaveLength(
      fail === 'cookies' || fail === 'context' ? 40 : 1,
    );
    expect(f.events).toContain('browser.close');
    expect(f.events).toContain('fake.stop');
    expect(f.events).toContain('kill:SIGTERM');
    f.detached();
  });
}

for (const hold of ['port', 'spawn', 'readiness', 'launch', 'context', 'page', 'capture'] as const) {
  test(`cancellation during ${hold} fences work and disposes a late successful acquisition once`, async () => {
    const f = fixture({ hold });
    const result = f.begin();
    await f.arrived.promise;
    const reason = new Error('cancel at ' + hold);
    f.owner.cancel(reason);
    await settle(result, f.timers);
    expect((result.error as AggregateError).errors[0]).toBe(reason);
    const beforeLate = [...f.events];
    f.release.resolve();
    await turn();
    const late = f.events.slice(beforeLate.length);
    expect(late.every((event) => /close|kill/.test(event))).toBe(true);
    expect(f.events.filter((event) => event === 'fake.stop')).toHaveLength(1);
    if (hold === 'launch') expect(late).toEqual(['browser.close']);
    if (hold === 'context') expect(late.filter((event) => event.startsWith('context.close:'))).toHaveLength(1);
    if (hold === 'page') expect(late.filter((event) => event.startsWith('page.close:'))).toHaveLength(1);
    if (hold === 'spawn') expect(late).toEqual(['kill:SIGTERM']);
    expect(new Set(f.events.filter((event) => /\.close:/.test(event))).size).toBe(
      f.events.filter((event) => /\.close:/.test(event)).length,
    );
    f.detached();
  });
}

for (const cleanup of ['reject', 'hang'] as const) {
  test(`independent ${cleanup} cleanup retains the original capture failure and every cleanup error`, async () => {
    const f = fixture({ fail: 'capture', cleanup });
    const result = f.begin();
    await settle(result, f.timers);
    expect((result.error as AggregateError).errors[0]).toBe(f.operationError);
    for (const name of ['page.close:', 'context.close:', 'browser.close', 'fake.stop', 'kill:SIGTERM'])
      expect(f.events.some((event) => event.startsWith(name))).toBe(true);
    const all = errors(result.error);
    for (const error of f.cleanupErrors.values()) expect(all).toContain(error);
    if (cleanup === 'hang') expect(all.some((error) => error instanceof CaptureTimeout)).toBe(true);
    expect(f.events.filter((event) => event === 'kill:SIGKILL')).toHaveLength(1);
    expect(f.events.filter((event) => event === 'capture')).toHaveLength(1);
    f.detached();
  });
}

test('child exit does not settle inherited output; EOF and reader cancellation have independent bounds', async () => {
  const f = fixture({ exitAlready: true, outputOpen: true });
  const result = f.begin();
  await settle(result, f.timers);
  expect(f.events).toContain('fake.stop');
  expect(f.events).not.toContain('launch');
  expect(f.outputCancelled.sort()).toEqual(['stderr', 'stdout']);
  expect(errors(result.error).filter((error) => error instanceof CaptureTimeout)).toHaveLength(2);
  f.detached();
});

test('child termination is bounded independently from already closed output', async () => {
  const f = fixture({ fail: 'goto', childHang: true });
  const result = f.begin();
  await settle(result, f.timers);
  expect((result.error as AggregateError).errors[0]).toBe(f.operationError);
  expect(f.child.exitCode).toBeNull();
  expect(errors(result.error).filter((error) => error instanceof CaptureTimeout)).toHaveLength(2);
  expect(f.events).toContain('fake.stop');
  f.detached();
});

test('late cleanup rejection stays attached to the reported error and is observed once', async () => {
  const f = fixture({ hold: 'launch', cleanup: 'reject' });
  const result = f.begin();
  await f.arrived.promise;
  f.owner.cancel();
  await settle(result, f.timers);
  f.release.resolve();
  await turn();
  expect(errors(result.error)).toContain(f.cleanupErrors.get('browser.close'));
  expect(f.events.filter((event) => event === 'browser.close')).toHaveLength(1);
  f.detached();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} listeners and all timers detach after bounded isolated-child retirement`, async () => {
    const f = fixture({ childHang: true });
    const result = observe(runIsolatedChild(() => f.child, f.owner, f.source));
    await turn();
    f.source.emit(signal);
    await settle(result, f.timers);
    expect(result.error).toBeInstanceOf(AggregateError);
    expect(f.events).toEqual(['kill:' + signal, 'kill:SIGKILL']);
    expect(f.child.exitCode).toBeNull();
    f.detached();
  });
}

test('ordinary isolated exit removes forwarders without killing a closed child', async () => {
  const f = fixture({ exitAlready: true });
  expect(await runIsolatedChild(() => f.child, f.owner, f.source)).toBe(1);
  expect(f.events).toEqual([]);
  f.detached();
});

test('readiness has an overall deadline independent of a hanging delay', async () => {
  const f = fixture();
  f.deps.fetch = async () => ({ status: 503 });
  f.deps.sleep = () => new Promise<void>(() => {});
  const result = f.begin();
  await settle(result, f.timers);
  expect(errors(result.error).some((error) => error instanceof CaptureTimeout)).toBe(true);
  expect(f.events).not.toContain('launch');
  expect(f.events).toContain('kill:SIGTERM');
  expect(f.events).toContain('fake.stop');
  f.detached();
});

test('an acquisition deadline retires startup and still closes a late browser once', async () => {
  const f = fixture({ hold: 'launch' });
  const result = f.begin();
  await f.arrived.promise;
  await settle(result, f.timers);
  expect(errors(result.error).some((error) => error instanceof CaptureTimeout)).toBe(true);
  f.release.resolve();
  await turn();
  expect(f.events.filter((event) => event === 'browser.close')).toHaveLength(1);
  expect(f.events).not.toContain('context');
  f.detached();
});

test('output cancellation that never settles remains unknown after its own deadline', async () => {
  const f = fixture({ exitAlready: true, outputOpen: true, outputCancelHang: true });
  const result = f.begin();
  await settle(result, f.timers);
  expect(f.outputCancelled.sort()).toEqual(['stderr', 'stdout']);
  expect(errors(result.error).filter((error) => error instanceof CaptureTimeout)).toHaveLength(4);
  expect(f.events).toContain('fake.stop');
  f.detached();
});

test('cancellation before startup issues no mkdir, server, port or browser work', async () => {
  const f = fixture();
  f.owner.cancel();
  const result = f.begin();
  await settle(result, f.timers);
  expect(result.error).toBeInstanceOf(AggregateError);
  expect(f.events).toEqual([]);
  f.detached();
});

test('an isolated child acquired after cancellation is retired once', async () => {
  const f = fixture();
  const child = deferred<SiteChild>();
  const result = observe(runIsolatedChild(() => child.promise, f.owner, f.source));
  f.source.emit('SIGTERM');
  await settle(result, f.timers);
  child.resolve(f.child);
  await turn();
  expect(f.events).toEqual(['kill:SIGTERM']);
  f.detached();
});

test('a close rejection arriving after its timeout is retained without another close attempt', async () => {
  const f = fixture({ fail: 'capture' });
  const closed = deferred<void>();
  const launch = f.deps.launch;
  f.deps.launch = async () => {
    const browser = await launch();
    browser.close = () => {
      f.events.push('late browser.close');
      return closed.promise;
    };
    return browser;
  };
  const result = f.begin();
  await settle(result, f.timers);
  const late = new Error('physical close later rejected');
  closed.reject(late);
  await turn();
  expect((result.error as AggregateError).errors[0]).toBe(f.operationError);
  expect(errors(result.error)).toContain(late);
  expect(f.events.filter((event) => event === 'late browser.close')).toHaveLength(1);
  f.detached();
});

test('late readiness response bodies are cancelled exactly once after retirement', async () => {
  const f = fixture();
  const response = deferred<{ status: number; body: { cancel: () => Promise<void> } }>();
  const arrived = deferred<void>();
  let cancelled = 0;
  f.deps.fetch = () => {
    arrived.resolve();
    return response.promise;
  };
  const result = f.begin();
  await arrived.promise;
  f.owner.cancel();
  await settle(result, f.timers);
  response.resolve({
    status: 200,
    body: {
      cancel: async () => {
        cancelled += 1;
      },
    },
  });
  await turn();
  expect(cancelled).toBe(1);
  expect(f.events).not.toContain('launch');
  f.detached();
});

test('occupied-port startup retains four attempts and finite output tails without restarting capture', async () => {
  const f = fixture();
  let spawns = 0;
  f.deps.spawn = () => {
    spawns += 1;
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(50_000) + ' already in use'));
          controller.close();
        },
      });
    return {
      exitCode: 1,
      exited: Promise.resolve(1),
      kill: () => {
        throw new Error('Closed child must not be killed.');
      },
      stdout: stream(),
      stderr: stream(),
    };
  };
  const result = f.begin();
  await settle(result, f.timers);
  expect(spawns).toBe(4);
  expect(f.events.filter((event) => event === 'port')).toHaveLength(4);
  expect(f.events).not.toContain('launch');
  expect(f.captures).toEqual([]);
  const primary = (result.error as AggregateError).errors[0] as Error;
  expect(primary.message).toContain('already in use');
  expect(primary.message.length).toBeLessThan(24_100);
  expect(f.events.filter((event) => event === 'fake.stop')).toHaveLength(1);
  f.detached();
});

for (const probeCode of [0, 1]) {
  test(`isolated production composition preserves namespace placement for probe exit ${probeCode}`, async () => {
    const f = fixture({ exitAlready: true });
    const invocations: string[][] = [];
    let warnings = 0;
    const command = ['bun', 'scripts/screenshots.ts', '--out', '/original-output'];
    const code = await runIsolatedCommand(
      command,
      {
        linux: true,
        probe: () => ({
          exitCode: probeCode,
          exited: Promise.resolve(probeCode),
          kill: () => {
            throw new Error('probe already exited');
          },
        }),
        spawn: (invocation) => {
          invocations.push(invocation);
          return f.child;
        },
        warn: () => {
          warnings += 1;
        },
      },
      f.owner,
      f.source,
    );
    expect(code).toBe(1);
    expect(invocations).toEqual([
      probeCode === 0
        ? [
            'unshare',
            '--user',
            '--map-root-user',
            '--net',
            'sh',
            '-c',
            'ip link set lo up && exec "$@"',
            'sh',
            ...command,
          ]
        : command,
    ]);
    expect(warnings).toBe(probeCode === 0 ? 0 : 1);
    f.detached();
  });
}

test('cancellation during namespace probing fences the invocation and retires a late probe', async () => {
  const f = fixture();
  const probe = deferred<SiteChild>();
  const arrived = deferred<void>();
  let spawns = 0;
  const result = observe(
    runIsolatedCommand(
      ['bun', 'scripts/screenshots.ts'],
      {
        linux: true,
        probe: () => {
          arrived.resolve();
          return probe.promise;
        },
        spawn: () => {
          spawns += 1;
          return f.child;
        },
        warn: () => {
          throw new Error('No fallback after cancellation.');
        },
      },
      f.owner,
      f.source,
    ),
  );
  await arrived.promise;
  f.source.emit('SIGTERM');
  await settle(result, f.timers);
  probe.resolve(f.child);
  await turn();
  expect(spawns).toBe(0);
  expect(f.events).toEqual(['kill:SIGTERM']);
  f.detached();
});

test('isolated production composition closes a late invocation after cancellation once', async () => {
  const f = fixture();
  const child = deferred<SiteChild>();
  const arrived = deferred<void>();
  const result = observe(
    runIsolatedCommand(
      ['bun', 'scripts/screenshots.ts'],
      {
        linux: false,
        probe: () => {
          throw new Error('Non-Linux execution must not probe.');
        },
        spawn: () => {
          arrived.resolve();
          return child.promise;
        },
        warn: () => {
          throw new Error('Non-Linux execution must not warn.');
        },
      },
      f.owner,
      f.source,
    ),
  );
  await arrived.promise;
  f.source.emit('SIGINT');
  await settle(result, f.timers);
  child.resolve(f.child);
  await turn();
  expect(f.events).toEqual(['kill:SIGINT']);
  f.detached();
});

test('namespace probe exit has a separate deadline and unknown capability never starts the invocation', async () => {
  const f = fixture();
  let spawns = 0;
  const result = observe(
    runIsolatedCommand(
      ['bun', 'scripts/screenshots.ts'],
      {
        linux: true,
        probe: () => f.child,
        spawn: () => {
          spawns += 1;
          return f.child;
        },
        warn: () => {
          throw new Error('Unknown probe capability must remain unknown.');
        },
      },
      f.owner,
      f.source,
    ),
  );
  await settle(result, f.timers);
  expect(errors(result.error).some((error) => error instanceof CaptureTimeout)).toBe(true);
  expect(spawns).toBe(0);
  expect(f.events).toEqual(['kill:SIGTERM']);
  f.detached();
});

test('production port acquisition fences a pending listen before a late callback', async () => {
  const f = fixture();
  const arrived = deferred<void>();
  let closed = 0;
  let listening!: () => void;
  let listenSignal!: AbortSignal;
  const probe = {
    once() {
      return this;
    },
    listen(options: { signal: AbortSignal }, callback: () => void) {
      listenSignal = options.signal;
      listening = callback;
      arrived.resolve();
      return this;
    },
    close(callback: () => void) {
      closed += 1;
      callback();
      return this;
    },
    address() {
      return null;
    },
  } as unknown as Server;
  f.deps.freePort = (owner) => freePort(owner, () => probe);
  const result = f.begin();
  await arrived.promise;
  f.owner.cancel();
  await settle(result, f.timers);
  expect(listenSignal.aborted).toBe(true);
  expect(closed).toBe(1);
  listening();
  await turn();
  expect(closed).toBe(1);
  expect(f.events).not.toContain('spawn');
  f.detached();
});

test('production readiness sleep clears its timer and abort listener on cancellation', async () => {
  const f = fixture();
  const sleeping = deferred<void>();
  f.deps.fetch = async () => ({ status: 503 });
  f.deps.sleep = (owner) => {
    sleeping.resolve();
    return captureDependencies.sleep(owner);
  };
  const result = f.begin();
  await sleeping.promise;
  f.source.emit('SIGTERM');
  await settle(result, f.timers);
  expect(f.events).not.toContain('launch');
  f.detached();
});
