import { createHash } from 'node:crypto';
import { principalCommandIdentity } from '../../src/command/command.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import {
  beginCollectionSourceOutput,
  appendCollectionSourceOutput,
  completeCollectionSourceOutput,
} from '../../src/library/collection-source-output.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { runCommand, noEffect, type CommandTransaction, type AuthoritativeTime } from '../../src/command/command.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceIdentity,
  type NativeSourceFrontier,
  type NativeSourceDependency,
} from '../../src/library/native-source-custody.ts';
import type { NativePublicOutputIdentity } from '../../src/library/contract/native-public-output.ts';
import {
  nativeSourceCustodyOperationBound,
  nativeSourceCustodyWorkDimensions,
} from '../../src/library/native-source-custody-bounds.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import { partitionOf, routeOf, newId } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let native: NativeProfileFixture;
let custody: ReturnType<typeof createNativeLibrarySourceCustody>;
beforeAll(async () => {
  native = await createProfileEntryFixture();
  custody = createNativeLibrarySourceCustody({ pool: native.pool });
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  await native?.close();
});
const custodyOperations = [
  'capturePage',
  'finishCapture',
  'readAndHold',
  'revalidateHold',
  'releaseHold',
  'retireCapture',
] as const;
const custodyOperationBounds = custodyOperations.map((operation) =>
  nativeSourceCustodyWorkDimensions(nativeSourceCustodyOperationBound(operation)),
);
const custodyAllowance = custodyOperationBounds.reduce(
  (maximum, dimensions) => ({
    candidateKeys: Math.max(maximum.candidateKeys, dimensions.candidateKeys),
    nativeRows: Math.max(maximum.nativeRows, dimensions.nativeRows),
    identityMetadataRows: Math.max(maximum.identityMetadataRows, dimensions.identityMetadataRows),
    emptySeeks: Math.max(maximum.emptySeeks, dimensions.emptySeeks),
    nativePoints: Math.max(maximum.nativePoints, dimensions.nativePoints),
    witnessKeys: Math.max(maximum.witnessKeys, dimensions.witnessKeys),
    statements: Math.max(maximum.statements, dimensions.statements),
    bytes: Math.max(maximum.bytes, dimensions.bytes),
  }),
  custodyOperationBounds[0]!,
);
const work = () => ({
  deadline: Date.now() + 30000,
  allowance: {
    reservationId: entryKey(),
    remaining: custodyAllowance,
  },
});
async function make() {
  const owner = await native.identity(['subject:read', 'collection:create', 'collection:read', 'collection:update']);
  const response = await native.send(owner.bearer, 'POST', '/v1/collections', {
    title: 'Native custody',
    visibility: 'private',
  });
  expect(response.status).toBe(201);
  const collectionId = (await response.json()).collection.id as string;
  const route = routeOf(collectionId)!;
  const subjectId = await native.createSubject('game');
  const members: string[] = [];
  for (const note of ['first', 'second']) {
    const added = await native.send(owner.bearer, 'POST', `/v1/collections/${collectionId}/members`, {
      subjectId,
      note,
    });
    expect(added.status).toBe(201);
    members.push((await added.json()).member.id);
  }
  const metadata = await readNativeCollectionMetadata(native.pool, { route, collectionId }, work());
  if (!metadata.metadata) throw new Error('Missing committed native Collection');
  const partition = await native.pool.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [
    partitionOf(route),
  ]);
  const identity: NativeSourceIdentity = {
    route,
    collectionId,
    accountId: owner.actor.accountId,
    incarnation: metadata.metadata.incarnation,
    generation: metadata.metadata.sourceGeneration,
    scope: 'curated',
    ownerEpoch: partition.rows[0].epoch,
    receivingEpoch: '1',
    effectKey: entryKey(),
  };
  return { identity, owner, subjectId, members };
}
async function scan(identity: NativeSourceIdentity, initial: NativeSourceFrontier | null = null) {
  let frontier = initial;
  const rows: NativeSourceDependency[] = [];
  for (let page = 0; page < 100; page++) {
    const input = work();
    const result = await custody.capturePage({ ...input, identity, frontier, limit: 1 });
    if (result.status !== 'pending')
      throw new Error(
        `Native capture unavailable: ${result.reason}; used=${JSON.stringify(result.work.used)}; ` +
          `allowance=${JSON.stringify(input.allowance.remaining)}; ` +
          `captureBound=${JSON.stringify(
            nativeSourceCustodyWorkDimensions(nativeSourceCustodyOperationBound('capturePage')),
          )}`,
      );
    expect(result.work.used.nativeRows).toBeGreaterThan(result.rows.length);
    expect(result.work.used.statements).toBeGreaterThan(0);
    rows.push(...result.rows);
    frontier = result.frontier;
    if (frontier.driver === 'done') return { frontier, rows };
  }
  throw new Error('Native scan did not exhaust its finite raw fixture');
}
async function command<T>(
  identity: NativeSourceIdentity,
  action: (client: CommandTransaction, at: AuthoritativeTime) => Promise<T>,
) {
  return runCommand(
    native.pool,
    { partition: partitionOf(identity.route), deadline: Date.now() + 30000 },
    async (client, context) => {
      const value = await action(client, context.time);
      return {
        value,
        events: [{ type: 'com.rezics.library.collection.updated.v1', data: { collectionId: identity.collectionId } }],
      };
    },
  );
}

