import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { runCommand } from '../../src/command/command.ts';
import { withQueryAccounting } from '../../src/database/pool.ts';
import { createKernelCreditSearchSource } from '../../src/composition/runtime-defaults.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import { createSubjectIndexer, type SubjectApplyGuard } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { CREDIT_SEARCH_LIMITS } from '../../src/search/credit-search.ts';
import type { CreditSearchFields } from '../../src/search/credit-search-document.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
import { createCoverageFixture, holdBulk } from './coverage-fixture.ts';

let f: Awaited<ReturnType<typeof createCoverageFixture>>;
beforeAll(async () => {
  f = await createCoverageFixture(
    undefined,
    createWriteRateLimiter({
      secret: 'subject-relay-fixture-write-rate-key',
      overrides: JSON.stringify(
        Object.fromEntries(
          ['new-account', 'member', 'trusted', 'service'].map((kind) => [
            kind,
            { write: { maximum: 100, seconds: 60 } },
          ]),
        ),
      ),
    }),
  );
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 180_000);

async function target(id?: string) {
  id ??= (await f.books(1))[0];
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

test('live Subject replay batches foreign creator identities and reaches later creates after reclaim', async () => {
  const cast = new Map<number, string>();
  for (let attempt = 0; attempt < 64 && cast.size <= CREDIT_SEARCH_LIMITS.creditsPerPage; attempt++) {
    const { subject } = await f.post('/v1/subjects', {
      type: 'schema:Person',
      labels: { en: `Voice ${attempt}` },
    });
    cast.set(subjectPartition(subject.id), subject.id);
  }
  expect(cast.size).toBe(CREDIT_SEARCH_LIMITS.creditsPerPage + 1);
  const { subject: series } = await f.post('/v1/subjects', {
    type: 'schema:TVSeries',
    labels: { en: 'Series with a distributed cast' },
    statements: {
      'wdt:P725': [...cast.values()].map((id) => ({
        property: { id: 'wdt:P725' },
        value: { type: 'value', content: id },
      })),
    },
  });
  const t = await target(series.id);
  const nativeSource = { ...f.source, creditSearch: createKernelCreditSearchSource(f.pool, f.routeKey) };
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
  const relay = (recover: boolean, source = nativeSource, search = f.search) => {
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
      ...nativeSource,
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

    const identityBatchSizes: number[] = [];
    replay = observe(
      withQueryAccounting(
        {
          connection: (dispatch) => dispatch(),
          query(sql, operands, dispatch) {
            if (sql.includes('semantic.identity_epoch_mapping_sources'))
              identityBatchSizes.push((operands[0] as string[]).length);
            return dispatch();
          },
        },
        () => relay(true, nativeSource, bulk.transport).run(t.partition),
      ),
    );
    await Promise.race([
      bulk.entered,
      replay.outcome.then(() => {
        throw new Error('Replay did not reach bulk');
      }),
    ]);
    const replacement = await writerState();
    // Project both selected pages and revalidate their whole dependency window.
    expect(identityBatchSizes).toEqual([CREDIT_SEARCH_LIMITS.creditsPerPage, 1, cast.size]);
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
    const hits = await f.search.request<{ hits: { hits: { _id: string; _source: CreditSearchFields }[] } }>(
      'POST',
      `/${t.index}/_search`,
      { query: { ids: { values: [id, later.id] } } },
    );
    expect(hits.body.hits.hits.map(({ _id }) => _id).sort()).toEqual([id, later.id].sort());
    const indexed = hits.body.hits.hits.find(({ _id }) => _id === id)!._source;
    expect(indexed.credit_search_complete).toBe(true);
    expect(indexed.credited_names.map(({ targetId }) => targetId).sort()).toEqual([...cast.values()].sort());
  } finally {
    release.resolve();
    bulk.release();
    await old.outcome;
    await replay?.outcome;
  }
}, 30_000);

test('dispatched Subject relay retains the same custody before transport and after a lost successful response', async () => {
  const t = await target();
  const relay = (search = f.search) => {
    const options = { ...f.options(t.prefix, search), ...t };
    return createSubjectIndexer({
      ...options,
      writer: createSearchWriterGuard({ ...options, recoverRelayEnrollment: true }),
    });
  };
  await relay().run(t.partition);
  const previous = await checkpoint(t);
  await runCommand(f.pool, { partition: t.partition }, async () => ({
    value: null,
    events: [{ type: 'com.rezics.subject.created.v1', subject: t.id, data: { id: t.id } }],
  }));
  const row = async () =>
    (
      await f.admin.query(
        `SELECT writer_token, writer_position, writer_transaction_id, dispatch_state, source_position, visible_position,
              repair_action, repair_receipt, relay_receipt
       FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3`,
        [t.partition, t.index, t.id],
      )
    ).rows[0]!;
  const lastVisible = await row();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const lost = new Error('Injected response loss after real refresh-visible bulk');
  let returnedVersion: number | undefined;
  const running = observe(
    relay({
      ...f.search,
      async bulk<T>(lines: readonly unknown[], options?: Parameters<typeof f.search.bulk>[1]): Promise<T> {
        entered.resolve();
        await release.promise;
        const result = await f.search.bulk<{ errors: boolean; items: Array<{ index: { _version: number } }> }>(
          lines,
          options,
        );
        expect(result.errors).toBe(false);
        returnedVersion = result.items[0]!.index._version;
        throw lost;
      },
    }).run(t.partition),
  );
  let dispatched: Awaited<ReturnType<typeof row>>;
  try {
    await Promise.race([
      entered.promise,
      running.outcome.then((outcome) => {
        throw new Error('Relay failed before native dispatch', { cause: outcome });
      }),
    ]);
    dispatched = await row();
    expect(dispatched.dispatch_state).toBe('dispatched');
    expect(dispatched.writer_token).toBeString();
    expect(dispatched.visible_position).toBe(lastVisible.visible_position);
    expect(dispatched.repair_action).toBeNull();
    expect(dispatched.repair_receipt).toBeNull();
    expect(dispatched.relay_receipt).toBeNull();
    await expect(relay().run(t.partition)).rejects.toThrow('Search writer is enrolled');
    expect(await row()).toEqual(dispatched);
  } finally {
    release.resolve();
    await running.outcome;
  }
  expect(await running.outcome).toEqual({ ok: false, error: lost });
  if (returnedVersion === undefined) throw new Error('OpenSearch did not return the applied version');
  expect(returnedVersion).toBeGreaterThan(Number(dispatched.source_position));
  const { body } = await f.search.request<{ hits: { hits: Array<{ _version: number }> } }>(
    'POST',
    `/${t.index}/_search`,
    {
      version: true,
      query: { ids: { values: [t.id] } },
    },
  );
  expect(body.hits.hits.map((hit) => hit._version)).toEqual([returnedVersion]);
  await expect(relay().run(t.partition)).rejects.toThrow('Search writer is enrolled');
  expect(await row()).toEqual(dispatched);
  expect(await checkpoint(t)).toBe(previous);
}, 60_000);

test.each([false, true])(
  'Subject relay settles the retained original receipt with home closed=%s',
  async (closed) => {
    const t = await target();
    const relay = (search = f.search) => {
      const options = { ...f.options(t.prefix, search), ...t };
      return createSubjectIndexer({
        ...options,
        writer: createSearchWriterGuard({ ...options, recoverRelayEnrollment: true }),
      });
    };
    const row = async () =>
      (
        await f.admin.query<{
          writer_token: string | null;
          source_position: string | null;
          relay_receipt: string | null;
        }>(
          `SELECT writer_token,source_position,relay_receipt FROM search.identity_writer
       WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3`,
          [t.partition, t.index, t.id],
        )
      ).rows[0]!;
    const lost = new Error('Injected allocation lookup loss after a validated bulk response');
    let wrote = false;
    await expect(
      relay({
        ...f.search,
        async bulk<T>(...args: Parameters<typeof f.search.bulk>) {
          const result = await f.search.bulk<T>(...args);
          wrote = true;
          return result;
        },
        async request<T>(...args: Parameters<typeof f.search.request>) {
          if (wrote && args[0] === 'GET' && args[1] === `/${t.index}`) throw lost;
          return f.search.request<T>(...args);
        },
      }).run(t.partition),
    ).rejects.toBe(lost);
    const retained = await row();
    const receipt = JSON.parse(retained.relay_receipt!);
    expect(receipt.bulk.items[0].index).toMatchObject({
      _id: t.id,
      _index: t.index,
      _version: Number(receipt.version),
    });
    expect(retained.source_position).toBeNull();
    expect(await checkpoint(t)).toBe(0n);
    if (closed) {
      const writer = createSearchWriterGuard({
        ...f.options(t.prefix, f.search),
        ...t,
        recoverRelayEnrollment: true,
      });
      const barrier = await writer.closeGeneration(t.partition);
      expect(barrier.ordinary).toBe('draining');
      await expect(relay().run(t.partition)).rejects.toThrow('Search generation is closed to writer enrollment');
      expect((await writer.adoptGenerationPublicationBarrier(barrier.locator)).ordinary).toBe('drained');
      expect(await row()).toEqual({ writer_token: null, source_position: receipt.version, relay_receipt: null });
      expect(await checkpoint(t)).toBe(0n);
      return;
    }
    let replayed = false;
    await relay({
      ...f.search,
      async bulk<T>(...args: Parameters<typeof f.search.bulk>) {
        const next = await row();
        expect(next.writer_token).not.toBe(retained.writer_token);
        expect(next.source_position).toBe(receipt.version);
        expect(next.relay_receipt).toBeNull();
        replayed = true;
        return f.search.bulk<T>(...args);
      },
    }).run(t.partition);
    expect(replayed).toBe(true);
    const settled = await row();
    expect(settled.writer_token).toBeNull();
    expect(settled.relay_receipt).toBeNull();
    expect(BigInt(settled.source_position!)).toBeGreaterThan(BigInt(receipt.version));
    expect(await checkpoint(t)).toBeGreaterThan(0n);
  },
  60_000,
);
