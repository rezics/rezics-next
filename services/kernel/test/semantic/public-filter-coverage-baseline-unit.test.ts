import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  adoptPublicFilterCoverageBaseline,
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
function receiver(onConnect = () => {}, onCommit = () => {}) {
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
          if (sql.startsWith('SELECT epoch,write_state')) rows = [{ epoch: 3, write_state: 'active' }];
          else if (sql.startsWith('SELECT write_state')) rows = [{ write_state: 'active' }];
          else if (sql.includes('SELECT consumer,state,coverage_generation'))
            rows = [{ consumer: original.binding.consumer, state: 'active', coverage_generation: '1' }];
          else if (sql.startsWith('SELECT receipt FROM semantic.public_filter_home_enrollment'))
            rows = [{ receipt: original.enrollment.receipt }];
          else if (sql.startsWith('SELECT definition::text,consumer,generation::text'))
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
  const result = await adoptPublicFilterCoverageBaseline(r.pool, binding, enrollment, Date.now() + 60_000);
  const root = hash(['b'.repeat(64), 2, original.enrollment.receipt]);
  expect(result).toEqual({ after: 3, root, generation: 1n });
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
      adoptPublicFilterCoverageBaseline(r.pool, f.binding, f.enrollment, Date.now() + 60_000),
    ).rejects.toBeInstanceOf(TypeError);
    expect(r.counts()).toEqual({ connections: 0, releases: 0 });
  }
  expect(evaluated).toBe(0);
});