test('Native source capture binds complete raw dependency coverage and read-held custody to committed owner records and rejects stale source or writer fences', async () => {
  const source = await make();
  const { identity, subjectId } = source;
  const route = routeOf(identity.accountId)!;
  const session = newId(route),
    label = newId(route),
    copy = newId(route),
    log = newId(route),
    transaction = entryKey();
  // Real committed owner rows include an excluded assignment and child facts, never a custody fixture table.
  const client = await native.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,'planned',1,now(),now(),$4)",
      [route, identity.accountId, subjectId, transaction],
    );
    await client.query(
      "INSERT INTO library.personal_label(route,account_id,label_id,normalized_name,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,'custody label',1,now(),now(),$4)",
      [route, identity.accountId, label, transaction],
    );
    await client.query(
      "INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,revision,created_at,updated_at,transaction_id,deleted_at,purge_after) VALUES($1,$2,$3,$4,1,now(),now(),$5,now(),now()+interval '30 days')",
      [route, identity.accountId, subjectId, label, transaction],
    );
    await client.query(
      "INSERT INTO library.progress_session(route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,transaction_id) VALUES($1,$2,$3,$4,'completed_units','chapter',0,'active',1,now(),$5)",
      [route, session, identity.accountId, subjectId, transaction],
    );
    await client.query(
      "INSERT INTO library.progress_unit(route,session_id,unit_id,added_at) VALUES($1,$2,'chapter one',now())",
      [route, session],
    );
    await client.query(
      "INSERT INTO library.progress_change(route,session_id,change_no,intent,recorded_at,transaction_id) VALUES($1,$2,1,'{}',now(),$3)",
      [route, session, transaction],
    );
    await client.query(
      "INSERT INTO library.copy(route,copy_id,account_id,subject_id,status,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,'owned',1,now(),now(),$5)",
      [route, copy, identity.accountId, subjectId, transaction],
    );
    await client.query(
      "INSERT INTO library.published_log(route,log_id,account_id,session_id,subject_id,session_state,started_at,published_at,transaction_id) VALUES($1,$2,$3,$4,$5,'active',now(),now(),$6)",
      [route, log, identity.accountId, session, subjectId, transaction],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const { frontier, rows } = await scan(identity);
  for (const driver of ['member', 'entry', 'label', 'assignment', 'session', 'unit', 'change', 'copy', 'output'])
    expect(rows.some((row) => row.driver === driver)).toBe(true);
  expect(frontier.scanned).toBe(String(rows.length));
  expect(rows.filter((row) => row.driver === 'member').map((row) => row.tie)).toEqual(source.members);
  const complete = await custody.finishCapture({ ...work(), identity, frontier });
  expect(complete.status).toBe('complete');
  if (complete.status !== 'complete') throw new Error('Missing native receipt');
  const holdId = entryKey();
  const held = await command(identity, (client, at) =>
    custody.readAndHold({ ...work(), client, at, identity, captureId: complete.capture.captureId, holdId }),
  );
  expect(held.value.status).toBe('held');
  // A fresh factory/serialized locator must reread durable native provenance, rather than a local token registry.
  custody = createNativeLibrarySourceCustody({ pool: native.pool });
  const released = await command(identity, async (client, at) => {
    const input = { ...work(), client, at, identity, captureId: complete.capture.captureId, holdId };
    expect((await custody.releaseHold(input)).status).toBe('released');
    return custody.releaseHold({ ...input, ...work() });
  });
  expect(released.value.status).toBe('released');
  expect(
    (
      await native.pool.query(
        'SELECT count(*)::integer AS n FROM library.collection_member WHERE route=$1 AND collection_id=$2',
        [identity.route, identity.collectionId],
      )
    ).rows[0].n,
  ).toBe(2);
});

