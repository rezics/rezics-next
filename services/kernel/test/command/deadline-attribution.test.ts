import { afterAll, expect, spyOn, test } from 'bun:test';
import { releaseDigest, validateRelease } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  CommandUnavailableError,
  DEFAULT_REQUEST_DEADLINE_MS,
  noEffect,
  runCommand,
} from '../../src/command/command.ts';
import { enterCommandGate } from '../../src/command/gate.ts';
import { commandTimingSnapshot, withCommandTiming } from '../../src/command/timing.ts';
import { createPool } from '../../src/database/pool.ts';
import { createApp } from '../../src/http/app.ts';
import { publishRelease } from '../../src/semantic/definitions.ts';
import { observeSql } from '../content/support/sql-observer.ts';
import { closeCommunityDrivers, createCommunityDriver, restartWorker, worker } from '../community/community-driver.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
let poolClosed = false;
afterAll(async () => {
  await closeCommunityDrivers();
  if (!poolClosed) await pool.end();
});
const detail = {
  operationId: 'deadline.probe',
  'x-action': 'probe:read',
  'x-exposure': 'public',
  security: [{ bearerAuth: [] }, {}],
};
function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async wait() {
      enter();
      await released;
    },
  };
}

test('a deadline response attributes a deliberately held Access phase, once and without request contents', async () => {
  await pool.query('SELECT 1');
  const held = barrier();
  const app = createApp({ pool, requestDeadlineMs: 30_000 }).post('/probe/:id', { detail }, async () => {
    await runCommand(
      pool,
      {
        partition: 0,
        authorization: {
          action: 'probe:read',
          resource: { route: 0, id: '00000000-0000-8000-8000-000000000000' },
          denied: () => new Error('denied'),
          async prepare() {
            await held.wait();
            throw new CommandUnavailableError('deadline', 0);
          },
          async authorize() {
            return 'execute';
          },
        },
      },
      async () => noEffect(true),
    );
  });
  const lines: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((line) => {
    lines.push(String(line));
  });
  const started = performance.now();
  try {
    const pending = app.handle(
      new Request('http://localhost/probe/private?secret=query-secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-secret': 'header-secret' },
        body: JSON.stringify({ secret: 'body-secret' }),
      }),
    );
    await held.entered;
    // The barrier controls the phase; its duration exceeds all preceding request work even on a loaded host.
    await Bun.sleep(Math.max(100, performance.now() - started + 100));
    held.release();
    const response = await pending;
    const elapsed = performance.now() - started;
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.code).toBe('deadline_exceeded');
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({
      event: 'deadline_exceeded',
      request_id: body.request_id,
      method: 'POST',
      route: '/probe/:id',
      dominant_phase: 'access_prepare',
      contention_retries: 0,
    });
    expect(Math.abs(line.elapsed_ms - elapsed)).toBeLessThan(50);
    expect(
      Math.abs(Object.values(line.phases_ms as Record<string, number>).reduce((a, b) => a + b, 0) - line.elapsed_ms),
    ).toBeLessThan(0.01);
    for (const phase of [
      'before_command',
      'time_mint',
      'access_prepare',
      'gate_wait',
      'transaction_pool_wait',
      'transaction_body',
      'commit',
      'writable_wait',
      'contention_pause',
      'command_overhead',
      'request_completion',
    ])
      expect(line.phases_ms[phase]).toBeGreaterThanOrEqual(0);
    expect(lines[0]).not.toMatch(/body-secret|header-secret|query-secret|private/);
  } finally {
    held.release();
    spy.mockRestore();
  }
});

test('a real gate deadline is attributed to the gate without retaining a transaction', async () => {
  const gate = await enterCommandGate(pool, 0, Date.now() + 30_000);
  if (gate.status !== 'acquired') throw new Error('Expected held gate');
  const app = createApp({ pool, requestDeadlineMs: 500 }).get('/gate', { detail }, async () => {
    await runCommand(pool, { partition: 0 }, async () => noEffect(true));
  });
  const lines: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((line) => {
    lines.push(String(line));
  });
  try {
    const response = await app.handle(new Request('http://localhost/gate'));
    expect(response.status).toBe(503);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ dominant_phase: 'gate_wait' });
  } finally {
    gate.release();
    spy.mockRestore();
  }
});

