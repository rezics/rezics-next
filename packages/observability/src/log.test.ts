import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { context, propagation, trace, type Attributes } from '@opentelemetry/api';
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

test('a worker fault records the error class and code and omits a message containing identities', async () => {
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
    'error.sqlstate': '23505',
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
    'error.sqlstate': '08006',
    'error.chain.classes': ['RecommendationUnavailable', 'Error'],
    'error.chain.codes': ['08006'],
  });
  expect(logged(line!)).toMatchObject({
    'error.message': 'Access owner is unavailable',
    'error.chain.messages': ['Access owner is unavailable', 'provider connection lost'],
  });
});

test('fault chains retain at most five levels and stop at a repeated error', async () => {
  const errors = Array.from({ length: 7 }, (_, index) => Object.assign(new Error('reader@example.com'), {
    code: `E${index}`,
  }));
  for (let index = 0; index < errors.length - 1; index++) errors[index]!.cause = errors[index + 1];
  const outer = new RecommendationUnavailable('wrapped failure', { cause: errors[0] });
  const cycle = new RecommendationUnavailable('cyclic failure', { cause: errors[0] });
  const [bounded, cyclic] = await capture(() => {
    logWorkerFault('main.route.work_read_unavailable', outer);
    errors[0]!.cause = cycle;
    logWorkerFault('main.route.work_read_unavailable', cycle);
  });
  expect(logged(bounded!)).toMatchObject({
    'error.chain.classes': ['RecommendationUnavailable', 'Error', 'Error', 'Error', 'Error'],
    'error.chain.codes': ['E0', 'E1', 'E2', 'E3'],
  });
  expect(logged(cyclic!)).toMatchObject({
    'error.chain.classes': ['RecommendationUnavailable', 'Error'], 'error.chain.codes': ['E0'],
  });
  expect(bounded).not.toContain('reader@example.com');
  expect(logged(cyclic!)['error.chain.messages']).toEqual(['cyclic failure', '[redacted]']);
});

test('fault diagnostics preserve Event source reasons and bound messages at the telemetry boundary', async () => {
  class EventSourceUnavailable extends Error {}
  const [fault, invalid, boundary] = await capture(() => {
    logWorkerFault('main.event.projection', new EventSourceUnavailable('Event retained batch members are incomplete', {
      cause: new Error('relay batch was published before its members'),
    }));
    telemetryLog('worker_fault', 'error', {
      'error.message': 'x'.repeat(513),
      'error.chain.messages': ['reader@example.com', "SELECT secret FROM accounts", 'https://private/token', 'line\nbreak'],
    });
    telemetryLog('worker_fault', 'error', {
      'error.message': 'x'.repeat(512), 'error.chain.messages': Array(7).fill('bounded cause'),
    });
  });
  expect(logged(fault!)).toMatchObject({
    'error.message': 'Event retained batch members are incomplete',
    'error.chain.messages': ['Event retained batch members are incomplete', 'relay batch was published before its members'],
  });
  expect(logged(invalid!)).toEqual({ level: 'error', event: 'worker_fault',
    'error.chain.messages': Array(4).fill('[redacted]') });
  expect(logged(boundary!)).toMatchObject({
    'error.message': 'x'.repeat(512), 'error.chain.messages': Array(5).fill('bounded cause'),
  });
});

test('a provider code beyond the fifth error level is not inspected', async () => {
  let error: Error = Object.assign(new Error('private root'), { code: 'DEEP_CODE' });
  for (let index = 0; index < 5; index++) error = new Error('private wrapper', { cause: error });
  const [line] = await capture(() => logWorkerFault('main.route.work_read_unavailable', error));
  expect(logged(line!)).toEqual({ level: 'error', event: 'worker_fault',
    'rezics.worker.name': 'main.route.work_read_unavailable', 'error.class': 'Error',
    'error.message': 'private wrapper',
    'error.chain.messages': Array(5).fill('private wrapper'),
    'error.chain.classes': ['Error', 'Error', 'Error', 'Error', 'Error'] });
});

