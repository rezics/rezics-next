import { expect, test } from 'bun:test';
import { logWorkerFault, telemetryLog } from './log.ts';

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

function capture(write: () => void): string[] {
  const lines: string[] = [];
  const previous = { error: console.error, warn: console.warn, info: console.info };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { write(); }
  finally {
    console.error = previous.error;
    console.warn = previous.warn;
    console.info = previous.info;
  }
  return lines;
}

test('a worker fault records the error class and code and omits the message', () => {
  const agent = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
  const error = new DatabaseError(
    `duplicate key for reader@example.com ${agent}`,
    '23505',
    `Key (agent)=(${agent})`,
  );
  const [line] = capture(() => logWorkerFault('main.library.backfill', error));
  expect(JSON.parse(line!)).toEqual({
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

test('a wrapped database failure keeps the outer class and the provider code', () => {
  const cause = Object.assign(new Error('provider connection lost'), { code: '08006' });
  const error = new RecommendationUnavailable('Access owner is unavailable', { cause });
  const [line] = capture(() => logWorkerFault('main.ranking.build', error));
  expect(JSON.parse(line!)).toMatchObject({
    event: 'worker_fault',
    'rezics.worker.name': 'main.ranking.build',
    'error.class': 'RecommendationUnavailable',
    'error.code': '08006',
  });
  expect(line).not.toContain('provider connection lost');
  expect(line).not.toContain('Access owner is unavailable');
});

test('a library backfill event carries counts and durations only', () => {
  const agent = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000bb';
  const [line] = capture(() => telemetryLog('library_backfill', 'warn', {
    'rezics.backfill.examined': 4,
    'rezics.backfill.skipped': 1,
    'rezics.backfill.duration_ms': 25,
    agent,
    message: "VALUES ('reader@example.com')",
  }));
  expect(JSON.parse(line!)).toEqual({
    level: 'warn',
    event: 'library_backfill',
    'rezics.backfill.examined': 4,
    'rezics.backfill.skipped': 1,
    'rezics.backfill.duration_ms': 25,
  });
});

test('a nested checkout fault keeps bounded caller locations and drops query text', () => {
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
  const [line, dropped] = capture(() => {
    logWorkerFault('main.database.nested-checkout', error);
    logWorkerFault('main.database.nested-checkout', leaked);
  });
  expect(JSON.parse(line!)).toEqual({
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
  expect(JSON.parse(dropped!)).toEqual({
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

test('an unbounded class, code, or count is omitted', () => {
  const [line] = capture(() => telemetryLog('worker_fault', 'error', {
    'error.class': 'reader@example.com',
    'error.code': 'duplicate key value',
    'rezics.backfill.examined': Number.NaN,
    'rezics.worker.name': 'https://rezics.com/id/00000000-0000-4000-8000-0000000000cc',
  }));
  expect(JSON.parse(line!)).toEqual({ level: 'error', event: 'worker_fault' });
});