test('altered source incarnation generation scope owner receiving epoch and effect never manufacture held custody', async () => {
  const { identity } = await make();
  const { frontier } = await scan(identity);
  const complete = await custody.finishCapture({ ...work(), identity, frontier });
  if (complete.status !== 'complete') throw new Error('Missing committed capture');
  const altered: NativeSourceIdentity[] = [
    { ...identity, incarnation: identity.incarnation + 'x' },
    { ...identity, generation: String(BigInt(identity.generation) + 1n) },
    { ...identity, scope: 'private_builtin' },
    { ...identity, ownerEpoch: identity.ownerEpoch + 1 },
    { ...identity, receivingEpoch: '2' },
    { ...identity, effectKey: entryKey() },
  ];
  for (const changed of altered) {
    const result = await runCommand(native.pool, { partition: partitionOf(identity.route) }, async (client, { time }) =>
      noEffect(
        await custody.readAndHold({
          ...work(),
          client,
          at: time,
          identity: changed,
          captureId: complete.capture.captureId,
          holdId: entryKey(),
        }),
      ),
    );
    expect(result.value.status).toBe('unavailable');
  }
  const empty = {
    ...work(),
    allowance: { reservationId: entryKey(), remaining: { ...work().allowance.remaining, nativeRows: 0 } },
  };
  expect((await custody.capturePage({ ...empty, identity, frontier: null, limit: 1 })).status).toBe('unavailable');
});

test('intervening child writer and native ordinal reorder invalidate complete capture even without a source generation increment', async () => {
  const { identity, members, subjectId } = await make();
  const { frontier } = await scan(identity);
  await native.pool.query(
    'UPDATE library.collection_member SET ordinal_key=$4 WHERE route=$1 AND collection_id=$2 AND member_id=$3',
    [identity.route, identity.collectionId, members[0], '0'],
  );
  const refused = await custody.finishCapture({ ...work(), identity, frontier });
  expect(refused.status).toBe('unavailable');
  if (refused.status === 'unavailable') expect(refused.reason).toBe('writer');
  const next = await scan(identity);
  await native.pool.query(
    "INSERT INTO library.copy(route,copy_id,account_id,subject_id,status,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,'owned',1,now(),now(),$5)",
    [identity.route, newId(identity.route), identity.accountId, subjectId, entryKey()],
  );
  const child = await custody.finishCapture({ ...work(), identity, frontier: next.frontier });
  expect(child.status).toBe('unavailable');
  if (child.status === 'unavailable') expect(child.reason).toBe('writer');
  const barrier = await scan(identity);
  await native.pool.query(
    'UPDATE library.fact_source_head SET generation=generation+1 WHERE route=$1 AND account_id=$2',
    [identity.route, identity.accountId],
  );
  const finalWriter = await custody.finishCapture({ ...work(), identity, frontier: barrier.frontier });
  expect(finalWriter.status).toBe('unavailable');
  if (finalWriter.status === 'unavailable') expect(finalWriter.reason).toBe('writer');
});

