import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createSubjectIndexer, type SubjectApplyGuard } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { createCoverageFixture, holdBulk } from './coverage-fixture.ts';

let f: Awaited<ReturnType<typeof createCoverageFixture>>;
beforeAll(async () => {
  f = await createCoverageFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 180_000);

async function target() {
  const [id] = await f.books(1);
  const prefix = f.fresh();
  const index = subjectIndexName(prefix, 1);
  await createSubjectIndex(f.search, prefix, 1);
  return { prefix, index, consumer: subjectConsumer(prefix, 1), partition: subjectPartition(id) };
}

async function checkpoint(t: Awaited<ReturnType<typeof target>>) {
  const result = await f.admin.query<{ position: string }>(
    'SELECT position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2',
    [t.partition, t.consumer],
  );
  return BigInt(result.rows[0]?.position ?? '0');
}

function indexer(
  t: Awaited<ReturnType<typeof target>>,
  aroundApply: SubjectApplyGuard,
  search = f.search,
  source: typeof f.source = f.source,
) {
  return createSubjectIndexer({
    ...f.options(t.prefix, search),
    source,
    index: t.index,
    consumer: t.consumer,
    aroundApply,
  });
}

function observe(promise: Promise<unknown>) {
  const state = { settled: false };
  const outcome = promise
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    .finally(() => {
      state.settled = true;
    });
  return { state, outcome };
}

test('failed admission drains a started apply before the relay can fail or retry', async () => {
  const t = await target();
  let reads = 0;
  const source = {
    ...f.source,
    async read(...args: Parameters<typeof f.source.read>) {
      reads++;
      return f.source.read(...args);
    },
  };

  const admissionFailure = new Error('Admission denied');
  const admissionGate = holdBulk(f.search);
  const admission = observe(
    indexer(
      t,
      async (_partition, _envelopes, apply) => {
        void apply();
        throw admissionFailure;
      },
      admissionGate.transport,
      source,
    ).run(t.partition),
  );
  await admissionGate.entered;
  await Promise.resolve();
  expect(admission.state.settled).toBe(false);
  expect(await checkpoint(t)).toBe(0n);
  admissionGate.release();
  const denied = await admission.outcome;
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.error).toBe(admissionFailure);
  expect(reads).toBe(1);
  expect(await checkpoint(t)).toBe(0n);

  const duplicateGate = holdBulk(f.search);
  let duplicateFailure: unknown;
  const duplicate = observe(
    indexer(
      t,
      async (_partition, _envelopes, apply) => {
        void apply();
        try {
          apply();
        } catch (error) {
          duplicateFailure = error;
          throw error;
        }
      },
      duplicateGate.transport,
      source,
    ).run(t.partition),
  );
  await duplicateGate.entered;
  await Promise.resolve();
  expect(duplicate.state.settled).toBe(false);
  expect(await checkpoint(t)).toBe(0n);
  duplicateGate.release();
  const duplicated = await duplicate.outcome;
  expect(duplicated.ok).toBe(false);
  if (!duplicated.ok) expect(duplicated.error).toBe(duplicateFailure);
  expect(reads).toBe(2);
  expect(await checkpoint(t)).toBe(0n);

  const applyFailure = new Error('Source read failed');
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const failingSource = {
      ...f.source,
      async read(..._args: Parameters<typeof f.source.read>) {
        reads++;
        throw applyFailure;
      },
    };
    const failedApply = await indexer(
      t,
      async (_partition, _envelopes, apply) => {
        void apply();
      },
      f.search,
      failingSource,
    )
      .run(t.partition)
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    expect(failedApply.ok).toBe(false);
    if (!failedApply.ok) expect(failedApply.error).toBe(applyFailure);

    const guardFailure = new Error('Admission failed');
    const bothFailed = await indexer(
      t,
      async (_partition, _envelopes, apply) => {
        void apply();
        throw guardFailure;
      },
      f.search,
      failingSource,
    )
      .run(t.partition)
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    expect(bothFailed.ok).toBe(false);
    if (!bothFailed.ok) expect(bothFailed.error).toBe(guardFailure);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
    expect(reads).toBe(4);
    expect(await checkpoint(t)).toBe(0n);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  let admissions = 0;
  const result = await indexer(t, async (_partition, _envelopes, apply) => {
    admissions++;
    await apply();
  }).run(t.partition);
  expect(result.status).toBe('read');
  expect(admissions).toBe(1);
  expect(reads).toBe(5);
  expect(await checkpoint(t)).toBeGreaterThan(0n);
});
