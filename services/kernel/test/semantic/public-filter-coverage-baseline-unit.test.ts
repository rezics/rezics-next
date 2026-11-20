import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { planPublicFilterEnrollment } from '../../src/semantic/public-filter-preparation-budget.ts';
import { CommandUnavailableError } from '../../src/access/unavailable.ts';
import type { Pool } from 'pg';
import {
  adoptPublicFilterCoverageBaselinePage,
  beginPublicFilterCoverageBaseline,
} from '../../src/semantic/public-filter-coverage-baseline.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const binding = {
    bootstrap: '00000000-0000-4000-8000-000000000001',
    registration: { partition: 0, id: 'original-registration' },
    definition: '00000000-0000-4000-8000-000000000002',
    consumer: 'original-consumer',
    accounts: true,
  };
  const enrollment = {
    partition: 2,
    epoch: 3,
    revision: 4n,
    claimRevision: 5n,
    sourcePosition: 6n,
    creationPosition: 7n,
    enqueueRevision: 8n,
    keyDigest: 'a'.repeat(64),
    receipt: '',
    complete: true,
  };
  enrollment.receipt = hash([
    2,
    binding.bootstrap,
    0,
    binding.registration.id,
    binding.definition,
    3,
    '6',
    '7',
    '8',
    '4',
    '5',
    enrollment.keyDigest,
  ]);
  return { binding, enrollment };
}

// Transaction-boundary double, not native coverage or funding proof. It refuses
// overlapping checkouts and mutates inputs at the real owner/receiver boundary.
function receiver(
  onConnect = () => {},
  onCommit: (number: number) => void = () => {},
  originals = [{ partition: 2, valid: true }],
  onQuery: (sql: string) => void = () => {},
) {
  const original = fixture();
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let held = false,
    connections = 0,
    releases = 0,
    commits = 0;
  const releaseErrors: unknown[] = [];
  const pool = {
    async connect() {
      if (held) throw new Error('A native owner checkout is still held');
      held = true;
      connections++;
      onConnect();
      return {
        release(error?: Error) {
          held = false;
          releases++;
          if (error) releaseErrors.push(error);
        },
        async query(input: string | { text: string; values?: readonly unknown[] }, values: readonly unknown[] = []) {
          const sql = typeof input === 'string' ? input : input.text;
          if (typeof input !== 'string') values = input.values ?? [];
          calls.push({ sql, values: [...values] });
          onQuery(sql);
          if (sql === 'COMMIT') onCommit(++commits);
          let rows: unknown[] = [];
          if (sql.includes('FROM jsonb_to_recordset')) rows = originals;
          else if (sql.includes('SELECT write_state')) rows = [{ write_state: 'active' }];
          else if (sql.includes('SELECT consumer,state,coverage_generation'))
            rows = [{ consumer: original.binding.consumer, state: 'active', coverage_generation: '1' }];
          else if (sql.includes('SELECT definition::text,consumer,generation::text'))
            rows = [{ definition: original.binding.definition, consumer: original.binding.consumer, generation: '1' }];
          return { rows, rowCount: 1 };
        },
      };
    },
  } as unknown as Pool;
  return { pool, calls, releaseErrors, counts: () => ({ connections, releases }) };
}

test('owner verification and receiver adoption consume the original tuple after caller mutation', async () => {
  const { binding, enrollment } = fixture();
  const original = fixture();
  const r = receiver(undefined, (number) => {
    if (number !== 1) return;
    Object.assign(binding, { bootstrap: 'changed', definition: 'changed', consumer: 'changed', accounts: false });
    Object.assign(binding.registration, { partition: 4, id: 'changed' });
    Object.assign(enrollment, { partition: 9, epoch: 10, sourcePosition: 99n, receipt: 'changed' });
  });
  await adoptPublicFilterCoverageBaselinePage(r.pool, binding, [enrollment], Date.now() + 60_000);
  const pages = r.calls.filter(({ sql }) => sql.includes('semantic.adopt_public_filter_baseline_page'));
  expect(pages).toHaveLength(1);
  expect(pages[0]?.values).toEqual([
    original.binding.registration.id,
    original.binding.bootstrap,
    original.binding.definition,
    original.binding.consumer,
    true,
    JSON.stringify([
      {
        partition: 2,
        epoch: 3,
        source_position: '6',
        creation_position: '7',
        enqueue_revision: '8',
        revision: '4',
        claim_revision: '5',
        receipt: original.enrollment.receipt,
      },
    ]),
  ]);
  expect(r.counts()).toEqual({ connections: 2, releases: 2 });
});

test('generation pinning snapshots the nested registration before checkout', async () => {
  const { binding } = fixture(),
    original = fixture().binding;
  const r = receiver(() => {
    binding.registration.id = 'changed';
    binding.consumer = 'changed';
  });
  expect(await beginPublicFilterCoverageBaseline(r.pool, binding, Date.now() + 60_000)).toBe(1n);
  expect(
    r.calls.find(({ sql }) => sql.includes('INSERT INTO search.public_filter_coverage_preparation'))?.values,
  ).toEqual([
    0,
    original.registration.id,
    original.bootstrap,
    original.definition,
    original.consumer,
    '1',
    hash([original.registration, original.bootstrap, original.definition, original.consumer]),
  ]);
  expect(r.counts()).toEqual({ connections: 1, releases: 1 });
});