test('An exact already retained native Source hold can be revalidated after source generation changes without acquiring new read authority or accepting altered custody', async () => {
  const { identity, members } = await make();
  const { frontier } = await scan(identity);
  const complete = await custody.finishCapture({ ...work(), identity, frontier });
  if (complete.status !== 'complete') throw new Error('Missing committed capture');
  const captureId = complete.capture.captureId;
  const holdId = entryKey();
  const held = await command(identity, (client, at) =>
    custody.readAndHold({ ...work(), client, at, identity, captureId, holdId }),
  );
  if (held.value.status !== 'held') throw new Error('Missing retained hold');
  const original = held.value.custody;
  const holdRow = () =>
    native.pool.query(
      'SELECT *,xmin::text AS version FROM library.native_source_hold WHERE route=$1 AND capture_id=$2 AND hold_id=$3',
      [identity.route, captureId, holdId],
    );
  const before = (await holdRow()).rows;
  // A native child write changes the writer fence independently of the Source generation.
  await native.pool.query(
    'UPDATE library.collection_member SET ordinal_key=$4 WHERE route=$1 AND collection_id=$2 AND member_id=$3',
    [identity.route, identity.collectionId, members[0], '0'],
  );
  const staleWriter = await command(identity, (client, at) =>
    custody.readAndHold({ ...work(), client, at, identity, captureId, holdId: entryKey() }),
  );
  expect(staleWriter.value.status).toBe('unavailable');
  if (staleWriter.value.status === 'unavailable') expect(staleWriter.value.reason).toBe('writer');
  const retainedWriter = await command(identity, (client, at) =>
    custody.revalidateHold({ ...work(), client, at, identity, captureId, holdId }),
  );
  expect(retainedWriter.value.status).toBe('held');
  await native.pool.query(
    'UPDATE library.collection SET source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2',
    [identity.route, identity.collectionId],
  );
  // A fresh factory and JSON locator still have to reread real native provenance.
  custody = createNativeLibrarySourceCustody({ pool: native.pool });
  const locator = JSON.parse(JSON.stringify({ identity, captureId, holdId }));
  const reservation = work();
  const retained = await command(identity, (client, at) =>
    custody.revalidateHold({ ...reservation, ...locator, client, at }),
  );
  expect(retained.value.status).toBe('held');
  if (retained.value.status !== 'held') throw new Error('Existing custody lost after native mutation');
  expect(retained.value.custody).toEqual(original);
  expect(retained.value.work.reservationId).toBe(reservation.allowance.reservationId);
  expect(retained.value.work.used.statements).toBeGreaterThan(0);
  expect(retained.value.work.used.nativePoints).toBeGreaterThan(0);
  expect(retained.value.work.used.candidateKeys).toBe(0);
  for (const axis of Object.keys(reservation.allowance.remaining) as (keyof typeof reservation.allowance.remaining)[])
    expect(retained.value.work.used[axis]).toBeLessThanOrEqual(reservation.allowance.remaining[axis]);
  expect((await holdRow()).rows).toEqual(before);
  const staleRead = await command(identity, (client, at) =>
    custody.readAndHold({ ...work(), client, at, identity, captureId, holdId: entryKey() }),
  );
  expect(staleRead.value.status).toBe('unavailable');
  if (staleRead.value.status === 'unavailable') expect(staleRead.value.reason).toBe('binding');
  expect((await custody.finishCapture({ ...work(), identity, frontier })).status).toBe('unavailable');
  const newGeneration = { ...identity, generation: String(BigInt(identity.generation) + 1n) };
  const converted = await command(identity, (client, at) =>
    custody.revalidateHold({ ...work(), client, at, identity: newGeneration, captureId, holdId }),
  );
  expect(converted.value.status).toBe('unavailable');
  const released = await command(identity, (client, at) =>
    custody.releaseHold({ ...work(), client, at, identity, captureId, holdId }),
  );
  expect(released.value.status).toBe('released');
  const recreated = await command(identity, (client, at) =>
    custody.revalidateHold({ ...work(), client, at, identity, captureId, holdId }),
  );
  expect(recreated.value.status).toBe('unavailable');
  expect((await holdRow()).rows[0].released).toBe(true);
});

