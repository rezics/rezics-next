import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { context, propagation, trace } from '@opentelemetry/api';
import { httpTelemetry } from './elysia.ts';
import { logWorkerFault, telemetryLog } from './log.ts';
import { telemetryEnabled } from './runtime.ts';

class DatabaseError extends Error {
  constructor(message: string, readonly code: string, readonly detail: string) {
    super(message);
    this.name = 'error';
  }
}

class RecommendationUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

async function capture(write: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const previous = { error: console.error, warn: console.warn, info: console.info };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await write(); }
  finally {
    console.error = previous.error;
    console.warn = previous.warn;
    console.info = previous.info;
  }
  return lines;
}

/** `time` is generated at the call. The rest of the line is what the event decided. */
function logged(line: string): Record<string, unknown> {
  const value = JSON.parse(line) as Record<string, unknown>;
  expect(value.time).toBe(new Date(String(value.time)).toISOString());
  const { time: _time, ...rest } = value;
  return rest;
}

test('a worker fault records the error class and code and omits the message', async () => {
  const agent = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
  const error = new DatabaseError(
    `duplicate key for reader@example.com ${agent}`,
    '23505',
    `Key (agent)=(${agent})`,
  );
  const [line] = await capture(() => logWorkerFault('main.library.backfill', error));
  expect(logged(line!)).toEqual({
    level: 'error',
    event: 'worker_fault',
    'rezics.worker.name': 'main.library.backfill',
    'error.class': 'DatabaseError',
    'error.code': '23505',
  });
  expect(line).not.toContain('reader@example.com');
  expect(line).not.toContain(agent);
  expect(line).not.toContain('Key (agent)');
});

test('a wrapped database failure keeps the outer class and the provider code', async () => {
  const cause = Object.assign(new Error('provider connection lost'), { code: '08006' });
  const error = new RecommendationUnavailable('Access owner is unavailable', { cause });
  const [line] = await capture(() => logWorkerFault('main.ranking.build', error));
  expect(logged(line!)).toMatchObject({
    event: 'worker_fault',
    'rezics.worker.name': 'main.ranking.build',
    'error.class': 'RecommendationUnavailable',
    'error.code': '08006',
  });
  expect(line).not.toContain('provider connection lost');
  expect(line).not.toContain('Access owner is unavailable');
});

test('a library backfill event carries counts and durations only', async () => {
  const agent = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000bb';
  const [line] = await capture(() => telemetryLog('library_backfill', 'warn', {
    'rezics.backfill.examined': 4,
    'rezics.backfill.skipped': 1,
    'rezics.backfill.duration_ms': 25,
    agent,
    message: "VALUES ('reader@example.com')",
  }));
  expect(logged(line!)).toEqual({
    level: 'warn',
    event: 'library_backfill',
    'rezics.backfill.examined': 4,
    'rezics.backfill.skipped': 1,
    'rezics.backfill.duration_ms': 25,
  });
});

test('a nested checkout fault keeps bounded caller locations and drops query text', async () => {
  class NestedPoolCheckoutError extends Error {
    constructor(fields: {
      outers?: readonly string[];
      inner?: string;
      pool?: string;
      repeats?: number;
    }) {
      super('Nested PostgreSQL pool checkout');
      this.name = 'NestedPoolCheckoutError';
      Object.assign(this, fields);
    }
  }
  const secret = "SELECT 'reader@example.com' FROM reader";
  const error = new NestedPoolCheckoutError({
    outers: [
      'services/main/src/infrastructure/pg-pool.test.ts:80 outerCheckout',
      secret,
      'services/main/src/caller.ts:2',
      'services/main/src/caller.ts:3',
      'services/main/src/caller.ts:4',
    ],
    inner: 'services/main/tests/nested-pool-checkout.test.ts:310',
    pool: 'access',
    repeats: 2,
  });
  const leaked = new NestedPoolCheckoutError({
    inner: secret,
    pool: 'postgres://user:secret@db/access',
    repeats: 0,
  });
  const [line, dropped] = await capture(() => {
    logWorkerFault('main.database.nested-checkout', error);
    logWorkerFault('main.database.nested-checkout', leaked);
  });
  expect(logged(line!)).toEqual({
    level: 'error',
    event: 'worker_fault',
    'rezics.worker.name': 'main.database.nested-checkout',
    'error.class': 'NestedPoolCheckoutError',
    'rezics.checkout.outer': [
      'services/main/src/infrastructure/pg-pool.test.ts:80 outerCheckout',
      'services/main/src/caller.ts:2',
      'services/main/src/caller.ts:3',
    ],
    'rezics.checkout.inner': 'services/main/tests/nested-pool-checkout.test.ts:310',
    'rezics.checkout.pool': 'access',
    'rezics.checkout.repeats': 2,
  });
  expect(logged(dropped!)).toEqual({
    level: 'error',
    event: 'worker_fault',
    'rezics.worker.name': 'main.database.nested-checkout',
    'error.class': 'NestedPoolCheckoutError',
  });
  expect(line).not.toContain('SELECT');
  expect(line).not.toContain('reader@example.com');
  expect(dropped).not.toContain('secret');
  expect(dropped).not.toContain('SELECT');
});

test('an unbounded class, code, or count is omitted', async () => {
  const [line] = await capture(() => telemetryLog('worker_fault', 'error', {
    'error.class': 'reader@example.com',
    'error.code': 'duplicate key value',
    'rezics.backfill.examined': Number.NaN,
    'rezics.worker.name': 'https://rezics.com/id/00000000-0000-4000-8000-0000000000cc',
  }));
  expect(logged(line!)).toEqual({ level: 'error', event: 'worker_fault' });
});

test('a line logged inside a request carries that request trace id without an exporter', async () => {
  expect(telemetryEnabled()).toBe(false);
  const ids = ['0123456789abcdef0123456789abcdef', 'fedcba9876543210fedcba9876543210'];
  const app = new Elysia()
    .use(httpTelemetry())
    .get('/fault/:n', () => {
      logWorkerFault('main.database.nested-checkout', new Error('composition unavailable'));
      return 'ok';
    })
    .listen({ hostname: '127.0.0.1', port: 0 });
  try {
    const lines = await capture(async () => {
      await Promise.all(ids.map(async (id) => {
        const response = await fetch(`${app.server!.url.origin}/fault/${id}`, {
          headers: { traceparent: `00-${id}-0123456789abcdef-01` },
        });
        expect(response.status).toBe(200);
        await response.text();
      }));
    });
    const faults = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(faults.map((item) => item.trace_id).sort()).toEqual([...ids].sort());
    for (const fault of faults) {
      expect(fault.time).toBe(new Date(String(fault.time)).toISOString());
      expect(fault.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(fault).toMatchObject({
        level: 'error',
        event: 'worker_fault',
        'rezics.worker.name': 'main.database.nested-checkout',
        'error.class': 'Error',
      });
      expect(JSON.stringify(fault)).not.toContain('composition unavailable');
    }
  } finally {
    await app.stop();
    if (!telemetryEnabled()) {
      context.disable();
      propagation.disable();
      trace.disable();
    }
  }
});
