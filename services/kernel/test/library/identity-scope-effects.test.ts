import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { principalCommandIdentity, noEffect, runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import {
  stepIdentityEpochBootstrapWork,
  readIdentityEpochCutover,
} from '../../src/semantic/identity-epoch-bootstrap.ts';
import { createLibraryIdentityNativePlanner } from '../../src/library/module.ts';
import { libraryIdentityCommand } from '../../src/library/identity-native-planner.ts';
import {
  bindLibraryIdentityDeadline,
  libraryIdentityFootprint,
} from '../../src/library/identity-native-planner-work.ts';
import { libraryIdentitySQL } from '../../src/library/identity-native-planner-statements.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import {
  beginCollectionSourceOutput,
  appendCollectionSourceOutput,
  completeCollectionSourceOutput,
} from '../../src/library/collection-source-output.ts';
import type { NativeSourceIdentity } from '../../src/library/native-source-custody.ts';
import type {
  LibraryScopeEffectsKey,
  LibraryScopeEffectSeal,
  LibraryExpectedEffectAfter,
} from '../../src/library/identity-scope-effects.ts';
import type { IdentityJobRef } from '../../src/semantic/identity-epoch-contract.ts';
import type { WorkReceipt } from '../../src/library/collection-source.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { epochFixture, digest, release, type EpochFixture } from '../semantic/support/identity-epoch.ts';

let native: NativeProfileFixture, semantic: EpochFixture, job: IdentityJobRef;
let original: string, terminal: string;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let planner: ReturnType<typeof createLibraryIdentityNativePlanner>;
const route = 0x5d10,
  home = partitionOf(route);
