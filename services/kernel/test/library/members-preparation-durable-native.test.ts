import { afterAll, beforeAll, expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { runOperationalTransaction, type OperationalTransaction } from '../../src/command/operational.ts';
import type { PreparationLocator } from '../../src/library/members-preparation.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import {
  fundOperationalWorkOriginal,
  OPERATIONAL_WORK_LOCAL_DECLARATION,
} from '../../src/history/operational-work-budget.ts';
import {
  operationalWorkSource,
  receiveCommittedOperationalWork,
  resolveCommittedOperationalWork,
  verifyCommittedOperationalWorkOrigin,
} from '../../src/history/operational-work.ts';
import {
  inspectOperationalWorkRetirement,
  verifyOperationalWorkReplay,
} from '../../src/history/operational-work-receiving.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import {
  declareMembersPreparationRequest,
  runMembersPreparationRequest,
} from '../../src/library/members-preparation-request.ts';
import { MEMBERS_PREPARATION_CHILDREN } from '../../src/library/members-preparation-budget.ts';
import { definition, membersPreparationRuntime } from './support/members-preparation-runtime.ts';

let native: Awaited<ReturnType<typeof membersPreparationRuntime>>;
beforeAll(async () => {
  native = await membersPreparationRuntime();
}, 120_000);
afterAll(async () => {
  await native?.close();
});

function step<T>(locator: PreparationLocator, body: (tx: OperationalTransaction) => Promise<T>) {
  return runOperationalTransaction(
    native.db.pool,
    {
      mode: 'work-step',
      partition: partitionOf(locator.route),
      kind: 'library.membersPreparation.step',
      accounts: [locator.ownerAccountId],
      workClient: native.workClient,
    },
    body,
  );
}

test('retained definitions recover exact immutable meaning without granting Source or result authority', async () => {
  const fixture = await native.fixture();
  const selected = definition();
  const reserved = await fixture.store.reserve(fixture.actor, fixture.collectionId, [
    selected,
    { ...selected, sort: 'ordinal' },
  ]);
  expect(
    await fixture.store.readRetainedDefinition({} as OperationalTransaction, reserved.episodes[0]!.locator),
  ).toBeNull();
  for (const episode of reserved.episodes) {
    const locator = episode.locator;
    let ended!: OperationalTransaction;
    await step(locator, async (tx) => {
      ended = tx;
      const recovered = await fixture.store.readRetainedDefinition(tx, locator);
      expect(recovered).toEqual({ ...selected, sort: episode === reserved.episodes[0] ? 'id' : 'ordinal' });
      await expect(fixture.store.readWorkDefinition(tx, locator)).rejects.toMatchObject({
        code: 'dependency_unavailable',
      });
      expect(
        await fixture.store.readRetainedDefinition(tx, { ...locator, episodeId: newId(locator.route) }),
      ).toBeNull();
      expect(
        await fixture.store.readRetainedDefinition(tx, { ...locator, collectionId: newId(locator.route) }),
      ).toBeNull();
      // A cached complete flag without final current Source authority cannot produce a ready result.
      await tx.query('UPDATE library.members_preparation SET complete=true WHERE episode_id=$1', [locator.episodeId]);
      await expect(fixture.store.readWorkDefinition(tx, locator)).rejects.toMatchObject({
        code: 'dependency_unavailable',
      });
    });
    expect(await fixture.store.readRetainedDefinition(ended, locator)).toBeNull();
  }
});

test('retained recovery rejects digest, canonical, namespace and immutable-release substitutions and expires honestly', async () => {
  const fixture = await native.fixture();
  const reserved = await fixture.store.reserve(fixture.actor, fixture.collectionId, [definition()]);
  const locator = reserved.episodes[0]!.locator;
  const header = (await native.rows(fixture.owner))[0]!;
  const basis = JSON.parse(header.canonical_basis);
  const mutations = [
    [basis, false],
    [[...basis, 'extra'], true],
    [[2, ...basis.slice(1)], true],
    [[basis[0], newId(locator.route), ...basis.slice(2)], true],
    [[...basis.slice(0, 2), newId(locator.route), ...basis.slice(3)], true],
    [[...basis.slice(0, 3), { unknown: true }, ...basis.slice(4)], true],
  ] as const;
  await step(locator, async (tx) => {
    for (const [value, matchingDigest] of mutations) {
      const bytes = canonicalize(value)!;
      await tx.query('UPDATE library.members_preparation SET canonical_basis=$2,basis_digest=$3 WHERE episode_id=$1', [
        locator.episodeId,
        bytes,
        matchingDigest ? createHash('sha256').update(bytes).digest() : Buffer.alloc(32),
      ]);
      await expect(fixture.store.readRetainedDefinition(tx, locator)).rejects.toMatchObject({
        code: 'unsupported_query',
      });
    }
    const missingRelease = canonicalize([...basis.slice(0, 5), `sha256:${'0'.repeat(64)}`])!;
    await tx.query('UPDATE library.members_preparation SET canonical_basis=$2,basis_digest=$3 WHERE episode_id=$1', [
      locator.episodeId,
      missingRelease,
      createHash('sha256').update(missingRelease).digest(),
    ]);
    await expect(fixture.store.readRetainedDefinition(tx, locator)).rejects.toMatchObject({
      code: 'dependency_unavailable',
    });
    const bytes = ` ${header.canonical_basis}`;
    await tx.query('UPDATE library.members_preparation SET canonical_basis=$2,basis_digest=$3 WHERE episode_id=$1', [
      locator.episodeId,
      bytes,
      createHash('sha256').update(bytes).digest(),
    ]);
    await expect(fixture.store.readRetainedDefinition(tx, locator)).rejects.toMatchObject({
      code: 'unsupported_query',
    });
    await tx.query(
      'UPDATE library.members_preparation SET canonical_basis=$2,basis_digest=$3,last_read_at=$4 WHERE episode_id=$1',
      [locator.episodeId, header.canonical_basis, header.basis_digest, new Date(0)],
    );
    expect(await fixture.store.readRetainedDefinition(tx, locator)).toBeNull();
    expect(await fixture.store.readWorkDefinition(tx, locator)).toBeNull();
  });
});

