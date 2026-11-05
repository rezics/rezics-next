import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { stepIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import { stepIdentityEpochMapping } from '../../src/semantic/identity-epoch-mapping.ts';
import { identityEpochStore as store } from '../../src/semantic/identity-epoch-store.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { searchIdentityWriterChanged } from '../../src/search/identity-epoch-participant-events.ts';
import type { SearchNativeReceivingPreparation } from '../../src/search/identity-receiving-native-internal.ts';
import { createSearchIdentityReceivingNativeStore } from '../../src/search/identity-receiving-native-store.ts';
import {
  SearchNativeReceivingError,
  SearchNativeReceivingWork,
  searchNativeReceivingZero,
} from '../../src/search/identity-receiving-native-work.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { createSearchWriterGuard } from '../../src/search/writer-guard.ts';
import { digest, epochFixture, release, type EpochFixture } from '../semantic/support/identity-epoch.ts';
import { libraryCutoverInput } from '../semantic/support/identity-epoch-cutover.ts';

// Additional production-core regressions. Full integrated receiving acceptance remains in the protected suite.
// Authored only: the current execution policy permits workspace typing, not this native/engine suite.
const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error('OPENSEARCH_URL must name the check node');
const search = createOpenSearch(url);
const prefix = `native-store-${randomUUID().slice(0, 8)}-`;
const index = subjectIndexName(prefix, 1);
const consumer = subjectConsumer(prefix, 1);
const routeKey = crypto.getRandomValues(new Uint8Array(32));
let f: EpochFixture;
let created = false;
const context = () => ({
  deadline: Date.now() + 1000,
  allowance: {
    rows: 5000,
    points: 5000,
    statements: 500,
    bytes: 32 * 1024 * 1024,
    engineRequests: 0,
  },
});
beforeAll(async () => {
  f = await epochFixture();
  await createSubjectIndex(search, prefix, 1);
  created = true;
});
afterAll(async () => {
  try {
    if (created) await search.request('DELETE', `/${index}`);
  } finally {
    await f?.close();
  }
});
function native() {
  return createSearchIdentityReceivingNativeStore({ pool: f.pool, index, consumer });
}
function writer(engine = search) {
  return createSearchWriterGuard({
    pool: f.pool,
    search: engine,
    index,
    consumer,
    source: subjectSource(f.pool, routeKey),
    listing: subjectListingSource(f.pool),
  });
}
async function preparation(
  route: number,
  engine = search,
  uncertain = false,
): Promise<SearchNativeReceivingPreparation> {
  const original = (await f.create('Native operational original', route)).id;
  const terminal = (await f.create('Native operational terminal', route + 0x10)).id;
  await libraryCutoverInput(f, [original, terminal]);
  const guard = writer(engine);
  if (uncertain) await expect(guard.write(subjectPartition(original), [original], 0n)).rejects.toThrow();
  else await guard.write(subjectPartition(original), [original], 0n);
  const actor = await f.actor();
  const commandKey = randomUUID();
  const job = await store.prepareAdmission(
    f.pool,
    {
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization: await f.authorization('subject:merge'),
    },
    {
      intent: { kind: 'merge', redirected: original, survivor: terminal, release: release.digest },
      receipt: {
        kind: 'subject.merge',
        command: {
          actorAccountId: actor.accountId,
          kind: 'subject.merge',
          key: commandKey,
          digest: digest(commandKey),
        },
      },
    },
  );
  for (let i = 0; i < 128; i++) if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'pending') break;
  for (let i = 0; i < 128; i++) if ((await stepIdentityEpochMapping(f.pool, job)).state === 'complete') break;
  const fence = await guard.fenceOriginal(job, original);
  const barrier = await guard.closeGeneration(subjectPartition(original));
  const locator = {
    kind: 'search-canonical-index' as const,
    version: 1 as const,
    partition: subjectPartition(original),
    planId: randomUUID(),
  };
  const scope = `${consumer}:${original}:OLD`;
  const scopeDigest = (
    await f.admin.query<{ scope_digest: string }>(
      'SELECT scope_digest FROM semantic.identity_epoch_job WHERE job_id=$1',
      [job.jobId],
    )
  ).rows[0]!.scope_digest;
  return {
    selection: {
      job,
      original,
      effectKey: scope,
      owner: original,
      sourceId: original,
      scope,
      disposition: 'OLD',
      native: locator,
    },
    source: {
      locator,
      original,
      terminal,
      documentId: original,
      owner: original,
      sourceId: original,
      scope,
      disposition: 'OLD',
      receivingHome: locator.partition,
      receivingEpoch: barrier.native.epoch,
      consumer,
      physicalTarget: index,
      incarnation: barrier.incarnation,
      writeAlias: barrier.writeAlias,
      physicalGeneration: barrier.physicalGeneration,
      enrollmentGeneration: barrier.enrollmentGeneration,
      fenceGeneration: barrier.fenceGeneration,
      barrier: barrier.locator,
      originalFence: fence.gate,
    },
    scopeDigest,
    // Operational references explicitly do not assert admitted complete support or selectable readiness.
    references: {
      originalSupport: null,
      terminalSupport: null,
      definition: release.digest,
      release: release.digest,
      documentFence: fence.gate,
      predecessor: null,
    },
    actionDigest: '1'.repeat(64),
    copies: uncertain
      ? [
          {
            home: locator.partition,
            consumer,
            physicalTarget: index,
            incarnation: barrier.incarnation,
            writeAlias: barrier.writeAlias,
            original,
            close: fence.gate,
            enrollment: fence.writer,
            visible: null,
            state: 'dispatched',
          },
        ]
      : [],
  };
}

