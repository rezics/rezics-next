import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions } from 'playwright';

// Render budgets start at Vite's ready line, independently of its startup budget.
const phaseBudgets = { ready: 150_000, firstResponse: 120_000, warmUp: 120_000 };
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
  budgets?: Partial<typeof phaseBudgets>;
  pollIntervalMs?: number;
  onPhase?: (timing: PhaseTiming) => void;
  /** A clock seam for deterministic budget tests; timers still use the remaining phase budget. */
  now?: () => number;
};

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

/** One process group and one warm-up for each browser test file. Always await stop() in afterAll. */
export async function startDevServer(
  options: DevServerOptions,
): Promise<{ origin: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
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
  let output = '';
  let phase: Phase = 'ready';
  let path = firstPath;
  let phaseStart = spawnedAt;
  let lastError: unknown = new Error('Vite ready line has not been printed');
  let browser: Browser | undefined;
  let stopped: Promise<void> | undefined;
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    child = Bun.spawn(command, {
      cwd: options.cwd ?? join(import.meta.dir, '../..'),
      env: { ...process.env, ...options.env },
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    throw new Error(
      `dev server ready failed for ${path}; elapsed ${now() - spawnedAt} ms; last error: ${String(error)}\nCaptured output:\n${output}`,
    );
  }
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const keep = (chunk: Uint8Array) => {
    const combined = output + Buffer.from(chunk).toString();
    output = combined.slice(-8000);
    if (
      readyAt === undefined &&
      /\bVITE\s+v\S+\s+ready in\s+[\d.]+\s*(?:ms|s)\b/i.test(combined.replace(/\x1b\[[0-9;]*m/g, ''))
    ) {
      readyAt = now();
      ready();
    }
  };
  async function capture(stream: ReadableStream<Uint8Array>) {
    try {
      for await (const chunk of stream) keep(chunk);
    } catch (error) {
      keep(Buffer.from(`\nOutput capture error: ${String(error)}\n`));
    }
  }
  const captured = Promise.all([capture(child.stdout), capture(child.stderr)]);
  // Native Bun process completion does not wait for inherited output pipes to close.
  const exited = child.exited.then((code) => new Error(`dev server exited with ${code}`));
  const exitFailure = exited.then((error) => {
    throw error;
  });
  // The server can exit between phases, when no race is attached yet.
  void exitFailure.catch(() => {});

  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const stop = () =>
    (stopped ??= (async () => {
      let browserError: unknown;
      try {
        await browser?.close();
      } catch (error) {
        browserError = error;
      }
      signalGroup('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        // A leader may exit while a descendant still owns a listener or ignores SIGTERM.
        signalGroup('SIGKILL');
        await exited;
        await captured;
      }
      if (browserError) throw browserError;
    })());

  const record = (started: number) => {
    const timing = { phase, path, elapsedMs: now() - started };
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
    try {
      if (now() >= deadline) throw new Error('phase budget exhausted');
      return await Promise.race([
        operation(remaining, controller.signal),
        exitFailure,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`phase timed out; last error: ${String(lastError)}`));
          }, remaining());
        }),
      ]);
    } finally {
      clearTimeout(timer);
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
        try {
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
        } finally {
          await context.close();
        }
      });
      await browser?.close();
      browser = undefined;
    }
    return { origin, stop };
  } catch (error) {
    const elapsed = now() - phaseStart;
    let cleanup = '';
    try {
      await stop();
    } catch (cleanupError) {
      cleanup = `\nCleanup error: ${String(cleanupError)}`;
    }
    throw new Error(
      `dev server ${phase} failed for ${path}; elapsed ${elapsed} ms; last error: ${String(error)}\nCaptured output:\n${output}${cleanup}`,
    );
  }
}