test('one funded History child registers the real native reservation and transfers committed receiving and readback work', async () => {
  const fixture = await native.fixture();
  const deadline = Date.now() + 60_000;
  const parent = new NativeCollectionWork(
    {
      reservationId: 'native-members-history',
      remaining: OPERATIONAL_WORK_LOCAL_DECLARATION,
    },
    deadline,
  );
  const history = fundOperationalWorkOriginal(parent, native.db.pool, native.workClient, deadline);
  expect(parent.receipt().used).toEqual(OPERATIONAL_WORK_LOCAL_DECLARATION);
  const result = await fixture.store.reserve(fixture.actor, fixture.collectionId, [definition()], { history });
  expect(result.episodes[0]!.state).toBe('preparing');
  expect(result.history).toBeDefined();
  const transfers = result.history!;
  const stored = (
    await native.db.admin.query(
      'SELECT * FROM core.operational_work_original WHERE partition_no=$1 AND custody_id=$2',
      [transfers.registration.partition, transfers.registration.custodyId],
    )
  ).rows[0];
  const headers = await native.rows(fixture.owner);
  expect(stored.sealed).toBe(true);
  expect(stored.creation_captured).toBe(true);
  expect(stored.intent).toEqual(result.intent);
  expect(stored.binding.episodes[0]).toMatchObject({
    episodeId: result.episodes[0]!.locator.episodeId,
    canonicalBasis: headers[0]!.canonical_basis,
    reservedIncarnation: headers[0]!.reserved_incarnation,
    reservedGeneration: headers[0]!.reserved_generation,
  });
  const origin = await resolveCommittedOperationalWork(native.db.pool, transfers.registration, transfers.resolve);
  expect(origin).not.toBeNull();
  const source = operationalWorkSource(native.db.pool, origin!);
  expect(await verifyCommittedOperationalWorkOrigin(native.db.pool, origin!, transfers.verify)).toEqual(source.stamp!);
  expect(await receiveCommittedOperationalWork(native.db.pool, native.workClient, origin!, transfers.receive)).toBe(
    'registered-pending-source-currentness',
  );
  // Registration and a successful receiving transaction must never certify uncaptured Source currentness.
  await expect(
    verifyOperationalWorkReplay(native.db.pool, native.workClient, origin!, transfers.replay),
  ).rejects.toThrow('operational-work-source-currentness-unavailable');
  expect(
    await inspectOperationalWorkRetirement(native.db.pool, native.workClient, transfers.registration.custodyId, {
      origin: origin!,
      transfer: transfers.retirement,
    }),
  ).toBe('operational-work-source-currentness-unavailable');
  await expect(
    resolveCommittedOperationalWork(native.db.pool, transfers.registration, transfers.resolve),
  ).rejects.toThrow('operational-work-native-transfer-unavailable');
  const duplicate = await fixture.store.reserve(fixture.actor, fixture.collectionId, [definition()]);
  expect(duplicate.intent).toBeNull();
  expect(duplicate.history).toBeUndefined();
  expect(duplicate.episodes).toEqual(result.episodes);
});

test('a reconstructed service recovers the exact committed definition only during its live episode', async () => {
  const fixture = await native.fixture();
  const selected = definition();
  const reserved = await fixture.store.reserve(fixture.actor, fixture.collectionId, [selected]);
  const locator = reserved.episodes[0]!.locator;
  expect(await native.step(locator)).toBe(true);
  const read = (address: PreparationLocator, clock?: () => Date) =>
    runOperationalTransaction(
      native.db.pool,
      {
        mode: 'work-step',
        partition: partitionOf(address.route),
        kind: 'library.membersPreparation.step',
        accounts: [address.ownerAccountId],
        workClient: native.workClient,
        ...(clock ? { clock } : {}),
      },
      (tx) => native.store().readRetainedDefinition(tx, address),
    );
  expect(await read(locator)).toEqual(selected);
  expect((await native.store().reserve(fixture.actor, fixture.collectionId, [selected])).intent).toBeNull();
  expect(
    await read({ ...locator, episodeId: native.locator(fixture.owner, fixture.collectionId).episodeId }),
  ).toBeNull();
  const [header] = await native.rows(fixture.owner);
  const expiry = new Date(header.last_read_at).getTime() + 24 * 60 * 60 * 1000;
  expect(await read(locator, () => new Date(expiry))).toBeNull();
  expect((await native.rows(fixture.owner))[0]).toMatchObject({ state: 'live', episode_id: locator.episodeId });
});