test('retained revalidation refuses fresh absent foreign and altered native hold provenance without creating custody', async () => {
  const { identity } = await make();
  const { frontier } = await scan(identity);
  const complete = await custody.finishCapture({ ...work(), identity, frontier });
  if (complete.status !== 'complete') throw new Error('Missing committed capture');
  const captureId = complete.capture.captureId;
  const holdId = entryKey();
  const binding = { identity, captureId, holdId };
  const fresh = await command(identity, async (client, at) => {
    expect((await custody.revalidateHold({ ...work(), ...binding, client, at })).status).toBe('unavailable');
    expect((await custody.readAndHold({ ...work(), ...binding, client, at })).status).toBe('held');
    return custody.revalidateHold({ ...work(), ...binding, client, at });
  });
  expect(fresh.value.status).toBe('unavailable');
  expect(
    (await command(identity, (client, at) => custody.revalidateHold({ ...work(), ...binding, client, at }))).value
      .status,
  ).toBe('held');
  const other = await make();
  const otherCapture = await scan(other.identity);
  const otherComplete = await custody.finishCapture({ ...work(), identity: other.identity, ...otherCapture });
  if (otherComplete.status !== 'complete') throw new Error('Missing foreign capture');
  const changed = [
    { ...binding, identity: { ...identity, incarnation: identity.incarnation + 'x' } },
    { ...binding, identity: { ...identity, scope: 'private_builtin' as const } },
    { ...binding, identity: { ...identity, ownerEpoch: identity.ownerEpoch + 1 } },
    { ...binding, identity: { ...identity, receivingEpoch: '2' } },
    { ...binding, identity: { ...identity, effectKey: entryKey() } },
    { ...binding, identity: { ...identity, accountId: other.identity.accountId } },
    { ...binding, captureId: otherComplete.capture.captureId },
    { ...binding, holdId: entryKey() },
  ];
  for (const altered of changed) {
    const refused = await command(identity, (client, at) =>
      custody.revalidateHold({ ...work(), ...altered, client, at }),
    );
    expect(refused.value.status).toBe('unavailable');
  }
  const empty = work();
  const depleted = await command(identity, (client, at) =>
    custody.revalidateHold({
      ...empty,
      ...binding,
      client,
      at,
      allowance: { ...empty.allowance, remaining: { ...empty.allowance.remaining, nativeRows: 0 } },
    }),
  );
  expect(depleted.value.status).toBe('unavailable');
  expect(depleted.value.work.used.statements).toBe(0);
  const expired = await command(identity, (client, at) =>
    custody.revalidateHold({ ...work(), ...binding, client, at, deadline: Date.now() - 1 }),
  );
  expect(expired.value.status).toBe('unavailable');
  expect(expired.value.work.used.statements).toBe(0);
  // A changed native capture no longer shares the immutable receipt's native transaction.
  await native.pool.query('UPDATE library.native_source_capture SET effect_key=$3 WHERE route=$1 AND capture_id=$2', [
    identity.route,
    captureId,
    entryKey(),
  ]);
  const alteredCapture = await native.pool.query(
    'SELECT effect_key FROM library.native_source_capture WHERE route=$1 AND capture_id=$2',
    [identity.route, captureId],
  );
  const forgedBinding = { ...identity, effectKey: alteredCapture.rows[0].effect_key };
  const refusedCapture = await command(identity, (client, at) =>
    custody.revalidateHold({ ...work(), ...binding, identity: forgedBinding, client, at }),
  );
  expect(refusedCapture.value.status).toBe('unavailable');
  // Corrupting the hold's receipt reference is separately refused on an untouched capture.
  const foreignHold = entryKey();
  const foreignBinding = { identity: other.identity, captureId: otherComplete.capture.captureId, holdId: foreignHold };
  expect(
    (await command(other.identity, (client, at) => custody.readAndHold({ ...work(), ...foreignBinding, client, at })))
      .value.status,
  ).toBe('held');
  await native.pool.query(
    'UPDATE library.native_source_hold SET transaction_id=$4 WHERE route=$1 AND capture_id=$2 AND hold_id=$3',
    [other.identity.route, foreignBinding.captureId, foreignHold, entryKey()],
  );
  const refusedHold = await command(other.identity, (client, at) =>
    custody.revalidateHold({ ...work(), ...foreignBinding, client, at }),
  );
  expect(refusedHold.value.status).toBe('unavailable');
  expect(
    (
      await native.pool.query(
        'SELECT count(*)::integer AS n FROM library.native_source_hold WHERE route=$1 AND capture_id=$2',
        [identity.route, captureId],
      )
    ).rows[0].n,
  ).toBe(1);
});