test('accessors, proxy registrations and coercible positions refuse before any checkout', async () => {
  let evaluated = 0;
  const cases = [
    () => {
      const f = fixture();
      Object.defineProperty(f.enrollment, 'receipt', {
        get() {
          evaluated++;
          return '';
        },
      });
      return f;
    },
    () => {
      const f = fixture();
      f.binding.registration = new Proxy(f.binding.registration, {
        get() {
          evaluated++;
          return 0;
        },
      });
      return f;
    },
    () => {
      const f = fixture();
      Object.assign(f.enrollment, {
        sourcePosition: {
          toString() {
            evaluated++;
            return '6';
          },
        },
      });
      return f;
    },
  ];
  for (const make of cases) {
    const f = make(),
      r = receiver();
    await expect(
      adoptPublicFilterCoverageBaselinePage(r.pool, f.binding, [f.enrollment], Date.now() + 60_000),
    ).rejects.toBeInstanceOf(TypeError);
    expect(r.counts()).toEqual({ connections: 0, releases: 0 });
  }
  expect(evaluated).toBe(0);
});

test('a missing original stops the page at its last verified home', async () => {
  const { binding, enrollment } = fixture();
  const enrollments = [
    enrollment,
    ...[3, 4].map((partition) => ({
      ...enrollment,
      partition,
      receipt: hash([
        partition,
        binding.bootstrap,
        0,
        binding.registration.id,
        binding.definition,
        3,
        '6',
        '7',
        '8',
        '4',
        '5',
        enrollment.keyDigest,
      ]),
    })),
  ];
  const r = receiver(undefined, undefined, [
    { partition: 2, valid: true },
    { partition: 4, valid: true },
  ]);
  const read = () => Promise.reject(new Error('A partial prefix requires an independent read'));
  expect(
    await adoptPublicFilterCoverageBaselinePage(r.pool, binding, enrollments, Date.now() + 60_000, read),
  ).toBeUndefined();
  const pages = r.calls.filter(({ sql }) => sql.includes('semantic.adopt_public_filter_baseline_page'));
  expect(pages).toHaveLength(1);
  const submitted = JSON.parse(pages[0]?.values[5] as string);
  expect(submitted.map(({ partition }: { partition: number }) => partition)).toEqual([2]);
  expect(r.counts()).toEqual({ connections: 1, releases: 1 });
});

test('the cold page commits verification before registration and reads the committed frontier', async () => {
  const { binding, enrollment } = fixture();
  const r = receiver();
  await adoptPublicFilterCoverageBaselinePage(r.pool, binding, [enrollment], Date.now() + 60_000, (client) =>
    client.query('SELECT committed_frontier'),
  );
  expect(
    r.calls
      .map(({ sql }) => sql.match(/FROM jsonb_to_recordset|FOR UPDATE|adopt_public_filter_baseline_page/)?.[0] ?? sql)
      .filter((sql) => !sql.startsWith('SET LOCAL') && !sql.includes('SELECT write_state')),
  ).toEqual([
    'BEGIN',
    'FROM jsonb_to_recordset',
    'COMMIT',
    'BEGIN',
    'FOR UPDATE',
    'adopt_public_filter_baseline_page',
    'COMMIT',
    'SELECT committed_frontier',
  ]);
  expect(r.counts()).toEqual({ connections: 1, releases: 1 });
});

test.each(['contention', 'lost acknowledgement', 'deadline'])(
  'cold page relinquishes checkout on %s',
  async (fault) => {
    const { binding, enrollment } = fixture();
    const failure = new CommandUnavailableError('contention', 0);
    const r = receiver(
      undefined,
      (number) => {
        if (fault === 'lost acknowledgement' && number === 2) throw failure;
      },
      undefined,
      (sql) => {
        if (!sql.includes('FOR UPDATE')) return;
        if (fault === 'contention') throw Object.assign(failure, { code: '55P03', severity: 'ERROR' });
        if (fault === 'deadline') Bun.sleepSync(50);
      },
    );
    const read = () => Promise.reject(new Error('Failed page cannot read on its checkout'));
    await expect(
      adoptPublicFilterCoverageBaselinePage(
        r.pool,
        binding,
        [enrollment],
        Date.now() + (fault === 'deadline' ? 40 : 5_000),
        read,
      ),
    ).rejects.toMatchObject({ reason: fault === 'deadline' ? 'deadline' : 'contention' });
    expect(r.counts()).toEqual({ connections: 1, releases: 1 });
    expect(r.calls.at(-1)?.sql).toEqual(
      fault === 'lost acknowledgement'
        ? 'COMMIT'
        : fault === 'contention'
          ? 'ROLLBACK'
          : expect.stringContaining('FOR UPDATE'),
    );
    expect(r.releaseErrors).toHaveLength(fault === 'contention' ? 0 : 1);
  },
);

test('narrow and wide Source bursts stay inside the offered input budget', () => {
  // Reserve 64 owner inputs from the largest Search offer. Every default
  // Subject home enrolls the type/id, subject and unresolved keys.
  const inputBudget = 872 - 64;
  let homesLeft = 4096;
  let turns = 0;
  while (homesLeft > 0) {
    const page = planPublicFilterEnrollment({ inputBudget, keyCount: 4, homesLeft });
    expect(page.homes).toBeGreaterThan(0);
    expect(5 + page.homes * (34 + 2 * page.keyLimit)).toBeLessThanOrEqual(inputBudget);
    homesLeft -= page.homes;
    turns++;
  }
  expect(turns).toBe(216);
  const wide = planPublicFilterEnrollment({ inputBudget, keyCount: 900, homesLeft: 4096 });
  expect(wide).toEqual({ homes: 1, keyLimit: 384 });
  expect(planPublicFilterEnrollment({ inputBudget: 40, keyCount: 4, homesLeft: 1 })).toEqual({ homes: 0, keyLimit: 0 });
});
