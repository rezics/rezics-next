import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { DurableInitiatorRecord } from '../../src/access/durable-initiator.ts';
import { createAccess } from '../../src/access/index.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { withConnection } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { executeCollectionAddTarget } from '../../src/library/collection-bulk-add.ts';
import {
  confirmCollectionBulk,
  pageCollectionBulkManifest,
  previewCollectionBulk,
} from '../../src/library/collection-bulk-store.ts';
import type { BulkDependencies, EntryExpectation, TargetCommand } from '../../src/library/bulk-contract.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { listMembers } from '../../src/library/collection-store.ts';
import type { CollectionMember } from '../../src/library/collection-model.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x5c31;
const scopes = ['collection:create', 'collection:read', 'collection:update', 'collection:delete', 'subject:read'];
const key = () => newId(route);
const routeKey = new Uint8Array(32).fill(92);
let db: GrowthDatabase;
let access: Access;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let owner: AccountActor;
let collections: ReturnType<typeof createCollectionCommands>;

beforeAll(async () => {
  db = await openGrowthDatabase();
  signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'bulk-add', alg: 'ES256' };
  access = createAccess({
    actions: new Map([
      ['collection:create', { anonymous: false, 'x-resource-types': ['library.collection'] }],
      ['collection:read', { anonymous: false }],
      ['collection:update', { anonymous: false }],
      ['collection:delete', { anonymous: false }],
      ['subject:read', { anonymous: true }],
    ]),
    auth: {
      issuer: 'https://auth.example.test',
      audience: 'https://api.rezics.test',
      jwksUrl: 'https://auth.example.test/jwks',
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  const accountId = newId(route);
  await db.pool.query(
    `INSERT INTO access.account
      (route,account_id,kind,state,transaction_id,authn_fenced,minimum_authn_epoch,membership_inverse_complete)
     VALUES ($1,$2,'actor','active',$2,false,1,true)`,
    [route, accountId],
  );
  owner = await authenticate(accountId, scopes);
  collections = createCollectionCommands({ pool: db.pool, access });
  await bootstrapRelease(db.pool, bundledRelease);
});

afterAll(async () => {
  await db?.close();
});

async function authenticate(accountId: string, scope: readonly string[]): Promise<AccountActor> {
  const token = await new SignJWT({
    client_id: 'web',
    scope: scope.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'bulk-add', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  return access.authenticate(token, { pool: db.pool, deadline: Date.now() + 290_000 });
}

async function makeSubject(label: string): Promise<string> {
  const idempotencyKey = `bulk-add-${key()}`;
  const created = await createSubject(db.pool, {
    actor: owner,
    target: subjectTarget(routeKey, owner.accountId, idempotencyKey),
    idempotencyKey,
    digest: createHash('sha256').update(idempotencyKey).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return created.subject.id;
}

async function members(collectionId: string): Promise<CollectionMember[]> {
  return withConnection(db.pool, (client) =>
    listMembers(client, routeOf(collectionId)!, collectionId, { after: null, limit: 100 }),
  );
}

async function bulkCommand(
  collectionId: string,
  subjectId: string,
  expected: EntryExpectation,
  actor = owner,
): Promise<{ command: TargetCommand; dependencies: BulkDependencies }> {
  const operationId = key();
  const source = { route, id: operationId, kind: 'library.collectionBulk.operation', sourceId: operationId };
  const initiator: DurableInitiatorRecord = {
    operation: source,
    initiatorAccountId: owner.accountId,
    actor,
    recordedTransactionId: key(),
    sourceDigest: 'a'.repeat(64),
    originalDelegation: null,
    originalAccount: { minimumAuthnEpoch: '1', operatorAccountId: null },
    creation: {
      commandKind: 'library.collectionBulk.preview',
      idempotencyKey: key(),
      requestDigest: 'b'.repeat(64),
      target: { route, id: owner.accountId },
    },
  };
  const target = {
    kind: 'subject' as const,
    subjectId,
    requestedSubjectId: null,
    expected,
    collectionId,
  };
  const preview = {
    route,
    accountId: owner.accountId,
    operationId,
    now: new Date().toISOString(),
    transactionId: key(),
    request: {
      action: 'add_to_collection' as const,
      collectionId,
      selection: { kind: 'explicit' as const, targets: [{ subjectId }] },
    },
    targets: [target],
    initiator,
    creationReceipt: {
      partition: partitionOf(route),
      principalKind: 'account' as const,
      principalId: owner.accountId,
      commandKind: 'library.collectionBulk.preview',
      key: key(),
      digest: 'c'.repeat(64),
    },
  };
  const tx = await db.pool.connect();
  let sourceDigest = '';
  let receipt!: TargetCommand['receipt'];
  try {
    await tx.query('BEGIN');
    const operation = await previewCollectionBulk(tx, preview);
    sourceDigest = operation.sourceDigest;
    await confirmCollectionBulk(tx, { route, accountId: owner.accountId, operationId, now: new Date().toISOString() });
    const [row] = await pageCollectionBulkManifest(tx, { route, accountId: owner.accountId, operationId, limit: 1 });
    if (!row) throw new Error('Bulk target was not persisted');
    receipt = row.receipt;
    await tx.query('COMMIT');
  } finally {
    tx.release();
  }
  const command: TargetCommand = {
    source,
    sourceDigest,
    target: { ...target, operationId, ordinal: '0' },
    receipt,
    identity: { clientId: actor.clientId, requestedBy: actor.requestedBy },
    chunkIndex: 0,
    deadline: Date.now() + 10_000,
  };
  const record = initiator;
  const dependencies = {
    pool: db.pool,
    access,
    tokens: {},
    clock: () => new Date(),
    initiators: { restoreInitiator: async () => actor },
    readInitiator: async (_client: unknown, requested: { id: string }) =>
      requested.id === operationId ? record : null,
    spendChunk: async () => ({ allowed: true }),
  } as unknown as BulkDependencies;
  return { command, dependencies };
}

test('captured add appends once with its event; replay is stable while explicit add still permits duplicates', async () => {
  const collection = await collections.createCollection(owner, { title: 'Bulk add', visibility: 'private' }, key());
  const existing = await makeSubject('Existing');
  const subject = await makeSubject('Captured');
  const first = await collections.addMember(owner, collection.value.id, { subjectId: existing }, key());
  const prepared = await bulkCommand(collection.value.id, subject, { kind: 'absent', slotGeneration: '0' });
  const added = await executeCollectionAddTarget(prepared.dependencies, prepared.command);
  expect(added.kind).toBe('terminal');
  if (added.kind !== 'terminal') throw new Error('Expected a native terminal result');
  expect(added.evidence.outcome).toBe('applied');
  const memberId = added.evidence.resultingMemberId;
  expect(memberId).toBeTruthy();
  if (memberId === null) throw new Error('Expected created member evidence');
  const replay = await executeCollectionAddTarget(prepared.dependencies, prepared.command);
  expect(replay).toEqual(added);
  expect((await members(collection.value.id)).map(({ id }) => id)).toEqual([
    first.value.id,
    memberId,
  ]);
  const outbox = await db.pool.query<{ type: string }>(
    'SELECT type FROM core.outbox WHERE partition_no=$1 AND transaction_id=$2',
    [partitionOf(route), added.evidence.transactionId],
  );
  expect(outbox.rows.map(({ type }) => type)).toEqual(['com.rezics.library.collection.member.changed.v1']);

  const represented = await bulkCommand(collection.value.id, subject, { kind: 'absent', slotGeneration: '0' });
  const skipped = await executeCollectionAddTarget(represented.dependencies, represented.command);
  expect(skipped).toMatchObject({ kind: 'terminal', evidence: { outcome: 'no_effect', resultingMemberId: null } });
  const explicit = await collections.addMember(owner, collection.value.id, { subjectId: subject }, key());
  expect((await members(collection.value.id)).map(({ subjectId }) => subjectId)).toEqual([existing, subject, subject]);
  expect(explicit.value.id).not.toBe(added.evidence.resultingMemberId);
});

test('current subject denial, Collection capacity, and a changed absent generation stay per-target', async () => {
  const collection = await collections.createCollection(owner, { title: 'Bulk outcomes', visibility: 'private' }, key());
  const subject = await makeSubject('Private to subject readers');
  const limited = await authenticate(owner.accountId, scopes.filter((scope) => scope !== 'subject:read'));
  const denied = await bulkCommand(collection.value.id, subject, { kind: 'absent', slotGeneration: '0' }, limited);
  const denial = await executeCollectionAddTarget(denied.dependencies, denied.command);
  expect(denial).toMatchObject({ kind: 'terminal', evidence: { outcome: 'denied', reason: 'target_denied' } });

  const generation = await db.pool.query<{ seq: string | null }>(
    'SELECT seq::text AS seq FROM library.owner_write_counter WHERE route=$1 AND account_id=$2',
    [route, owner.accountId],
  );
  const changed = await bulkCommand(collection.value.id, subject, {
    kind: 'absent',
    slotGeneration: (BigInt(generation.rows[0]?.seq ?? '0') + 1n).toString(),
  });
  const conflict = await executeCollectionAddTarget(changed.dependencies, changed.command);
  expect(conflict).toMatchObject({ kind: 'terminal', evidence: { outcome: 'conflict', reason: 'revision_mismatch' } });

  await db.pool.query('UPDATE library.collection SET member_count=1000 WHERE route=$1 AND collection_id=$2', [route, collection.value.id]);
  const full = await bulkCommand(collection.value.id, await makeSubject('At capacity'), { kind: 'absent', slotGeneration: '0' });
  const capacity = await executeCollectionAddTarget(full.dependencies, full.command);
  expect(capacity).toMatchObject({ kind: 'terminal', evidence: { outcome: 'failed', reason: 'collection_full' } });
  expect(await members(collection.value.id)).toEqual([]);
});