test('fault chains omit malformed names and codes, messages, stacks and non-error payloads', async () => {
  const privateText = "VALUES ('reader@example.com')";
  const cause = Object.assign(new Error(privateText), { code: privateText, constructor: { name: privateText } });
  cause.stack = privateText;
  cause.cause = { code: 23505, message: privateText, stack: privateText, cause: new Error(privateText) };
  const [line, payload] = await capture(() => {
    logWorkerFault('main.route.work_read_unavailable', new RecommendationUnavailable(privateText, { cause }));
    logWorkerFault('main.route.work_read_unavailable', new Error(privateText, { cause: privateText }));
  });
  expect(logged(line!)).toMatchObject({
    'error.class': 'RecommendationUnavailable', 'error.code': '23505',
    'error.chain.classes': ['RecommendationUnavailable', 'Unknown', 'Unknown'], 'error.chain.codes': ['23505'],
  });
  expect(logged(payload!)).not.toHaveProperty('error.chain.classes');
  for (const output of [line!, payload!]) {
    expect(output).not.toContain(privateText);
    expect(output).not.toContain('reader@example.com');
    expect(output).not.toContain('message');
    expect(output).not.toContain('stack');
  }
});

test('caller-supplied fault chain fields are bounded and sanitized at the telemetry boundary', async () => {
  const [valid, invalid, boundary] = await capture(() => {
    telemetryLog('worker_fault', 'error', {
      'error.chain.classes': Array.from({ length: 7 }, () => 'Error'),
      'error.chain.codes': ['08006', 23505, 'E2', 'E3', 'E4', 'E5'],
    } as unknown as Attributes);
    telemetryLog('worker_fault', 'error', {
      'error.chain.classes': ['reader@example.com', 'E'.repeat(82), 'Error'],
      'error.chain.codes': ['duplicate key value', 'E'.repeat(33), Number.NaN, Number.POSITIVE_INFINITY, '23505'],
      'error.code': Number.NaN,
    } as unknown as Attributes);
    telemetryLog('worker_fault', 'error', {
      'error.chain.classes': ['E'.repeat(81)], 'error.chain.codes': ['E'.repeat(32)],
    });
  });
  expect(logged(valid!)).toEqual({ level: 'error', event: 'worker_fault',
    'error.chain.classes': ['Error', 'Error', 'Error', 'Error', 'Error'],
    'error.chain.codes': ['08006', '23505', 'E2', 'E3', 'E4'] });
  expect(logged(invalid!)).toEqual({ level: 'error', event: 'worker_fault',
    'error.chain.classes': ['Error'], 'error.chain.codes': ['23505'] });
  expect(logged(boundary!)).toEqual({ level: 'error', event: 'worker_fault',
    'error.chain.classes': ['E'.repeat(81)], 'error.chain.codes': ['E'.repeat(32)] });
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

test('relay gap diagnostics preserve exact decimal positions and the epoch, dropping invalid values', async () => {
  const [valid, invalid] = await capture(() => {
    telemetryLog('worker_fault', 'error', {
      'rezics.relay.requested_sequence': '9007199254740993',
      'rezics.projection.checkpoint_sequence': '9007199254740992',
      'rezics.relay.data_epoch': 'f978aab4-b7a4-434b-a961-9c7e8e728f3a',
    });
    telemetryLog('worker_fault', 'error', {
      'rezics.relay.requested_sequence': '0004',
      'rezics.projection.checkpoint_sequence': 3,
      'rezics.relay.data_epoch': 'reader@example.com',
    });
  });
  expect(logged(valid!)).toEqual({
    level: 'error', event: 'worker_fault',
    'rezics.relay.requested_sequence': '9007199254740993',
    'rezics.projection.checkpoint_sequence': '9007199254740992',
    'rezics.relay.data_epoch': 'f978aab4-b7a4-434b-a961-9c7e8e728f3a',
  });
  expect(logged(invalid!)).toEqual({ level: 'error', event: 'worker_fault' });
});

test('relay recovery diagnostics distinguish absent owners and retain bounded recovery state', async () => {
  const fields = {
    'rezics.relay.routing_epoch': 'routing-epoch',
    'rezics.relay.retention_floor': 'absent',
    'rezics.relay.minimum_retained_sequence': '9007199254740993',
    'rezics.relay.newest_committed_sequence': '9007199254740995',
    'rezics.relay.newest_delivered_sequence': '9007199254740994',
    'rezics.relay.acknowledged_sequence': 'unavailable',
    'rezics.relay.custody_supplied': true,
    'rezics.relay.custody_found': false,
    'rezics.projection.recovery_state': 'waiting-for-cut',
    'rezics.projection.recovery_attempts': 3,
    'rezics.projection.recovery_retry_ms': 30_000,
  };
  const [valid, invalid] = await capture(() => {
    telemetryLog('worker_fault', 'error', fields);
    telemetryLog('worker_fault', 'error', {
      'rezics.relay.routing_epoch': 'reader@example.com',
      'rezics.relay.retention_floor': '-1',
      'rezics.relay.minimum_retained_sequence': '0004',
      'rezics.relay.newest_committed_sequence': 4,
      'rezics.relay.newest_delivered_sequence': '9'.repeat(101),
      'rezics.relay.acknowledged_sequence': 'unknown owner: reader@example.com',
      'rezics.relay.custody_supplied': 'true',
      'rezics.relay.custody_found': 1,
      'rezics.projection.recovery_state': 'reader@example.com',
      'rezics.projection.recovery_attempts': -1,
      'rezics.projection.recovery_retry_ms': Number.POSITIVE_INFINITY,
    });
  });
  expect(logged(valid!)).toEqual({ level: 'error', event: 'worker_fault', ...fields });
  expect(logged(invalid!)).toEqual({ level: 'error', event: 'worker_fault' });
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
    'error.message': 'Nested PostgreSQL pool checkout',
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
    'error.message': 'Nested PostgreSQL pool checkout',
  });
  expect(line).not.toContain('SELECT');
  expect(line).not.toContain('reader@example.com');
  expect(dropped).not.toContain('secret');
  expect(dropped).not.toContain('SELECT');
});

