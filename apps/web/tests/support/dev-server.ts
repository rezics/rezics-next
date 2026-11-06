import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions } from 'playwright';
import {
  cleanupAll,
  directChildExitCode,
  liveProcessGroupMemberIds,
  ownBunProcess,
  processHasExited,
  withCleanup,
} from './server-custody.ts';
import {
  bindWorkerFixtureOrigins,
  readSharedDevServer,
  sharedDevServerEnvName,
  workerFixtureBindingsCompatible,
  workerFixtureOverlay,
  type SharedDevServerRecord,
  type WorkerFixtureOverlay,
} from './dev-server-fixture.ts';
import { testWorkerBindingsEnvName } from '../../src/test-runtime-binding-config.ts';

// Render budgets start at Vite's ready line, independently of its startup budget.
const phaseBudgets = { ready: 150_000, firstResponse: 120_000, warmUp: 120_000 };
let serialViteChain = Promise.resolve();

function acquireSerialViteSlot(options: DevServerOptions): Promise<() => void> {
  if (options.serial !== true && process.env.REZICS_WEB_SERIAL_VITE !== '1') return Promise.resolve(() => {});
  let released = false;
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const previous = serialViteChain;
  serialViteChain = previous.then(() => held);
  const release = () => {
    if (released) return;
    released = true;
    releaseHeld();
  };
  const signal = options.signal;
  return new Promise<() => void>((resolve, reject) => {
    const abort = () => {
      release();
      reject(new DOMException('The dev server startup was aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    const onAbort = () => abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        abort();
        return;
      }
      resolve(release);
    });
  });
}

type Phase = 'ready' | 'first response' | 'warm-up';
type PhaseTiming = { phase: Phase; path: string; elapsedMs: number };
export type DevServerOptions = {
  env?: NodeJS.ProcessEnv;
  warmUpPaths: readonly string[];
  javaScriptEnabled?: boolean;
  contextOptions?: BrowserContextOptions;
  firstPath?: string;
  cwd?: string;
  command?: (context: { port: number; origin: string }) => string[];
  /** Start a private Vite process even when the check run advertised a shared server. */
  exclusive?: boolean;
  budgets?: Partial<typeof phaseBudgets>;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onPhase?: (timing: PhaseTiming) => void;
  /** A clock seam for deterministic budget tests; timers still use the remaining phase budget. */
  now?: () => number;
  /** Hold the in-process Vite slot until stop(). Focused checks also set REZICS_WEB_SERIAL_VITE. */
  serial?: boolean;
};

export type DevServerHandle = {
  origin: string;
  pid: number | undefined;
  shared: boolean;
  workerBindings: WorkerFixtureOverlay;
  stop: () => Promise<void>;
  diagnostics: () => string;
};

function bindOrigin(value: string | undefined, origin: string): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):(?:undefined|\$\{port\}|\d+)/g, origin);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForFirstResponse(
  origin: string,
  firstPath: string,
  options: {
    deadline: number;
    now: () => number;
    pollIntervalMs: number;
    signal?: AbortSignal;
    onError: (error: unknown) => void;
  },
): Promise<void> {
  for (;;) {
    if (options.signal?.aborted) throw new DOMException('The dev server startup was aborted', 'AbortError');
    try {
      const response = await fetch(`${origin}${firstPath}`, {
        redirect: 'manual',
        signal: options.signal ?? AbortSignal.timeout(Math.max(1, options.deadline - options.now())),
      });
      await response.body?.cancel();
      if (response.status < 500) return;
      options.onError(new Error(`HTTP ${response.status} for ${firstPath}`));
    } catch (error) {
      options.onError(error);
      if (options.signal?.aborted) throw error;
    }
    if (options.now() >= options.deadline) throw new Error('phase budget exhausted');
    await Bun.sleep(Math.min(options.pollIntervalMs, Math.max(1, options.deadline - options.now())));
  }
}