test('retirement requires a matching live command T and actual deleted/due or terminal authority, never a capture locator alone', async () => {
  const { identity } = await make(),
    { frontier } = await scan(identity);
  const completed = await custody.finishCapture({ ...work(), identity, frontier });
  if (completed.status !== 'complete') throw new Error('Missing native capture');
  const input = { ...work(), identity, captureId: completed.capture.captureId, sourceGeneration: identity.generation };
  const forgedEpisode = {
    kind: 'deleted' as const,
    deletionId: entryKey(),
    revision: 2,
    purgeAfter: new Date(0).toISOString(),
  };
  const active = await command(identity, (client, at) =>
    custody.retireCapture({ ...input, client, at, episode: forgedEpisode }),
  );
  expect(active.value).toMatchObject({ status: 'blocked', reason: 'source' });
  expect(active.value.work.used.statements).toBeGreaterThan(0);
  const terminal = await command(identity, (client, at) =>
    custody.retireCapture({ ...input, client, at, episode: { kind: 'terminal' } }),
  );
  expect(terminal.value.status).toBe('unavailable');
  let staleTime!: AuthoritativeTime;
  await command(identity, async (_client, at) => {
    staleTime = at;
    return true;
  });
  const stale = await command(identity, (client) =>
    custody.retireCapture({ ...input, client, at: staleTime, episode: forgedEpisode }),
  );
  expect(stale.value.status).toBe('unavailable');
  expect(stale.value.work.used.statements).toBe(0);
  const depleted = work();
  const refused = await command(identity, (client, at) =>
    custody.retireCapture({
      ...input,
      client,
      at,
      episode: forgedEpisode,
      allowance: { ...depleted.allowance, remaining: { ...depleted.allowance.remaining, nativeRows: 0 } },
    }),
  );
  expect(refused.value.status).toBe('unavailable');
  expect(refused.value.work.used.statements).toBe(0);
  expect(
    (
      await native.pool.query('SELECT 1 FROM library.native_source_capture WHERE route=$1 AND capture_id=$2', [
        identity.route,
        input.captureId,
      ])
    ).rows,
  ).toHaveLength(1);
});