test('one finite request parent holds every child before native reservation and commits before Source dispatch', async () => {
  const f = await native.fixture();
  // Explicit finite test declarations exercise composition, not a release of native Source prices.
  const allowance = {
    candidateKeys: 100,
    nativeRows: 4096,
    identityMetadataRows: 8192,
    nativePoints: 4096,
    witnessKeys: 100,
    statements: 16,
    bytes: 4 * 1024 * 1024,
    emptySeeks: 4096,
  };
  const owners = Object.fromEntries(MEMBERS_PREPARATION_CHILDREN.map((name) => [name, allowance])) as Parameters<
    typeof declareMembersPreparationRequest
  >[0];
  const declared = declareMembersPreparationRequest(owners);
  expect(declared.children.history).toEqual(OPERATIONAL_WORK_LOCAL_DECLARATION);
  const parent = new NativeCollectionWork(
    { reservationId: 'whole-request', remaining: declared.total },
    Date.now() + 60_000,
  );
  const dependencies = { pool: native.db.pool, workClient: native.workClient, preparation: f.store };
  const input = { actor: f.actor, collectionId: f.collectionId, definition: definition(), parent, owners };
  let sources = 0;
  let cleanups = 0;
  await expect(
    runMembersPreparationRequest(
      dependencies,
      {
        ...input,
        owners: { ...owners, sourceResolve: null },
      },
      async () => {
        sources++;
      },
      async () => {
        cleanups++;
      },
    ),
  ).rejects.toMatchObject({ code: 'dependency_unavailable' });
  const short = new NativeCollectionWork({ reservationId: 'local-subtotal', remaining: allowance }, parent.deadlineAt);
  await expect(
    runMembersPreparationRequest(
      dependencies,
      { ...input, parent: short },
      async () => {
        sources++;
      },
      async () => {
        cleanups++;
      },
    ),
  ).rejects.toMatchObject({ code: 'dependency_unavailable' });
  expect(await native.rows(f.owner)).toHaveLength(0);
  expect(sources).toBe(0);
  expect(cleanups).toBe(0);
  let held: NativeCollectionWork | undefined;
  const admitted = await runMembersPreparationRequest(
    dependencies,
    input,
    async (request) => {
      sources++;
      held = request.children.sourceResolve;
      for (const axis of Object.keys(allowance) as (keyof typeof allowance)[]) expect(parent.available(axis)).toBe(0);
      expect(held.receipt().reservationId).toBe('whole-request');
      expect(request.history).not.toBeNull();
      // A different native client sees both copies only after the actual reservation COMMIT.
      expect((await native.rows(f.owner))[0]!.episode_id).toBe(request.episode.locator.episodeId);
      expect((await native.workflow(request.episode.workflowId)).status?.status).toBe('ENQUEUED');
      return request.episode;
    },
    async (_children, outcome) => {
      cleanups++;
      expect(outcome.ok).toBe(true);
    },
  );
  expect(sources).toBe(1);
  expect(cleanups).toBe(1);
  expect(() => held!.assertReady()).toThrow('allocation is closed');
  await expect(
    runMembersPreparationRequest(
      dependencies,
      input,
      async () => {
        sources++;
      },
      async () => {
        cleanups++;
      },
    ),
  ).rejects.toMatchObject({ code: 'dependency_unavailable' });
  expect(sources).toBe(1);
  expect(cleanups).toBe(1);
  const retryParent = new NativeCollectionWork(
    { reservationId: 'retry-request', remaining: declared.total },
    Date.now() + 60_000,
  );
  const duplicate = await runMembersPreparationRequest(
    dependencies,
    { ...input, parent: retryParent },
    async (request) => {
      expect(request.history).toBeNull();
      return request.episode;
    },
    async () => {},
  );
  expect(duplicate.value).toEqual(admitted.value);
  expect(await native.rows(f.owner)).toHaveLength(1);
  const failureParent = new NativeCollectionWork(
    { reservationId: 'failed-source', remaining: declared.total },
    Date.now() + 60_000,
  );
  const error = new Error('Source unavailable after reservation');
  await expect(
    runMembersPreparationRequest(
      dependencies,
      { ...input, parent: failureParent },
      async () => {
        throw error;
      },
      async (children, outcome) => {
        expect(outcome).toEqual({ ok: false, error });
        const cleanup = children.cleanup.reserve(allowance);
        cleanup.dispatch();
        cleanup.settle();
      },
    ),
  ).rejects.toBe(error);
  expect(Reflect.get(error, 'work')).toEqual(failureParent.receipt());
  expect((await native.rows(f.owner))[0]).toMatchObject({ state: 'live', complete: false });
});