async function acquireSharedDevServer(
  options: DevServerOptions,
  record: SharedDevServerRecord | undefined,
): Promise<DevServerHandle | undefined> {
  if (options.command || options.exclusive || !record) return undefined;
  const now = options.now ?? Date.now;
  const requestedBindings = bindWorkerFixtureOrigins(workerFixtureOverlay(options.env) ?? {}, record.origin);
  if (!workerFixtureBindingsCompatible(requestedBindings, record.workerBindings)) return undefined;
  const firstPath = options.firstPath ?? '/en';
  const budgets = { ...phaseBudgets, ...options.budgets };
  const spawnedAt = now();
  if (options.signal?.aborted) throw new DOMException('The dev server startup was aborted', 'AbortError');
  let lastError: unknown = new Error(`no response from ${firstPath}`);
  await waitForFirstResponse(record.origin, firstPath, {
    deadline: spawnedAt + budgets.firstResponse,
    now,
    pollIntervalMs: options.pollIntervalMs ?? 500,
    onError: (error) => {
      lastError = error;
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  options.onPhase?.({ phase: 'first response', path: firstPath, elapsedMs: now() - spawnedAt });
  if (options.warmUpPaths.length > 0) {
    const deadline = now() + budgets.warmUp;
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ timeout: Math.max(1, deadline - now()) });
      const context = await browser.newContext({
        ...options.contextOptions,
        javaScriptEnabled: options.javaScriptEnabled ?? options.contextOptions?.javaScriptEnabled ?? true,
      });
      await withCleanup(async () => {
        const page = await context.newPage();
        for (const warmUpPath of options.warmUpPaths) {
          const began = now();
          const response = await page.goto(`${record.origin}${warmUpPath}`, {
            waitUntil: 'networkidle',
            timeout: Math.max(1, deadline - now()),
          });
          if (!response || response.status() >= 500)
            throw new Error(`HTTP ${response?.status() ?? 'no response'} for ${warmUpPath}`);
          if (options.javaScriptEnabled ?? options.contextOptions?.javaScriptEnabled ?? true)
            await page.locator('html[data-hydrated]').waitFor({
              state: 'attached',
              timeout: Math.max(1, deadline - now()),
            });
          options.onPhase?.({ phase: 'warm-up', path: warmUpPath, elapsedMs: now() - began });
        }
      }, [{ label: 'dev-server warm-up context', run: () => context.close(), timeoutMs: 5000 }]);
    } catch (error) {
      throw new Error(
        `dev server warm-up failed for ${options.warmUpPaths[0]}; elapsed ${now() - spawnedAt} ms; last error: ${String(error)}\n${lastError}`,
        { cause: error },
      );
    } finally {
      await browser?.close();
    }
  }
  if (options.signal?.aborted) throw new DOMException('The dev server startup was aborted', 'AbortError');
  return {
    origin: record.origin,
    pid: record.pid,
    shared: true,
    workerBindings: record.workerBindings,
    stop: async () => {},
    diagnostics: () => `shared ${sharedDevServerEnvName} ${record.origin} pid=${record.pid}`,
  };
}

