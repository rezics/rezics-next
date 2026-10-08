import { expect, spyOn, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import { currentWorkerTick, runWorkerTick } from '../src/worker-tick.ts';

const root = resolve(import.meta.dir, '../../..');

function idleClient(): PoolClient {
  const client = {
    release() {},
    query() {},
    on() { return client; },
    once() { return client; },
    removeListener() { return client; },
  };
  return client as unknown as PoolClient;
}

async function withMockedPool<T>(work: (pool: Pool) => Promise<T>): Promise<T> {
  const connect = spyOn(Pool.prototype, 'connect').mockImplementation((() => Promise.resolve(idleClient())) as Pool['connect']);
  const pool = boundedPool({ connectionString: 'postgres://u@127.0.0.1:1/access', max: 4, connectionTimeoutMillis: 50 });
  try { return await work(pool); }
  finally {
    connect.mockRestore();
    await pool.end();
  }
}

test('two ticks in one process context do not inherit each other\'s checkout', async () => {
  const previous = nestedPoolCheckoutMode();
  setNestedPoolCheckoutMode('throw');
  try {
    await withMockedPool(async (pool) => {
      let releaseHold: () => void = () => undefined;
      const hold = new Promise<void>((resolveHold) => { releaseHold = resolveHold; });
      const holder = runWorkerTick('holder', async () => {
        const client = await pool.connect();
        try {
          expect(currentWorkerTick()).toBe('holder');
          await hold;
        } finally { client.release(); }
      });
      await runWorkerTick('reader', async () => {
        expect(currentWorkerTick()).toBe('reader');
        const client = await pool.connect();
        client.release();
      });
      await new Promise<void>((resolveTick, rejectTick) => {
        const timer = setInterval(() => {
          clearInterval(timer);
          void runWorkerTick('interval-reader', async () => {
            const client = await pool.connect();
            client.release();
          }).then(resolveTick, rejectTick);
        }, 10);
      });
      releaseHold();
      await holder;
    });
  } finally { setNestedPoolCheckoutMode(previous); }
});

test('a tick still refuses a checkout when its caller already holds that pool', async () => {
  const previous = nestedPoolCheckoutMode();
  setNestedPoolCheckoutMode('throw');
  try {
    await withMockedPool(async (pool) => {
      const outer = await pool.connect();
      try {
        await expect(runWorkerTick('inner', () => pool.connect())).rejects.toBeInstanceOf(NestedPoolCheckoutError);
      } finally { outer.release(); }
    });
  } finally { setNestedPoolCheckoutMode(previous); }
});

test('a worker tick name is a short identifier', async () => {
  await expect(runWorkerTick('', () => undefined)).rejects.toThrow('worker tick name is invalid');
  await expect(runWorkerTick('has space', () => undefined)).rejects.toThrow('worker tick name is invalid');
});

/**
 * Worker ticks must enter `runWorkerTick`, so a pooled connection held with
 * `AsyncLocalStorage.enterWith` stays on that tick's async resource.
 *
 * The scan is narrow. It classifies scheduling primitives that start background
 * work under services/main/src, and it ignores timers that only bound a
 * deadline, abort a socket, or kill a child process:
 * - `setInterval(` is a repeating tick unless the file is allowlisted below
 * - `runMainRelay` wraps every relay iteration; callers do not wrap again
 * - `POLLERS` lists while-loops and repeating `setTimeout` ticks that are not
 *   `setInterval`. Add a new poller here.
 *
 * Template directory recovery (`modules/query/seek-index.ts`) and realm-policy
 * recovery (`modules/access/realm-management-recovery.ts`) still schedule
 * outside the wrapper. Other open tasks hold those files. services/content/src
 * has no worker scheduler.
 */
const NON_WORKER_TIMERS = new Map<string, string>([
  ['services/main/src/modules/notification/realtime.ts',
    'The LISTEN connection is retained for the process lifetime and already runs inside its own AsyncResource. The retry timer only re-enters that resource.'],
]);
const HELD_SCHEDULERS = [
  'services/main/src/modules/query/seek-index.ts',
  'services/main/src/modules/access/realm-management-recovery.ts',
];
const POLLERS = [
  'services/main/src/content-projection-worker.ts',
  'services/main/src/modules/library-import/retention-worker.ts',
  'services/main/src/modules/library-import/apply-worker.ts',
  'services/main/src/modules/progress/order-projection.ts',
  'services/main/src/modules/outbox/worker.ts',
];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

function repoPath(path: string): string {
  return relative(root, path).split('\\').join('/');
}

test('worker schedulers run their tick through the wrapper', () => {
  const held = new Set(HELD_SCHEDULERS);
  const intervals = sourceFiles(resolve(root, 'services/main/src'))
    .map(repoPath)
    .filter((file) => readFileSync(resolve(root, file), 'utf8').includes('setInterval('));
  const unclassified = intervals.filter((file) => !readFileSync(resolve(root, file), 'utf8').includes('runWorkerTick(')
    && !NON_WORKER_TIMERS.has(file) && !held.has(file));
  expect(unclassified).toEqual([]);
  for (const file of intervals) {
    if (NON_WORKER_TIMERS.has(file) || (held.has(file) && !readFileSync(resolve(root, file), 'utf8').includes('runWorkerTick('))) continue;
    expect(readFileSync(resolve(root, file), 'utf8')).toContain('runWorkerTick(');
  }
  for (const file of POLLERS) expect(readFileSync(resolve(root, file), 'utf8')).toContain('runWorkerTick(');
  const relay = readFileSync(resolve(root, 'services/main/src/modules/outbox/worker.ts'), 'utf8');
  expect(relay).toMatch(/await runWorkerTick\([\s\S]*?once\)/);
  expect(readFileSync(resolve(root, 'services/main/src/modules/event/projection.ts'), 'utf8'))
    .toContain("runWorkerTick('event-temporal-projection'");
  expect(readFileSync(resolve(root, 'services/main/src/modules/statement/publication-seek.ts'), 'utf8'))
    .toContain("runWorkerTick('statement-publication-seek'");
  const content = sourceFiles(resolve(root, 'services/content/src')).map(repoPath)
    .filter((file) => /setInterval\(|runMainRelay\(/.test(readFileSync(resolve(root, file), 'utf8')));
  expect(content).toEqual([]);
  for (const file of HELD_SCHEDULERS) expect(readFileSync(resolve(root, file), 'utf8').length).toBeGreaterThan(0);
});