test('native receiving rejects a facade client, wrong real Pool and wrong receiving home', async () => {
  const receiving = native();
  const locator = { kind: 'search-canonical-index' as const, version: 1 as const, partition: 1, planId: randomUUID() };
  let queries = 0;
  // A bound Pool query facade is still not an executor-owned command client.
  const facade = {
    query: new Proxy(f.pool.query.bind(f.pool), {
      apply(target, _receiver, args) {
        queries++;
        return Reflect.apply(target, f.pool, args);
      },
    }),
  };
  await expect(receiving.readAndHold(facade, locator, context())).rejects.toMatchObject({
    status: 'unavailable',
    work: searchNativeReceivingZero,
  });
  expect(queries).toBe(0);
  const subject = (await f.create('Wrong receiving resources', 0xd110)).id;
  const partition = subjectPartition(subject);
  const other = new Pool({ max: 1 });
  try {
    const foreign = createSearchIdentityReceivingNativeStore({ pool: other, index, consumer });
    await runCommand(f.pool, { partition }, async (tx) => {
      await expect(foreign.readAndHold(tx, { ...locator, partition }, context())).rejects.toMatchObject({
        status: 'unavailable',
        work: searchNativeReceivingZero,
      });
      return noEffect(null);
    });
    await expect(
      runCommand(f.pool, { partition }, async (tx) => {
        await receiving.readAndHold(tx, { ...locator, partition: (partition + 1) % 4096 }, context());
        return { value: null, events: searchIdentityWriterChanged() };
      }),
    ).rejects.toMatchObject({ status: 'changed' });
  } finally {
    await other.end();
  }
});

test('native preparation commits before resolution and immutable replay retains its actual original component', async () => {
  const input = await preparation(0xd210);
  const receiving = native();
  const locator = input.selection.native;
  await expect(
    runCommand(f.pool, { partition: locator.partition }, async (tx) => {
      await receiving.preparePlan(tx, input, context());
      await receiving.readAndHold(tx, locator, context());
      return { value: null, events: searchIdentityWriterChanged() };
    }),
  ).rejects.toBeInstanceOf(SearchNativeReceivingError);
  expect(
    (
      await f.admin.query('SELECT 1 FROM search.identity_receiving_native_plan WHERE partition_no=$1 AND plan_id=$2', [
        locator.partition,
        locator.planId,
      ])
    ).rowCount,
  ).toBe(0);
  const committed = await runCommand(f.pool, { partition: locator.partition }, async (tx) => ({
    value: (await receiving.preparePlan(tx, input, context())).value,
    events: searchIdentityWriterChanged(),
  }));
  expect(committed.value.source.plan.transactionId).toBe(committed.transactionId);
  expect(committed.value.source.plan.position).toBe(committed.position);
  expect((await receiving.readPlan(locator, context())).value).toEqual(committed.value);
  const replay = await runCommand(f.pool, { partition: locator.partition }, async (tx) => ({
    value: (await receiving.preparePlan(tx, input, context())).value,
    events: searchIdentityWriterChanged(),
  }));
  expect(replay.value).toEqual(committed.value);
  expect(replay.transactionId).not.toBe(committed.transactionId);
  await expect(
    runCommand(f.pool, { partition: locator.partition }, async (tx) => ({
      value: await receiving.preparePlan(tx, { ...input, actionDigest: '2'.repeat(64) }, context()),
      events: searchIdentityWriterChanged(),
    })),
  ).rejects.toMatchObject({ status: 'changed' });
  expect((await receiving.readPlan(locator, context())).value).toEqual(committed.value);
  // No matching canonical Search common record exists: the actual native hold insert must roll back.
  await expect(
    runCommand(f.pool, { partition: locator.partition }, async (tx) => ({
      value: await receiving.readAndHold(tx, locator, context()),
      events: searchIdentityWriterChanged(),
    })),
  ).rejects.toMatchObject({ status: 'changed' });
  expect(
    (
      await f.admin.query('SELECT 1 FROM search.identity_receiving_native_hold WHERE partition_no=$1 AND plan_id=$2', [
        locator.partition,
        locator.planId,
      ])
    ).rowCount,
  ).toBe(0);
});