/** One process group and one warm-up for each browser test file, or the shared run server when advertised. Always await stop() in afterAll. */
export async function startDevServer(options: DevServerOptions): Promise<DevServerHandle> {
  const sharedRecord = options.command || options.exclusive ? undefined : readSharedDevServer();
  const shared = await acquireSharedDevServer(options, sharedRecord);
  if (shared) return shared;
  const port = await freePort();
  if (options.signal?.aborted) throw new DOMException('The dev server startup was aborted', 'AbortError');
  const origin = `http://127.0.0.1:${port}`;
  const releaseSerialVite = await acquireSerialViteSlot(options);
  const now = options.now ?? Date.now;
  const spawnedAt = now();
  const command = options.command?.({ port, origin }) ?? [
    'bun',
    'run',
    'dev',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ];
  const budgets = { ...phaseBudgets, ...options.budgets };
  const firstPath = options.firstPath ?? '/en';
  let readyAt: number | undefined;
  let phase: Phase = 'ready';
  let path = firstPath;
  let phaseStart = spawnedAt;
  let lastError: unknown = new Error('Vite ready line has not been printed');
  let browser: Browser | undefined;
  let stopped: Promise<void> | undefined;
  let abortCleanupError: unknown;
  let output = '';
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const keep = (chunk: Uint8Array) => {
    const combined = output + Buffer.from(chunk).toString();
    output = combined.slice(-24_000);
    if (
      readyAt === undefined &&
      /\bVITE\s+v\S+\s+ready in\s+[\d.]+\s*(?:ms|s)\b/i.test(combined.replace(/\x1b\[[0-9;]*m/g, ''))
    ) {
      readyAt = now();
      ready();
    }
  };
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let custody: ReturnType<typeof ownBunProcess> | undefined;
  let workerBindings: WorkerFixtureOverlay = {};
  const captured = () => {
    const pid = child?.pid;
    const members = pid === undefined ? [] : liveProcessGroupMemberIds(pid);
    const exit = child === undefined ? undefined : (child.exitCode ?? (pid === undefined ? undefined : directChildExitCode(pid)));
    const capturedOutput = custody?.diagnostics() || output;
    return [
      `$ ${command.join(' ')}`,
      `pid=${pid ?? 'none'} exit=${exit ?? 'running'} live=${members.join(',') || 'none'}`,
      capturedOutput,
      output && output !== capturedOutput ? output : '',
    ]
      .filter(Boolean)
      .join('\n');
  };
  try {
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      REZICS_TEST_RUNTIME: '1',
    };
    childEnvironment.PUBLIC_ORIGIN = bindOrigin(childEnvironment.PUBLIC_ORIGIN, origin) ?? origin;
    if (childEnvironment.SITE_ORIGINS)
      childEnvironment.SITE_ORIGINS = bindOrigin(childEnvironment.SITE_ORIGINS, origin);
    if (options.env?.WEB_TEST_STATE_DIR && !options.env.WEB_TEST_STATE_INSTANCE_DIR)
      childEnvironment.WEB_TEST_STATE_INSTANCE_DIR = options.env.WEB_TEST_STATE_DIR;
    if (!childEnvironment.WEB_VITE_CACHE_DIR && sharedRecord?.cacheDirectory)
      childEnvironment.WEB_VITE_CACHE_DIR = sharedRecord.cacheDirectory;
    workerBindings = bindWorkerFixtureOrigins(workerFixtureOverlay(childEnvironment) ?? {}, origin);
    childEnvironment[testWorkerBindingsEnvName] = JSON.stringify(workerBindings);
    child = Bun.spawn(command, {
      cwd: options.cwd ?? join(import.meta.dir, '../..'),
      env: childEnvironment,
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    custody = ownBunProcess(child, {
      label: 'Vite dev server',
      onOutput: keep,
      termGraceMs: 2_000,
      settleTimeoutMs: 5_000,
      outputLimit: 24_000,
    });
  } catch (error) {
    releaseSerialVite();
    throw new Error(
      `dev server ready failed for ${path}; elapsed ${now() - spawnedAt} ms; last error: ${String(error)}\nCaptured output:\n${captured()}`,
    );
  }
  if (!child || !custody) {
    releaseSerialVite();
    throw new Error(`dev server ready failed for ${path}; child was not started\n${captured()}`);
  }
  const pollMs = options.pollIntervalMs ?? 25;
  const started = child;
  const processCustody = custody;
  const exited = Promise.race([
    started.exited.then((code) => new Error(`dev server exited with ${code}`)),
    new Promise<Error>((resolve) => {
      const tick = () => {
        if (started.exitCode !== null) {
          resolve(new Error(`dev server exited with ${started.exitCode}`));
          return;
        }
        if (started.pid !== undefined && processHasExited(started.pid)) {
          const code = directChildExitCode(started.pid);
          if (code !== undefined) {
            resolve(new Error(`dev server exited with ${code}`));
            return;
          }
        }
        setTimeout(tick, pollMs);
      };
      tick();
    }),
  ]);
  const exitFailure = exited.then((error) => {
    throw error;
  });
  // The server can exit between phases, when no race is attached yet.
  void exitFailure.catch(() => {});

  let abortServer: () => void;
  const stop = () =>
    (stopped ??= (async () => {
      options.signal?.removeEventListener('abort', abortServer);
      try {
        await cleanupAll([
          { label: 'dev-server browser', run: () => browser?.close(), timeoutMs: 5000 },
          { label: 'dev-server process group', run: () => processCustody.close(), timeoutMs: 16_000 },
        ]);
      } finally {
        releaseSerialVite();
      }
    })());
  abortServer = () => {
    void stop().catch((error) => {
      abortCleanupError = error;
    });
  };

  const record = (startedAt: number) => {
    const timing = { phase, path, elapsedMs: now() - startedAt };
    console.info(`[dev-server] ${phase} ${path}: ${timing.elapsedMs} ms`);
    options.onPhase?.(timing);
  };
  async function bounded<T>(
    deadline: number,
    operation: (remaining: () => number, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const remaining = () => Math.max(1, deadline - now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      if (now() >= deadline) throw new Error('phase budget exhausted');
      if (options.signal?.aborted) throw new DOMException('The dev server startup was aborted', 'AbortError');
      const aborted = options.signal
        ? new Promise<never>((_, reject) => {
            abortListener = () => {
              controller.abort();
              reject(new DOMException('The dev server startup was aborted', 'AbortError'));
            };
            options.signal!.addEventListener('abort', abortListener, { once: true });
          })
        : undefined;
      return await Promise.race([
        operation(remaining, controller.signal),
        exitFailure,
        ...(aborted ? [aborted] : []),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`phase timed out; last error: ${String(lastError)}`));
          }, remaining());
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abortListener) options.signal?.removeEventListener('abort', abortListener);
      controller.abort();
    }
  }
  try {
    await bounded(spawnedAt + budgets.ready, async () => readiness);
    record(spawnedAt);
    phase = 'first response';
    phaseStart = readyAt!;
    lastError = new Error(`no response from ${firstPath}`);
    await bounded(readyAt! + budgets.firstResponse, async (remaining, signal) => {
      for (;;) {
        try {
          const response = await fetch(`${origin}${firstPath}`, { redirect: 'manual', signal });
          await response.body?.cancel();
          if (response.status < 500) return;
          lastError = new Error(`HTTP ${response.status} for ${firstPath}`);
        } catch (error) {
          lastError = error;
          if (signal.aborted) throw error;
        }
        await Bun.sleep(Math.min(options.pollIntervalMs ?? 500, remaining()));
        if (signal.aborted) throw lastError;
      }
    });
    record(readyAt!);
    if (options.warmUpPaths.length > 0) {
      phase = 'warm-up';
      const deadline = readyAt! + budgets.warmUp;
      path = options.warmUpPaths[0]!;
      lastError = new Error('browser has not started');
      await bounded(deadline, async (remaining, signal) => {
        const launched = await chromium.launch({ timeout: remaining() });
        browser = launched;
        if (signal.aborted) {
          await launched.close();
          throw new Error('browser launch exceeded warm-up budget');
        }
        const context = await browser.newContext({
          ...options.contextOptions,
          javaScriptEnabled: options.javaScriptEnabled ?? options.contextOptions?.javaScriptEnabled ?? true,
        });
        await withCleanup(async () => {
          const page = await context.newPage();
          for (const warmUpPath of options.warmUpPaths) {
            path = warmUpPath;
            const began = now();
            lastError = new Error(`navigation to ${path} has not completed`);
            const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle', timeout: remaining() });
            if (!response || response.status() >= 500)
              throw new Error(`HTTP ${response?.status() ?? 'no response'} for ${path}`);
            if (options.javaScriptEnabled ?? options.contextOptions?.javaScriptEnabled ?? true) {
              lastError = new Error(`waiting for html[data-hydrated] on ${path}`);
              await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: remaining() });
            }
            record(began);
          }
        }, [{ label: 'dev-server warm-up context', run: () => context.close(), timeoutMs: 5000 }]);
      });
      await cleanupAll([{ label: 'dev-server warm-up browser', run: () => browser?.close(), timeoutMs: 5000 }]);
      browser = undefined;
    }
    if (options.signal?.aborted) throw new DOMException('The dev server startup was aborted', 'AbortError');
    options.signal?.addEventListener('abort', abortServer, { once: true });
    return {
      origin,
      pid: child.pid,
      shared: false,
      workerBindings,
      stop,
      diagnostics: () =>
        abortCleanupError ? `${captured()}\nCleanup error: ${String(abortCleanupError)}` : captured(),
    };
  } catch (error) {
    const elapsed = now() - phaseStart;
    const primary = new Error(
      `dev server ${phase} failed for ${path}; elapsed ${elapsed} ms; last error: ${String(error)}\nCaptured output:\n${captured()}`,
      { cause: error },
    );
    try {
      await withCleanup(async () => {
        throw primary;
      }, [{ label: 'dev-server startup cleanup', run: stop, timeoutMs: 18_000 }]);
    } catch (cleanupError) {
      if (cleanupError === primary) throw primary;
      throw cleanupError;
    }
    throw primary;
  }
}
