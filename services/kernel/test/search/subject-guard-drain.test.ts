import { afterAll, beforeAll, expect, test } from 'bun:test';
import { runCommand } from '../../src/command/command.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import { createSubjectIndexer, type SubjectApplyGuard } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
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
  return { id, prefix, index, consumer: subjectConsumer(prefix, 1), partition: subjectPartition(id) };
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
  const result = await indexer(
    t,
    async (_partition, _envelopes, apply) => {
      admissions++;
      await apply();
    },
    f.search,
    source,
  ).run(t.partition);
  expect(result.status).toBe('read');
  expect(admissions).toBe(1);
  expect(reads).toBe(5);
  expect(await checkpoint(t)).toBeGreaterThan(0n);
});

test('live Subject replay replaces aged pre-dispatch custody and reaches later creates in the same home', async () => {
  const t = await target();
  const { id } = t;
  let laterKey: ReturnType<typeof crypto.randomUUID> | undefined;
  for (let attempt = 0; attempt < 100_000; attempt++) {
    const key = crypto.randomUUID();
    if (subjectPartition(subjectTarget(f.routeKey, f.accountId, key).id) === t.partition) {
      laterKey = key;
      break;
    }
  }
  if (!laterKey) throw new Error('Could not select a later create in the same home');
  const relay = (recover: boolean, source = f.source, search = f.search) => {
    const options = { ...f.options(t.prefix, search), ...t, source };
    const writer = createSearchWriterGuard({ ...options, ...(recover && { recoverRelayEnrollment: true }) });
    return createSubjectIndexer({ ...options, writer });
  };
  await relay(true).run(t.partition);
  const previous = await checkpoint(t);
  const writerState = async () =>
    (
      await f.admin.query<{
        writer_token: string | null;
        writer_position: string;
        visible_transaction_id: string;
        dispatch_state: string;
      }>(
        `SELECT writer_token, writer_position, visible_transaction_id, dispatch_state FROM search.identity_writer
       WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3`,
        [t.partition, t.index, id],
      )
    ).rows[0]!;
  const receipt = (await writerState()).visible_transaction_id;
  expect(receipt).toBeString();
  await runCommand(f.pool, { partition: t.partition }, async () => ({
    value: null,
    events: [{ type: 'com.rezics.subject.created.v1', subject: id, data: { id } }],
  }));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const old = observe(
    relay(false, {
      ...f.source,
      async read(...args) {
        entered.resolve();
        await release.promise;
        return f.source.read(...args);
      },
    }).run(t.partition),
  );
  const ageEnrollment = async (position: string) => {
    // Age only the clock in the disposable check database. All writer transitions use native commands.
    const aged = await f.admin.query(
      `UPDATE core.outbox SET recorded_at=statement_timestamp() - interval '1 minute'
       WHERE partition_no=$1 AND position=$2 AND event_seq=0 AND type='com.rezics.search.identity_writer.changed.v1'`,
      [t.partition, position],
    );
    expect(aged.rowCount).toBe(1);
  };
  const bulk = holdBulk(f.search);
  let replay: ReturnType<typeof observe> | undefined;
  try {
    await Promise.race([
      entered.promise,
      old.outcome.then(() => {
        throw new Error('Writer did not reach Source');
      }),
    ]);
    const enrolled = await writerState();
    expect(enrolled.dispatch_state).toBe('enrolled');
    const { subject: later } = await f.post(
      '/v1/subjects',
      { type: 'schema:Book', labels: { en: 'Later book' } },
      laterKey,
    );
    expect(subjectPartition(later.id)).toBe(t.partition);
    const {
      rows: [event],
    } = await f.admin.query<{ position: string }>(
      `SELECT position FROM core.outbox WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.subject.created.v1'`,
      [t.partition, later.id],
    );
    await expect(relay(true).run(t.partition)).rejects.toThrow('Search writer is enrolled');
    await ageEnrollment(enrolled.writer_position);
    await expect(relay(false).run(t.partition)).rejects.toThrow('Search writer is enrolled');
    expect(await checkpoint(t)).toBe(previous);

    replay = observe(relay(true, f.source, bulk.transport).run(t.partition));
    await Promise.race([
      bulk.entered,
      replay.outcome.then(() => {
        throw new Error('Replay did not reach bulk');
      }),
    ]);
    const replacement = await writerState();
    expect(replacement.dispatch_state).toBe('dispatched');
    expect(replacement.writer_token).not.toBe(enrolled.writer_token);
    expect(replacement.visible_transaction_id).toBe(receipt);
    release.resolve();
    const oldResult = await old.outcome;
    expect(oldResult).toEqual({
      ok: false,
      error: expect.objectContaining({ message: 'Search writer was revoked before dispatch' }),
    });
    await ageEnrollment(replacement.writer_position);
    await expect(relay(true).run(t.partition)).rejects.toThrow('Search writer is enrolled');
    expect(await checkpoint(t)).toBe(previous);
    bulk.release();
    expect(await replay.outcome).toEqual({ ok: true });
    expect(await checkpoint(t)).toBe(BigInt(event!.position));
    const hits = await f.search.request<{ hits: { hits: { _id: string }[] } }>('POST', `/${t.index}/_search`, {
      query: { ids: { values: [id, later.id] } },
    });
    expect(hits.body.hits.hits.map(({ _id }) => _id).sort()).toEqual([id, later.id].sort());
  } finally {
    release.resolve();
    bulk.release();
    await old.outcome;
    await replay?.outcome;
  }
}, 30_000);