test('native reconciliation retains actual uncertain original dispatch after refresh and returns charged refusal', async () => {
  const lost: OpenSearch = {
    request: search.request.bind(search),
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>) {
      await search.bulk<T>(...args);
      throw new Error('Native store regression: actual original response lost');
    },
  };
  const input = await preparation(0xd310, lost, true);
  const receiving = native();
  const locator = input.selection.native;
  await runCommand(f.pool, { partition: locator.partition }, async (tx) => ({
    value: await receiving.preparePlan(tx, input, context()),
    events: searchIdentityWriterChanged(),
  }));
  await search.request('POST', `/${index}/_refresh`);
  const page = await receiving.readOriginalCopies(locator, -1, 1, context());
  expect(page.value[0]?.locator.state).toBe('dispatched');
  try {
    await receiving.observeOriginalCopy(locator, 0, context());
    throw new Error('Uncertain original copy unexpectedly settled');
  } catch (error) {
    expect(error).toBeInstanceOf(SearchNativeReceivingError);
    if (!(error instanceof SearchNativeReceivingError)) throw error;
    expect(error.status).toBe('draining');
    expect(error.work.statements).toBeGreaterThan(8);
    expect(error.work.engineRequests).toBe(0);
  }
  expect((await receiving.readOriginalCopies(locator, -1, 1, context())).value[0]?.reconciled).toBe(false);
});

test('native drain counts committed preparations and distinguishes an unprepared owner from genuine native empty', async () => {
  const receiving = native();
  const input = await preparation(0xd410);
  const locator = input.selection.native;
  await runCommand(f.pool, { partition: locator.partition }, async (tx) => ({
    value: await receiving.preparePlan(tx, input, context()),
    events: searchIdentityWriterChanged(),
  }));
  const pending = await runCommand(f.pool, { partition: locator.partition }, async (tx) =>
    noEffect(await receiving.readDrain(tx, context())),
  );
  expect(pending.value.value).toEqual({ state: 'draining', locator });
  expect(pending.value.work).toEqual({ rows: 3, points: 3, statements: 3, bytes: 1280, engineRequests: 0 });
  const original = (await f.create('Unprepared native drain home', 0xd510)).id;
  const partition = subjectPartition(original);
  await expect(
    runCommand(f.pool, { partition }, async (tx) => noEffect(await receiving.readDrain(tx, context()))),
  ).rejects.toMatchObject({ status: 'unavailable' });
  await writer().closeGeneration(partition);
  const empty = await runCommand(f.pool, { partition }, async (tx) =>
    noEffect(await receiving.readDrain(tx, context())),
  );
  expect(empty.value.value).toEqual({ state: 'empty' });
  // Native empty never claims Source first-apply/support/participant completion.
  expect((await store.readJob(f.pool, input.selection.job))?.participants['search-canonical-index']).toBeNull();
});

test('native work retains the original finite reservation and deadline across caller mutation', () => {
  const original = {
    deadline: Date.now() + 60_000,
    allowance: {
      rows: 1,
      points: 1,
      statements: 1,
      bytes: 256,
      engineRequests: 0,
    },
  };
  const work = new SearchNativeReceivingWork(original);
  const deadline = original.deadline;
  work.sql('owner');
  Object.assign(original.allowance, { rows: 5000, points: 5000, statements: 5000, bytes: 32 * 1024 * 1024 });
  original.deadline += 60_000;
  expect(work.context.deadline).toBe(deadline);
  expect(() => work.sql('owner')).toThrow(SearchNativeReceivingError);
  expect(work.snapshot()).toEqual({ rows: 1, points: 1, statements: 1, bytes: 256, engineRequests: 0 });
});