const budget = () => ({
  deadline: Date.now() + 30_000,
  allowance: {
    reservationId: randomUUID(),
    remaining: {
      candidateKeys: 1000,
      nativeRows: 100000,
      identityMetadataRows: 10000,
      nativePoints: 10000,
      witnessKeys: 0,
      statements: 2000,
      bytes: 16 * 1024 * 1024,
      emptySeeks: 1000,
    },
  },
});
function charged(work: WorkReceipt) {
  expect(Object.keys(work.used).sort()).toEqual(Object.keys(budget().allowance.remaining).sort());
  for (const value of Object.values(work.used)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
  expect(work.used.statements).toBeGreaterThan(0);
  expect(work.used.nativeRows).toBeGreaterThan(0);
  expect(work.used.bytes).toBeGreaterThan(0);
  expect(work.used.witnessKeys).toBe(0);
}
beforeAll(async () => {
  native = await createProfileEntryFixture();
  semantic = await epochFixture(undefined, { pool: native.pool });
  planner = createLibraryIdentityNativePlanner({ pool: native.pool });
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/personal_library:open')).status).toBe(200);
  original = (await semantic.create('Original native scope', route)).id;
  terminal = (await semantic.create('Destination native scope', route)).id;
  // Use the existing native bootstrap/admission protocol, never a fabricated job/receipt/claim.
  for (let page = 0; page < 100_000; page++) {
    if (!(await stepIdentityEpochBootstrapWork(native.pool))) break;
    if (page === 99_999) throw new Error('Finite native bootstrap did not settle');
  }
  expect((await readIdentityEpochCutover(native.pool)).state).toBe('ready');
  const actor = await semantic.actor();
  const authority = {
    basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
    authorization: await semantic.authorization('subject:merge'),
  };
  const key = randomUUID();
  const intent = { kind: 'merge' as const, redirected: original, survivor: terminal, release: release.digest };
  const receipt = {
    kind: 'subject.merge' as const,
    command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
  };
  const binding = await identityEpochStore.bindReceipt(native.pool, authority, { intent, receipt });
  job = (
    await runCommand(native.pool, { ...authority, partition: binding.jobHome }, (tx) =>
      identityEpochStore.admit(tx, { intent, receipt, binding }),
    )
  ).value;
  expect((await identityEpochStore.readJob(native.pool, job))?.state).toBe('pending');
  owner = await native.identity(
    ['subject:read', 'collection:create', 'collection:read', 'collection:update', 'library_entry:read'],
    home,
    route,
  );
}, 600_000);
afterAll(async () => {
  await semantic?.close();
  await native?.close();
});

async function collection(kind: 'curated' | 'private' | 'output') {
  if (kind === 'private') {
    // Actual retained native builtin, as in custody tests' raw legacy fact fixtures. No ready Source is seeded.
    const collectionId = newId(route);
    await native.pool.query(
      `INSERT INTO library.collection
      (route,collection_id,curator_account_id,title,visibility,membership_kind,builtin_kind,builtin_release_digest,created_at,updated_at,transaction_id,state,revision)
      VALUES($1,$2,$3,'Private native coverage','private','dynamic','everything',$4,now(),now(),$5,'active',1)`,
      [route, collectionId, owner.actor.accountId, native.originalDigest, randomUUID()],
    );
    return collectionId;
  }
  const response = await native.send(owner.bearer, 'POST', '/v1/collections', {
    title: 'Native effect coverage',
    visibility: kind === 'output' ? 'public' : 'private',
    ...(kind === 'output' ? { membershipKind: 'dynamic', rule: { filter: { owner: { presence: true } } } } : {}),
  });
  expect(response.status).toBe(201);
  return (await response.json()).collection.id as string;
}
async function identity(collectionId: string): Promise<NativeSourceIdentity> {
  const { metadata } = await readNativeCollectionMetadata(native.pool, { route, collectionId }, budget());
  if (!metadata) throw new Error('Missing actual native Collection');
  const base = {
    route,
    collectionId,
    accountId: owner.actor.accountId,
    incarnation: metadata.incarnation,
    generation: metadata.sourceGeneration,
    ownerEpoch: metadata.stamp.epoch,
    receivingEpoch: job.epoch.toString(),
    effectKey: randomUUID(),
  };
  if (metadata.authority === 'activated_output') {
    const publication = metadata.outputPublication!;
    return {
      ...base,
      scope: 'active_explicit_output',
      outputGeneration: publication.generation,
      publicationTransactionId: publication.transactionId,
      publicationPosition: publication.position,
    };
  }
  return { ...base, scope: metadata.authority === 'curated' ? 'curated' : 'private_builtin' };
}
async function member(collectionId: string, subjectId = original, ordinal = 'a0', note = 'Original note') {
  const id = newId(route);
  await native.pool.query(
    `INSERT INTO library.collection_member
    (route,collection_id,member_id,subject_id,ordinal_key,note,added_at,transaction_id,member_revision)
    VALUES($1,$2,$3,$4,$5,$6,now(),$7,1)`,
    [route, collectionId, id, subjectId, ordinal, note, randomUUID()],
  );
  return id;
}
async function seal(key: LibraryScopeEffectsKey) {
  for (let page = 0; page < 200; page++) {
    const result = await planner.advance({ ...key, ...budget(), limit: 1 });
    charged(result.work);
    if (result.status === 'sealed') return;
    expect(result.status).toBe('pending');
  }
  throw new Error('Finite six-driver native plan did not seal');
}
async function effects(key: LibraryScopeEffectsKey) {
  let after: LibraryExpectedEffectAfter | null = null;
  const rows = [];
  for (let page = 0; page < 100; page++) {
    const result = await planner.readPage({ ...key, ...budget(), after, limit: 1 });
    charged(result.work);
    if (result.status !== 'sealed') throw new Error(`Expected a current seal, got ${result.status}`);
    rows.push(...result.rows);
    if (result.exhausted) return { rows, seal: result.seal };
    // A native seal does not exhaust caller pagination, even for the last full page.
    expect(result.rows).toHaveLength(1);
    expect(result.after).not.toEqual(after);
    after = result.after;
  }
  throw new Error('Finite expected manifest did not exhaust');
}
async function verify(key: LibraryScopeEffectsKey, seal: LibraryScopeEffectSeal) {
  const input = budget(),
    work = bindLibraryIdentityDeadline(new NativeCollectionWork(input.allowance, input.deadline), input.deadline);
  const result = await libraryIdentityCommand(native.pool, work, home, async (tx) =>
    noEffect(await planner.verifySeal(tx, key, seal)),
  );
  charged(work.receipt());
  return result;
}
async function output(collectionId: string) {
  const ref = { route, collectionId, generation: randomUUID() };
  async function command<T>(body: (tx: CommandTransaction) => Promise<T>) {
    const deadline = Date.now() + 30_000;
    return runCommand(
      native.pool,
      {
        ...principalCommandIdentity(owner.actor),
        partition: home,
        deadline,
        authorization: resourceAuthorization({
          access: native.access,
          actor: owner.actor,
          action: 'collection:update',
          anchor: {
            resource: { route, id: collectionId },
            async validate(tx) {
              return (
                (
                  await tx.query('SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2', [
                    route,
                    collectionId,
                  ])
                ).rowCount === 1
              );
            },
          },
          context: { pool: native.pool, partition: home, deadline },
        }),
        receipt: {
          kind: 'library.collection.explicit-output',
          key: randomUUID(),
          digest: createHash('sha256').update(randomUUID()).digest(),
        },
      },
      async (tx) => ({
        value: (await body(tx)) ?? null,
        events: [{ type: 'com.rezics.library.collection.updated.v1', subject: collectionId, data: { collectionId } }],
      }),
    );
  }
  await command((tx) => beginCollectionSourceOutput(tx, { ...ref, expectedMembers: 1 }));
  await command((tx) => appendCollectionSourceOutput(tx, { ...ref, after: null, subjectIds: [original] }));
  await command((tx) => completeCollectionSourceOutput(tx, ref));
}

test('default native plans expose all six drivers with bounded positive pages and a genuine current same-home seal, preserving original facts', async () => {
  const curated = await collection('curated'),
    privateId = await collection('private'),
    explicit = await collection('output');
  await member(curated, original, 'a0', 'First duplicate');
  await member(curated, original, 'a1', 'Second duplicate');
  const label = newId(route),
    assignment = newId(route),
    session = newId(route),
    copy = newId(route),
    transaction = randomUUID();
  await native.pool.query(
    `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id)
    VALUES($1,$2,$3,'planned',1,now(),now(),$4)`,
    [route, owner.actor.accountId, original, transaction],
  );
  await native.pool.query(
    `INSERT INTO library.personal_label(route,account_id,label_id,normalized_name,revision,created_at,updated_at,transaction_id)
    VALUES($1,$2,$3,'native label',1,now(),now(),$4)`,
    [route, owner.actor.accountId, label, transaction],
  );
  await native.pool.query(
    `INSERT INTO library.label_assignment(route,account_id,subject_id,label_id,slot_no,assignment_id,revision,created_at,updated_at,transaction_id)
    VALUES($1,$2,$3,$4,1,$5,1,now(),now(),$6)`,
    [route, owner.actor.accountId, original, label, assignment, transaction],
  );
  await native.pool.query(
    `INSERT INTO library.progress_session(route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,transaction_id)
    VALUES($1,$2,$3,$4,'completed_units','chapter',0,'active',1,now(),$5)`,
    [route, session, owner.actor.accountId, original, transaction],
  );
  await native.pool.query(
    `INSERT INTO library.copy(route,copy_id,account_id,subject_id,status,revision,created_at,updated_at,transaction_id)
    VALUES($1,$2,$3,$4,'owned',1,now(),now(),$5)`,
    [route, copy, owner.actor.accountId, original, transaction],
  );
  await output(explicit);
  const snapshot = async () =>
    (
      await native.pool.query(
        `SELECT
    (SELECT jsonb_agg(m ORDER BY ordinal_key,member_id) FROM library.collection_member m WHERE route=$1 AND collection_id=$2) members,
    (SELECT jsonb_agg(e) FROM library.entry e WHERE route=$1 AND account_id=$3) entries,
    (SELECT jsonb_agg(s) FROM library.progress_session s WHERE route=$1 AND account_id=$3) sessions,
    (SELECT jsonb_agg(c) FROM library.copy c WHERE route=$1 AND account_id=$3) copies,
    (SELECT jsonb_agg(a) FROM library.label_assignment a WHERE route=$1 AND account_id=$3) labels`,
        [route, curated, owner.actor.accountId],
      )
    ).rows;
  const before = await snapshot();
  const seen = new Set<string>();
  for (const id of [curated, privateId, explicit]) {
    const key = { job, sourceIdentity: await identity(id), scope: 'collection-source' };
    await seal(key);
    const expected = await effects(key);
    expect(expected.rows.length).toBeGreaterThan(0);
    expect(await verify(key, expected.seal)).toBe(true);
    const operations = (
      await native.pool.query(
        'SELECT operation FROM library.identity_scope_effect WHERE route=$1 AND collection_id=$2',
        [route, id],
      )
    ).rows;
    for (const { operation } of operations) seen.add(operation.raw.driver);
    for (const driver of new Set(operations.map(({ operation }) => operation.raw.driver))) {
      expect(
        new Set(
          operations
            .filter(({ operation }) => operation.raw.driver === driver)
            .map(({ operation }) => operation.disposition),
        ),
      ).toEqual(new Set(['OLD', 'NEW', 'first-apply']));
    }
  }
  expect(seen).toEqual(new Set(['member', 'entry', 'label', 'session', 'copy', 'output']));
  expect(await snapshot()).toEqual(before);
}, 600_000);

test('omitting an expected native effect rolls back enrollment and cannot seal, including a forged zero frontier', async () => {
  const id = await collection('curated');
  await member(id);
  const key = { job, sourceIdentity: await identity(id), scope: 'collection-source' };
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `library.reject_scope_${suffix}`,
    triggerName = `reject_scope_${suffix}`;
  await native.pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.collection_id='${id}'::uuid AND NEW.disposition='NEW' THEN RETURN NULL; END IF; RETURN NEW; END; $$`);
  await native.pool.query(
    `CREATE TRIGGER ${triggerName} BEFORE INSERT ON library.identity_scope_effect FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
  );
  try {
    let failed = false;
    for (let page = 0; page < 100; page++) {
      try {
        const result = await planner.advance({ ...key, ...budget(), limit: 1 });
        expect(result.status).toBe('pending');
      } catch (error) {
        expect(error).toMatchObject({ code: 'identity_effect_stale' });
        charged((error as Error & { work: WorkReceipt }).work);
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    expect((await planner.readPage({ ...key, ...budget(), after: null, limit: 1 })).status).toBe('pending');
    expect(
      (
        await native.pool.query('SELECT 1 FROM library.identity_scope_effect WHERE route=$1 AND collection_id=$2', [
          route,
          id,
        ])
      ).rows,
    ).toHaveLength(0);
  } finally {
    await native.pool.query(`DROP TRIGGER ${triggerName} ON library.identity_scope_effect`);
    await native.pool.query(`DROP FUNCTION ${functionName}()`);
  }
  await seal(key);
  const current = await effects(key);
  expect(await verify(key, current.seal)).toBe(true);
  expect(await verify(key, { ...current.seal, frontier: { after: [], segment: 0 } })).toBe(false);
}, 600_000);

test('a genuine exhaustive zero seals, while late first apply, writer fence, rekey and prearm writer change cannot verify it', async () => {
  for (const mutation of ['late', 'fence', 'rekey', 'prearm'] as const) {
    const id = await collection('curated'),
      key = { job, sourceIdentity: await identity(id), scope: 'collection-source' };
    await seal(key);
    const empty = await effects(key);
    expect(empty.rows).toHaveLength(0);
    expect(await verify(key, empty.seal)).toBe(true);
    expect(await verify({ ...key, scope: 'claimed-zero' }, empty.seal)).toBe(false);
    if (mutation === 'late') await member(id);
    if (mutation === 'fence')
      await native.pool.query(
        "UPDATE library.native_source_fence SET generation=generation+1 WHERE route=$1 AND kind='account' AND owner_id=$2",
        [route, owner.actor.accountId],
      );
    if (mutation === 'rekey')
      await native.pool.query(
        'UPDATE library.collection SET source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2',
        [route, id],
      );
    if (mutation === 'prearm')
      await native.pool.query(
        `UPDATE semantic.identity_epoch_prearm_directory
      SET sequence=sequence+1 WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3`,
        [home, job.jobId, job.epoch.toString()],
      );
    try {
      expect(await verify(key, empty.seal)).toBe(false);
      expect((await planner.readPage({ ...key, ...budget(), after: null, limit: 1 })).status).toBe('pending');
    } finally {
      if (mutation === 'prearm')
        await native.pool.query(
          `UPDATE semantic.identity_epoch_prearm_directory
        SET sequence=sequence-1 WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3`,
          [home, job.jobId, job.epoch.toString()],
        );
    }
  }
}, 600_000);

test('successful, repeated and rolled-back native IO retains literal inclusive eight-axis charges without refill', async () => {
  const input = budget(),
    work = bindLibraryIdentityDeadline(new NativeCollectionWork(input.allowance, input.deadline), input.deadline);
  const key = { job, sourceIdentity: await identity(await collection('curated')), scope: 'collection-source' };
  const read = async () =>
    libraryIdentityCommand(native.pool, work, home, async (tx) => {
      await tx.query(libraryIdentitySQL.oldHead, [route, key.sourceIdentity.collectionId]);
      return noEffect(null);
    });
  await read();
  const first = work.receipt();
  charged(first);
  await read();
  const second = work.receipt();
  for (const axis of ['nativeRows', 'nativePoints', 'statements', 'bytes', 'emptySeeks'] as const)
    expect(second.used[axis]).toBe(first.used[axis] * 2);
  const rollback = async () =>
    libraryIdentityCommand(native.pool, work, home, async (tx) => {
      await tx.query(libraryIdentitySQL.oldHead, [route, key.sourceIdentity.collectionId]);
      throw new Error('deliberate rollback');
    });
  await expect(rollback()).rejects.toThrow('deliberate rollback');
  const failed = work.receipt();
  expect(failed.reservationId).toBe(first.reservationId);
  expect(failed.used.nativeRows).toBeGreaterThan(second.used.nativeRows);
  expect(failed.used.statements).toBeGreaterThan(second.used.statements);
  const sqlFailure = async () =>
    libraryIdentityCommand(native.pool, work, home, async (tx) => {
      await tx.query(libraryIdentitySQL.insertEffect, [
        route,
        key.sourceIdentity.collectionId,
        '0'.repeat(64),
        'failure',
        'OLD',
        original,
        '{}',
      ]);
      return noEffect(null);
    });
  await expect(sqlFailure()).rejects.toThrow();
  const firstFailure = work.receipt();
  expect(firstFailure.used.nativeRows).toBeGreaterThan(failed.used.nativeRows);
  await expect(sqlFailure()).rejects.toThrow();
  const repeatFailure = work.receipt();
  expect(repeatFailure.reservationId).toBe(first.reservationId);
  expect(repeatFailure.used.nativeRows).toBeGreaterThan(firstFailure.used.nativeRows);
  const bound = libraryIdentityFootprint(libraryIdentitySQL.effectPage, [
    route,
    key.sourceIdentity.collectionId,
    'x',
    '',
    '',
    1,
  ])!;
  expect(bound).toMatchObject({
    candidateKeys: 1,
    nativeRows: 2,
    identityMetadataRows: 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    emptySeeks: 1,
  });
  expect(libraryIdentityFootprint('SELECT * FROM library.identity_scope_effect', [])).toBeUndefined();
  // Native operation bounds remain spent even for empty results or failed dispatches.
  const point = work.reserve(bound);
  point.dispatch();
  point.settle({ candidateKeys: 0, emptySeeks: 1 });
  expect(work.receipt().used.nativeRows).toBe(repeatFailure.used.nativeRows + 2);
}, 120_000);

// Genuine selected-original outcomes. The actual Accounts producer must install
// its complete disjoint Source term before these can enter; no test quote or
// synthetic private grant substitutes for that still separately owned operand.
async function withAuthenticLibraryOriginal<T>(
  body: (
    context: import('../../src/semantic/identity-source-consumer-maintenance.ts').IdentitySourceConsumerMaintenanceContext,
    work: NativeCollectionWork,
  ) => Promise<T>,
) {
  const { HistoryRegistry } = await import('../../src/history/registry.ts');
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { admitSharedHistory } = await import('../../src/access/shared-history.ts');
  const { withSelectedHistoryOriginal, consumeSelectedHistoryOriginal, withIdentityOriginalSourceTransfer } =
    await import('../../src/access/identity-original-admission.ts');
  const { withPrepaidIdentitySourceConsumerMaintenance, claimIdentitySourceCustodyAdvancement } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const registry = new HistoryRegistry(),
    account = newId(route),
    historyJob = randomUUID();
  await native.pool.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now())', [
    route,
    account,
  ]);
  const generation = (
    await native.pool.query(
      `INSERT INTO core.history_registry(singleton,digest,gaps)
    VALUES(true,$1,'[]') ON CONFLICT(singleton) DO UPDATE SET digest=EXCLUDED.digest,
    generation=core.history_registry.generation+1 RETURNING generation::text`,
      [registry.digest()],
    )
  ).rows[0]!.generation;
  await runCommand(native.pool, { partition: home }, async (tx) =>
    noEffect(await admitSharedHistory(tx, account, historyJob)),
  );
  await native.pool.query(
    `UPDATE core.preference_history_job SET registry_digest=$2,registry_generation=$3,
    next_run='-infinity' WHERE job_id=$1`,
    [historyJob, registry.digest(), generation],
  );
  const client = await createWorkClient(native.pool.options.connectionString!, native.pool);
  const deps = { pool: native.pool, client, registry };
  try {
    return await withSelectedHistoryOriginal(deps, async (selected, original) => {
      expect(selected).toBe(historyJob);
      await consumeSelectedHistoryOriginal(deps, original, selected);
      return withIdentityOriginalSourceTransfer(deps, original, selected, (parent) =>
        withPrepaidIdentitySourceConsumerMaintenance(deps, parent, async (context) => {
          const p = parent.position;
          expect(
            claimIdentitySourceCustodyAdvancement(native.pool, context.identityConsumerWork, context.deadline, {
              accountId: p.account_id,
              accountRoute: p.account_route,
              version: p.barrier_version,
              at: p.barrier_at,
            }),
          ).toBe(true);
          return body(context, parent.library);
        }),
      );
    });
  } finally {
    await native.pool.query("UPDATE core.preference_history_job SET next_run='infinity' WHERE job_id=$1", [historyJob]);
    await client.close();
  }
}