// Uses the existing native fixture and actual saved-Collection API, never a ready-output fixture or a second
// custody harness. An unavailable upstream saved-source producer remains an upstream acceptance prerequisite.
async function explicitSource() {
  const owner = await native.identity([
    'subject:read',
    'collection:create',
    'collection:read',
    'collection:update',
    'library_entry:read',
  ]);
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/personal_library:open')).status).toBe(200);
  const response = await native.send(owner.bearer, 'POST', '/v1/collections', {
    membershipKind: 'dynamic',
    title: 'Native explicit output',
    visibility: 'public',
    rule: { filter: { owner: { presence: true } } },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const collectionId = (await response.json()).collection.id as string;
  const ref = { route: routeOf(collectionId)!, collectionId };
  const output = async <T>(input: unknown, body: (tx: CommandTransaction) => Promise<T>) => {
    const deadline = Date.now() + 30000;
    return runCommand(
      native.pool,
      {
        ...principalCommandIdentity(owner.actor),
        partition: partitionOf(ref.route),
        deadline,
        authorization: resourceAuthorization({
          access: native.access,
          actor: owner.actor,
          action: 'collection:update',
          anchor: {
            resource: { route: ref.route, id: collectionId },
            async validate(tx) {
              return (
                (
                  await tx.query('SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2', [
                    ref.route,
                    collectionId,
                  ])
                ).rows.length === 1
              );
            },
          },
          context: { pool: native.pool, partition: partitionOf(ref.route), deadline },
        }),
        receipt: {
          kind: 'library.collection.explicit-output',
          key: entryKey(),
          digest: createHash('sha256').update(JSON.stringify(input)).digest(),
        },
      },
      async (tx) => ({
        value: (await body(tx)) ?? null,
        events: [{ type: 'com.rezics.library.collection.updated.v1', subject: collectionId, data: { collectionId } }],
      }),
    );
  };
  const observe = async () => {
    const { metadata } = await readNativeCollectionMetadata(native.pool, ref, work());
    if (!metadata) throw new Error('Missing native explicit-output source');
    return metadata;
  };
  const identity = async (): Promise<Extract<NativeSourceIdentity, { scope: 'active_explicit_output' }>> => {
    const metadata = await observe(),
      proof = metadata.outputPublication;
    if (!proof) throw new Error('Missing committed native output publication');
    return {
      ...ref,
      accountId: owner.actor.accountId,
      incarnation: metadata.incarnation,
      generation: metadata.sourceGeneration,
      scope: 'active_explicit_output',
      ownerEpoch: metadata.stamp.epoch,
      receivingEpoch: '1',
      effectKey: entryKey(),
      outputGeneration: proof.generation,
      publicationTransactionId: proof.transactionId,
      publicationPosition: proof.position,
    };
  };
  return { owner, ref, output, observe, identity };
}

test('Native Source capture can bind an actual active explicit COMPLETE Collection output generation and committed publication provenance without borrowing public catalogue capture or accepting pending output', async () => {
  const source = await explicitSource(),
    a = { ...source.ref, generation: entryKey() },
    b = { ...source.ref, generation: entryKey() };
  const ids = [await native.createSubject('game'), await native.createSubject('recipe')].sort();
  await source.output({ begin: a }, (tx) => beginCollectionSourceOutput(tx, { ...a, expectedMembers: ids.length }));
  expect((await source.observe()).authority).toBe('unavailable_output');
  await source.output({ append: a }, (tx) => appendCollectionSourceOutput(tx, { ...a, after: null, subjectIds: ids }));
  const publication = await source.output({ complete: a }, (tx) => completeCollectionSourceOutput(tx, a));
  const identity = await source.identity();
  expect(identity.publicationTransactionId).toBe(publication.transactionId);
  expect(identity.publicationPosition).toBe(publication.position.toString());
  expect((await source.observe()).authority).toBe('activated_output');
  await source.output({ begin: b }, (tx) => beginCollectionSourceOutput(tx, { ...b, expectedMembers: 1 }));
  await source.output({ append: b }, (tx) =>
    appendCollectionSourceOutput(tx, { ...b, after: null, subjectIds: [ids[0]!] }),
  );
  const captured = await scan(identity);
  expect(captured.rows.map((row) => [row.driver, row.key, row.tie, row.subjectId, row.transactionId])).toEqual(
    ids.map((id) => ['output', id, '', id, publication.transactionId]),
  );
  const complete = await custody.finishCapture({ ...work(), identity, frontier: captured.frontier });
  expect(complete.status).toBe('complete');
  if (complete.status !== 'complete') throw new Error('Missing native output capture');
  expect(complete.capture.scanned).toBe(String(ids.length));
  const binding = { identity, captureId: complete.capture.captureId, holdId: entryKey() };
  expect(
    (await command(identity, (client, at) => custody.readAndHold({ ...work(), ...binding, client, at }))).value.status,
  ).toBe('held');
  // Reopening the native owner and serializing locators cannot manufacture or lose committed provenance.
  custody = createNativeLibrarySourceCustody({ pool: native.pool });
  expect(
    (
      await command(identity, (client, at) =>
        custody.revalidateHold({ ...work(), ...JSON.parse(JSON.stringify(binding)), client, at }),
      )
    ).value.status,
  ).toBe('held');
  for (const changed of [
    { ...identity, outputGeneration: b.generation },
    { ...identity, outputGeneration: entryKey() },
    { ...identity, publicationTransactionId: entryKey() },
    { ...identity, publicationPosition: String(BigInt(identity.publicationPosition) + 1n) },
    { ...identity, generation: String(BigInt(identity.generation) + 1n) },
    { ...identity, receivingEpoch: '2' },
    { ...identity, effectKey: entryKey() },
  ]) {
    expect(
      (
        await command(identity, (client, at) =>
          custody.readAndHold({ ...work(), ...binding, identity: changed, client, at }),
        )
      ).value.status,
    ).toBe('unavailable');
  }
  // Selecting real B invalidates every fresh use of A, while exact already held A retains its obligation.
  await source.output({ complete: b }, (tx) => completeCollectionSourceOutput(tx, b));
  expect((await custody.finishCapture({ ...work(), identity, frontier: captured.frontier })).status).toBe(
    'unavailable',
  );
  expect(
    (
      await command(identity, (client, at) =>
        custody.readAndHold({ ...work(), ...binding, client, at, holdId: entryKey() }),
      )
    ).value.status,
  ).toBe('unavailable');
  expect(
    (await command(identity, (client, at) => custody.revalidateHold({ ...work(), ...binding, client, at }))).value
      .status,
  ).toBe('held');
  expect(
    (await command(identity, (client, at) => custody.releaseHold({ ...work(), ...binding, client, at }))).value.status,
  ).toBe('released');
});

test('actual output final fences reject raw rekey, unpublish, owner T and frozen authority while preserving ordinary capture', async () => {
  const source = await explicitSource(),
    a = { ...source.ref, generation: entryKey() };
  const id = await native.createSubject('game'),
    rekey = await native.createSubject('recipe');
  await source.output({ begin: a }, (tx) => beginCollectionSourceOutput(tx, { ...a, expectedMembers: 1 }));
  await source.output({ append: a }, (tx) => appendCollectionSourceOutput(tx, { ...a, after: null, subjectIds: [id] }));
  await source.output({ complete: a }, (tx) => completeCollectionSourceOutput(tx, a));
  const identity = await source.identity(),
    captured = await scan(identity);
  await native.pool.query(
    'UPDATE library.collection_source_output_member SET subject_id=$4 WHERE route=$1 AND collection_id=$2 AND generation=$3',
    [identity.route, identity.collectionId, a.generation, rekey],
  );
  expect((await custody.finishCapture({ ...work(), identity, frontier: captured.frontier })).status).toBe(
    'unavailable',
  );
  expect((await source.observe()).authority).toBe('unavailable_output');
  await native.pool.query(
    "UPDATE library.collection SET visibility='private',source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2",
    [identity.route, identity.collectionId],
  );
  expect((await custody.capturePage({ ...work(), identity, frontier: null, limit: 1 })).status).toBe('unavailable');
  await native.pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
    routeOf(identity.accountId),
    identity.accountId,
  ]);
  expect((await custody.capturePage({ ...work(), identity, frontier: null, limit: 1 })).status).toBe('unavailable');
  await expect(
    source.output({ late: true }, (tx) =>
      beginCollectionSourceOutput(tx, { ...a, generation: entryKey(), expectedMembers: 0 }),
    ),
  ).rejects.toThrow();
  await native.pool.query(
    "UPDATE library.collection SET visibility='public',curator_account_id=NULL WHERE route=$1 AND collection_id=$2",
    [identity.route, identity.collectionId],
  );
  expect((await custody.capturePage({ ...work(), identity, frontier: null, limit: 1 })).status).toBe('unavailable');
  expect(
    (
      await native.pool.query(
        'SELECT 1 FROM library.collection_source_output_publication WHERE route=$1 AND collection_id=$2 AND generation=$3',
        [identity.route, identity.collectionId, a.generation],
      )
    ).rows,
  ).toHaveLength(1);
  const ordinary = await make(),
    ordinaryCapture = await scan(ordinary.identity);
  expect(
    (await custody.finishCapture({ ...work(), identity: ordinary.identity, frontier: ordinaryCapture.frontier }))
      .status,
  ).toBe('complete');
});