test('native preparation refuses malformed immutable original and copy receipts before persistence', async () => {
  const input = await preparation(0xd610);
  const receiving = native();
  const locator = input.selection.native;
  const malformed: readonly SearchNativeReceivingPreparation[] = [
    { ...input, source: { ...input.source, originalFence: { ...input.source.originalFence, position: -1n } } },
    {
      ...input,
      source: {
        ...input.source,
        originalFence: { ...input.source.originalFence, partition: (locator.partition + 1) % 4096 },
      },
    },
    {
      ...input,
      copies: [
        {
          home: locator.partition,
          original: input.source.original,
          consumer,
          physicalTarget: index,
          incarnation: input.source.incarnation,
          writeAlias: input.source.writeAlias,
          close: { ...input.source.originalFence, transactionId: 'invalid' },
          enrollment: null,
          visible: null,
          state: 'enrolled',
        },
      ],
    },
    { ...input, references: { ...input.references, predecessor: locator } },
  ];
  for (const candidate of malformed) {
    await expect(
      runCommand(f.pool, { partition: locator.partition }, async (tx) => ({
        value: await receiving.preparePlan(tx, candidate, context()),
        events: searchIdentityWriterChanged(),
      })),
    ).rejects.toMatchObject({
      status: 'changed',
      work: {
        rows: 1,
        points: 1,
        statements: 2,
        bytes: 256,
        engineRequests: 0,
      },
    });
  }
  expect(
    (
      await f.admin.query('SELECT 1 FROM search.identity_receiving_native_plan WHERE partition_no=$1 AND plan_id=$2', [
        locator.partition,
        locator.planId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await f.admin.query(
        'SELECT 1 FROM search.identity_receiving_native_pending WHERE partition_no=$1 AND plan_id=$2',
        [locator.partition, locator.planId],
      )
    ).rowCount,
  ).toBe(0);
});

import { systemClock } from '../../src/clock.ts';
import {
  createSearchIdentityReceivingNative,
  withSearchIdentityReceivingNativeInvocation,
} from '../../src/search/identity-receiving-native.ts';
import type {
  SearchIdentityReceivingBinding,
  SearchIdentityReceivingRecord,
} from '../../src/search/identity-receiving-native-contract.ts';

test('the genuine six-method factory retains same-T acceptance rollback and refuses a crossed configured Pool', async () => {
  const input = await preparation(0xd710);
  const receiving = native();
  const plan = (
    await runCommand(f.pool, { partition: input.selection.native.partition }, async (tx) => ({
      value: (await receiving.preparePlan(tx, input, context())).value,
      events: searchIdentityWriterChanged(),
    }))
  ).value;
  const adapter = createSearchIdentityReceivingNative({
    pool: f.pool,
    access: f.access,
    clock: systemClock,
    routeKey,
    search,
    index,
    consumer,
  });
  expect(Object.keys(adapter).sort()).toEqual(
    ['readAndHold', 'revalidateHold', 'resolvePlanned', 'recordApplied', 'reconcileOriginal', 'releaseHold'].sort(),
  );
  const binding: SearchIdentityReceivingBinding = {
    job: input.selection.job,
    original: input.selection.original,
    effectKey: input.selection.effectKey,
    owner: input.selection.owner,
    scopeDigest: plan.scopeDigest,
    step: 'search-canonical-index',
    version: 1,
    source: plan.source,
  };
  await expect(
    runCommand(f.pool, { partition: plan.source.receivingHome }, async (tx) => {
      const result = await adapter.readAndHold(tx, binding, context());
      expect(result.status).toBe('ready');
      return { value: null, events: searchIdentityWriterChanged() };
    }),
  ).rejects.toMatchObject({ status: 'changed' });
  expect(
    (
      await f.admin.query('SELECT 1 FROM search.identity_receiving_native_hold WHERE partition_no=$1 AND plan_id=$2', [
        plan.source.receivingHome,
        plan.source.locator.planId,
      ])
    ).rowCount,
  ).toBe(0);
  const other = new Pool({ max: 1 });
  try {
    const foreign = createSearchIdentityReceivingNative({
      pool: other,
      access: f.access,
      clock: systemClock,
      routeKey,
      search,
      index,
      consumer,
    });
    await runCommand(f.pool, { partition: plan.source.receivingHome }, async (tx) => {
      expect(await foreign.readAndHold(tx, binding, context())).toMatchObject({
        status: 'unavailable',
        work: searchNativeReceivingZero,
      });
      return noEffect(null);
    });
  } finally {
    await other.end();
  }
});

test('factory release cannot use a terminal cursor or another invocation as private observation authority', async () => {
  const input = await preparation(0xd810);
  const plan = (
    await runCommand(f.pool, { partition: input.selection.native.partition }, async (tx) => ({
      value: (await native().preparePlan(tx, input, context())).value,
      events: searchIdentityWriterChanged(),
    }))
  ).value;
  const adapter = createSearchIdentityReceivingNative({
    pool: f.pool,
    access: f.access,
    clock: systemClock,
    routeKey,
    search,
    index,
    consumer,
  });
  const record: SearchIdentityReceivingRecord = {
    job: input.selection.job,
    original: input.selection.original,
    effectKey: input.selection.effectKey,
    owner: input.selection.owner,
    scopeDigest: plan.scopeDigest,
    step: 'search-canonical-index',
    version: 1,
    source: plan.source,
    plan: plan.source.plan,
    sourceHold: plan.source.plan,
    receipt: plan.source.plan,
    applied: null,
    nativeHold: { locator: plan.source.locator, holdId: randomUUID(), source: plan.source },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await withSearchIdentityReceivingNativeInvocation(adapter, () =>
      runCommand(f.pool, { partition: plan.source.receivingHome }, async (tx) => {
        const result = await adapter.releaseHold(tx, record, context());
        expect(result).toMatchObject({ status: 'changed', work: searchNativeReceivingZero });
        return noEffect(null);
      }),
    );
  }
  const reconciliation = await adapter.reconcileOriginal(plan.source.locator, null, context());
  expect(reconciliation.status).toBe('draining');
  expect(reconciliation.work.statements).toBeGreaterThan(0);
  expect(reconciliation.work.engineRequests).toBe(0);
});

test('the factory rejects noncanonical or oversized reconciliation cursors before reading custody', async () => {
  const adapter = createSearchIdentityReceivingNative({
    pool: f.pool,
    access: f.access,
    clock: systemClock,
    routeKey,
    search,
    index,
    consumer,
  });
  const locator = { kind: 'search-canonical-index' as const, version: 1 as const, partition: 0, planId: randomUUID() };
  const valid = { version: 1, identity: 'a'.repeat(64), copy: -1, terminal: false };
  for (const after of [
    'null',
    '[]',
    '{',
    JSON.stringify({ ...valid, proof: true }),
    JSON.stringify({ terminal: false, copy: -1, identity: valid.identity, version: 1 }),
    JSON.stringify({ ...valid, copy: 2147483647 }),
    JSON.stringify({ ...valid, copy: -2 }),
    JSON.stringify({ ...valid, identity: 'A'.repeat(64) }),
    ' '.repeat(2049),
  ]) {
    expect(await adapter.reconcileOriginal(locator, after, context())).toEqual({
      status: 'changed',
      work: searchNativeReceivingZero,
    });
  }
});

test('native work refuses invalid costs without minting residual work and retains expired child settlement', () => {
  const original = {
    deadline: Date.now() + 60000,
    allowance: {
      rows: 1,
      points: 1,
      statements: 1,
      bytes: 256,
      engineRequests: 0,
    },
  };
  const work = new SearchNativeReceivingWork(original);
  for (const rows of [-1, NaN, Infinity, 0.5]) {
    expect(() => work.reserve({ ...searchNativeReceivingZero, rows })).toThrow(SearchNativeReceivingError);
    expect(work.snapshot()).toEqual(searchNativeReceivingZero);
  }
  const expired = new SearchNativeReceivingWork({ ...original, deadline: Date.now() - 1 });
  expired.settle(original.allowance);
  expect(expired.snapshot()).toEqual(original.allowance);
  expect(() => expired.reserve(searchNativeReceivingZero)).toThrow(SearchNativeReceivingError);
  expect(expired.snapshot()).toEqual(original.allowance);
});