for (const count of [0, 1]) {
  test(`authentic selected Library page with ${count} effects keeps its ledger/deadline through current verification and sealed-zero exhausted recheck`, async () => {
    const { readLibraryScopeEffectsPageWithWork, readLibraryScopeEffectsPage, verifyLibraryScopeEffectsSeal } =
      await import('../../src/library/identity-scope-effects.ts');
    const { claimIdentitySourceLibraryCall, withIdentitySourceNoEffectCommand } =
      await import('../../src/semantic/identity-source-consumer-maintenance.ts');
    const { bindLibraryIdentityPrepaidWork } = await import('../../src/library/identity-native-planner-work.ts');
    const { currentCommandResources } = await import('../../src/command/command.ts');
    const collectionId = await collection('curated');
    if (count) await member(collectionId);
    const key = { job, sourceIdentity: await identity(collectionId), scope: 'collection-source' };
    await seal(key); // Independent native preparation is a different admitted original.
    const { EventEmitter } = await import('node:events');
    const foreign = Object.assign(new EventEmitter(), {
      connect: async () => {
        throw new Error('Foreign checkout');
      },
    }) as unknown as import('pg').Pool;
    let escaped!: () => Promise<unknown>;
    await withAuthenticLibraryOriginal(async (context, work) => {
      const input = { ...key, after: null, limit: 1, deadline: context.deadline };
      bindLibraryIdentityPrepaidWork(native.pool, work, context.deadline);
      const before = work.receipt();
      await expect(
        readLibraryScopeEffectsPageWithWork(native.pool, { ...input, deadline: input.deadline - 1 }, work),
      ).rejects.toThrow();
      await expect(readLibraryScopeEffectsPageWithWork(foreign, input, work)).rejects.toThrow();
      expect(work.receipt()).toEqual(before);
      await expect(
        readLibraryScopeEffectsPage(native.pool, { ...input, allowance: budget().allowance }),
      ).rejects.toThrow('requires readLibraryScopeEffectsPageWithWork');
      claimIdentitySourceLibraryCall(native.pool, 'effectPages');
      const page = await readLibraryScopeEffectsPageWithWork(native.pool, input, work);
      expect(page.status).toBe('sealed');
      if (page.status !== 'sealed') throw new Error('Missing genuine Library seal');
      expect(page.rows).toHaveLength(count);
      expect(page.exhausted).toBe(count === 0);
      expect(page.work).toEqual(work.receipt());
      await expect(readLibraryScopeEffectsPageWithWork(native.pool, input, work)).rejects.toThrow('Missing unspent');
      await withIdentitySourceNoEffectCommand(native.pool, context.deadline, () =>
        runCommand(native.pool, { partition: home, deadline: context.deadline }, async (tx) => {
          expect(currentCommandResources(tx)).toMatchObject({ pool: native.pool, deadline: context.deadline });
          claimIdentitySourceLibraryCall(native.pool, 'currentVerifications');
          expect(await verifyLibraryScopeEffectsSeal(tx, key, page.seal)).toBe(true);
          if (page.exhausted) {
            claimIdentitySourceLibraryCall(native.pool, 'exhaustedPageRechecks');
            expect(await verifyLibraryScopeEffectsSeal(tx, key, page.seal)).toBe(true);
          }
          return noEffect(null);
        }),
      );
      expect(work.receipt().reservationId).toBe(before.reservationId);
      expect(work.receipt().used.statements).toBeGreaterThan(page.work.used.statements);
      escaped = () => readLibraryScopeEffectsPageWithWork(native.pool, input, work);
    });
    await expect(escaped()).rejects.toThrow();
  }, 600_000);
}