test('a nested checkout fault names its worker tick and drops a tick that is data', async () => {
  class NestedPoolCheckoutError extends Error {
    constructor(fields: { inner?: string; tick?: string }) {
      super('Nested PostgreSQL pool checkout');
      this.name = 'NestedPoolCheckoutError';
      Object.assign(this, fields);
    }
  }
  const [named, dropped] = await capture(() => {
    logWorkerFault('main.database.nested-checkout', new NestedPoolCheckoutError({
      inner: 'services/main/src/infrastructure/pg-pool.ts:88 controlTransaction',
      tick: 'main.template.recovery',
    }));
    logWorkerFault('main.database.nested-checkout', new NestedPoolCheckoutError({
      inner: 'services/main/src/infrastructure/pg-pool.ts:88 controlTransaction',
      tick: "SELECT 'reader@example.com'",
    }));
  });
  expect(JSON.parse(named!)).toEqual({
    level: 'error',
    event: 'worker_fault',
    time: expect.any(String),
    'rezics.worker.name': 'main.database.nested-checkout',
    'error.class': 'NestedPoolCheckoutError',
    'error.message': 'Nested PostgreSQL pool checkout',
    'rezics.checkout.inner': 'services/main/src/infrastructure/pg-pool.ts:88 controlTransaction',
    'rezics.checkout.tick': 'main.template.recovery',
  });
  expect(JSON.parse(dropped!)).toEqual({
    level: 'error',
    event: 'worker_fault',
    time: expect.any(String),
    'rezics.worker.name': 'main.database.nested-checkout',
    'error.class': 'NestedPoolCheckoutError',
    'error.message': 'Nested PostgreSQL pool checkout',
    'rezics.checkout.inner': 'services/main/src/infrastructure/pg-pool.ts:88 controlTransaction',
  });
  expect(dropped).not.toContain('SELECT');
  expect(dropped).not.toContain('reader@example.com');
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
      expect(fault['error.message']).toBe('composition unavailable');
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