test('contention retry pauses are summed and counted on the eventual deadline line', async () => {
  let attempts = 0;
  const app = createApp({ pool, requestDeadlineMs: 30_000 }).get('/retry', { detail }, async () => {
    await runCommand(pool, { partition: 0 }, async () => {
      attempts++;
      if (attempts <= 3)
        throw Object.assign(new Error('conflict'), { code: ['40001', '40P01', '55P03'][attempts - 1] });
      throw new CommandUnavailableError('deadline', 0);
    });
  });
  const lines: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((line) => {
    lines.push(String(line));
  });
  const jitter = spyOn(Math, 'random').mockReturnValue(0.999);
  try {
    const response = await app.handle(new Request('http://localhost/retry'));
    expect(response.status).toBe(503);
    expect(attempts).toBe(4);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line.contention_retries).toBe(3);
    // Three pauses of approximately 5, 10 and 20 ms must accumulate; the last alone is insufficient.
    expect(line.phases_ms.contention_pause).toBeGreaterThanOrEqual(30);
  } finally {
    jitter.mockRestore();
    spy.mockRestore();
  }
});

test('a successful bundled publish adds no log or SQL statements and leaves the production deadline unchanged', async () => {
  const observer = observeSql(pool);
  const lines: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((line) => {
    lines.push(String(line));
  });
  const publish = () =>
    publishRelease(pool, {
      actor: {
        kind: 'account',
        accountId: '10000000-0000-4000-8000-000000000001',
        clientId: 'probe',
        authnEpoch: 0,
        requestedBy: null,
        scopes: [],
      },
      idempotencyKey: crypto.randomUUID(),
      digest: Buffer.alloc(32, 1),
      authorize: async () => true,
      release: bundledRelease,
      deadline: Date.now() + 30_000,
    });
  try {
    expect(DEFAULT_REQUEST_DEADLINE_MS).toBe(2000);
    // Warm Reylo's first-use schema validation equally before both measured executions.
    await publish();
    const start = observer.records.length;
    await publish();
    const baseline = observer.records
      .slice(start)
      .map(({ statement }) => statement.replace(/statement_timeout = '\d+ms'/g, "statement_timeout = '<budget>ms'"));
    const offset = observer.records.length;
    await withCommandTiming(publish);
    expect(
      observer.records
        .slice(offset)
        .map(({ statement }) => statement.replace(/statement_timeout = '\d+ms'/g, "statement_timeout = '<budget>ms'")),
    ).toEqual(baseline);
    expect(lines).toEqual([]);
  } finally {
    spy.mockRestore();
    await observer.close();
  }
});

test('production bundled publish phase distributions with the fixture worker quiet and running', async () => {
  // Fixture cloning needs the migrated source database to have no live clients.
  await pool.end();
  poolClosed = true;
  // Measure synchronous work before fixture setup, so even a setup deadline retains its CPU evidence.
  for (let index = 0; index < 20; index++) {
    const started = performance.now();
    const cpu = process.cpuUsage();
    const violations = validateRelease(bundledRelease);
    const validated = performance.now();
    const digest = releaseDigest(bundledRelease);
    const ended = performance.now();
    const used = process.cpuUsage(cpu);
    console.log(
      JSON.stringify({
        event: 'release_own_work',
        index,
        validation_ms: validated - started,
        digest_ms: ended - validated,
        elapsed_ms: ended - started,
        cpu_ms: (used.user + used.system) / 1000,
        violation_count: violations.length,
      }),
    );
    expect(violations).toEqual([]);
    expect(digest).toMatch(/^sha256:/);
  }
  const driver = await createCommunityDriver();
  const fixture = await driver.provision();
  await driver.settle();
  await worker.stop();
  try {
    for (const load of ['quiet', 'worker'] as const) {
      if (load === 'worker') await restartWorker();
      const samples: NonNullable<ReturnType<typeof commandTimingSnapshot>>[] = [];
      for (let index = 0; index < 20; index++) {
        await withCommandTiming(async () => {
          const response = await driver.request({
            actor: fixture.subjectOwner,
            method: 'POST',
            path: '/v1/definitions/releases',
            key: JSON.stringify(crypto.randomUUID()),
            body: { release: bundledRelease },
          });
          const timing = commandTimingSnapshot()!;
          const body = await response.json();
          console.log(
            JSON.stringify({
              event: 'publish_measurement',
              load,
              index,
              status: response.status,
              code: body.code,
              ...timing,
            }),
          );
          expect([201, 200, 503]).toContain(response.status);
          if (response.status === 503) expect(body.code).toBe('deadline_exceeded');
          else samples.push(timing);
        });
      }
      expect(samples.length).toBeGreaterThan(0);
      const percentile = (values: number[], p: number) =>
        values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1];
      const distribution = Object.fromEntries(
        Object.keys(samples[0]!.phases_ms).map((phase) => {
          const values = samples.map((sample) => sample.phases_ms[phase as keyof typeof sample.phases_ms]);
          return [phase, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }];
        }),
      );
      console.log(
        JSON.stringify({ event: 'publish_distribution', load, successes: samples.length, phases_ms: distribution }),
      );
    }
  } finally {
    await closeCommunityDrivers();
  }
}, 180_000);