test('unchanged COMPLETE metadata cannot hide an intervening native publication source fence', async () => {
  const source = await explicitSource(),
    a = { ...source.ref, generation: entryKey() };
  await source.output({ begin: a }, (tx) => beginCollectionSourceOutput(tx, { ...a, expectedMembers: 0 }));
  await source.output({ complete: a }, (tx) => completeCollectionSourceOutput(tx, a));
  const identity = await source.identity(),
    captured = await scan(identity);
  await native.pool.query(
    "UPDATE library.native_source_fence SET generation=generation+1 WHERE route=$1 AND kind='collection' AND owner_id=$2",
    [identity.route, identity.collectionId],
  );
  expect((await source.observe()).authority).toBe('unavailable_output');
  expect((await custody.finishCapture({ ...work(), identity, frontier: captured.frontier })).status).toBe(
    'unavailable',
  );
  expect((await custody.capturePage({ ...work(), identity, frontier: null, limit: 1 })).status).toBe('unavailable');
});

test('account source capture refuses a public output identity instead of treating it as active explicit output', async () => {
  const source = await make();
  const publicOutput: NativePublicOutputIdentity = {
    scope: 'public_output',
    route: source.identity.route,
    collectionId: source.identity.collectionId,
    incarnation: source.identity.incarnation,
    generation: source.identity.generation,
    ownerEpoch: source.identity.ownerEpoch,
    receivingEpoch: source.identity.receivingEpoch,
    effectKey: 'a'.repeat(64),
    outputGeneration: entryKey(),
    activation: { transactionId: entryKey(), position: '1', sourceGeneration: '1' },
  };
  const captured = await custody.capturePage({ ...work(), identity: publicOutput, frontier: null, limit: 1 });
  expect(captured).toMatchObject({ status: 'unavailable', reason: 'output_authority' });
  const account = await custody.capturePage({ ...work(), identity: source.identity, frontier: null, limit: 1 });
  expect(account.status).toBe('pending');
});
