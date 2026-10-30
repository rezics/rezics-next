import { afterAll, beforeAll, expect, test } from 'bun:test';
import { runCommand, noEffect, type CommandTransaction, type AuthoritativeTime } from '../../src/command/command.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceIdentity,
  type NativeSourceFrontier,
  type NativeSourceDependency,
} from '../../src/library/native-source-custody.ts';
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
const work = () => ({
  deadline: Date.now() + 30000,
  allowance: {
    reservationId: entryKey(),
    remaining: {
      candidateKeys: 100,
      identityMetadataRows: 0,
      nativeRows: 100000,
      nativePoints: 1000,
      witnessKeys: 100,
      statements: 100,
      bytes: 1024 * 1024,
      emptySeeks: 100,
    },
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
    const result = await custody.capturePage({ ...work(), identity, frontier, limit: 1 });
    if (result.status !== 'pending') throw new Error(`Native capture unavailable: ${result.reason}`);
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
