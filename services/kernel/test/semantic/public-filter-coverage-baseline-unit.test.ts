import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { planPublicFilterEnrollment } from '../../src/semantic/public-filter-preparation-budget.ts';
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
function receiver(onConnect = () => {}, onCommit = () => {}, originals = [{ partition: 2, valid: true }]) {
  const original = fixture();
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let held = false,
    connections = 0,
    releases = 0,
    commits = 0;
  const pool = {
    async connect() {
      if (held) throw new Error('A native owner checkout is still held');
      held = true;
      connections++;
      onConnect();
      return {
        release() {
          held = false;
          releases++;
        },
        async query(sql: string, values: readonly unknown[] = []) {
          calls.push({ sql, values: [...values] });
          if (sql === 'COMMIT' && ++commits === 1) onCommit();
          let rows: unknown[] = [];
          if (sql.includes('FROM jsonb_to_recordset')) rows = originals;
          else if (sql.includes('SELECT write_state')) rows = [{ write_state: 'active' }];
          else if (sql.includes('SELECT consumer,state,coverage_generation'))
            rows = [{ consumer: original.binding.consumer, state: 'active', coverage_generation: '1' }];
          else if (sql.includes('SELECT definition::text,consumer,generation::text'))
            rows = [
              {
                definition: original.binding.definition,
                consumer: original.binding.consumer,
                generation: '1',
                after_home: 2,
                root: 'b'.repeat(64),
              },
            ];
          return { rows, rowCount: 1 };
        },
      };
    },
  } as unknown as Pool;
  return { pool, calls, counts: () => ({ connections, releases }) };
}

test('owner verification and receiver adoption consume the original tuple after caller mutation', async () => {
  const { binding, enrollment } = fixture();
  const original = fixture();
  const r = receiver(undefined, () => {
    Object.assign(binding, { bootstrap: 'changed', definition: 'changed', consumer: 'changed', accounts: false });
    Object.assign(binding.registration, { partition: 4, id: 'changed' });
    Object.assign(enrollment, { partition: 9, epoch: 10, sourcePosition: 99n, receipt: 'changed' });
  });
  const adopted: unknown[] = [];
  await adoptPublicFilterCoverageBaselinePage(
    r.pool,
    binding,
    [enrollment],
    Date.now() + 60_000,
    async (client, result) => {
      expect(typeof client.query).toBe('function');
      adopted.push(result);
    },
  );
  const root = hash(['b'.repeat(64), 2, original.enrollment.receipt]);
  expect(adopted).toEqual([{ after: 3, root, generation: 1n }]);
  expect(r.calls.find(({ sql }) => sql.includes('INSERT INTO search.public_filter_coverage_baseline'))?.values).toEqual(
    [
      0,
      original.binding.registration.id,
      original.binding.bootstrap,
      2,
      3,
      '6',
      '7',
      '8',
      '4',
      '5',
      original.enrollment.receipt,
      'b'.repeat(64),
      root,
    ],
  );
  expect(r.calls.find(({ sql }) => sql.includes('INSERT INTO search.public_filter_coverage_home'))?.sql).toContain(
    '0,true,$9',
  );
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
      adoptPublicFilterCoverageBaselinePage(r.pool, f.binding, [f.enrollment], Date.now() + 60_000, async () => {}),
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
  const advanced: number[] = [];
  await adoptPublicFilterCoverageBaselinePage(
    r.pool,
    binding,
    enrollments,
    Date.now() + 60_000,
    async (_, adoption) => {
      advanced.push(adoption.after);
    },
  );
  expect(advanced).toEqual([3]);
  expect(r.counts()).toEqual({ connections: 2, releases: 2 });
});

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
