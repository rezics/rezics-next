import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { readCollectionBulkInitiator } from '../../src/library/collection-bulk-operation.ts';
import { runCollectionBulkPage } from '../../src/library/collection-bulk-work.ts';
import { pageCollectionBulkManifest, readCollectionBulk } from '../../src/library/collection-bulk-store.ts';
import { withConnection } from '../../src/database/pool.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
const key = () => randomUUID();
const clock = () => new Date();

beforeAll(async () => {
  f = await createProfileEntryFixture();
});
afterAll(async () => {
  await f?.close();
});

async function collection(title: string) {
  const response = await f.send('owner', 'POST', '/v1/collections', { title, visibility: 'private' });
  expect(response.status).toBe(201);
  return ((await response.json()) as { collection: { id: string } }).collection.id;
}

async function preview(collectionId: string, subjectIds: string[], requestKey = key()) {
  const response = await f.send(
    'owner',
    'POST',
    '/v1/libraryOperations',
    {
      action: 'add_to_collection',
      collectionId,
      selection: { kind: 'explicit', targets: subjectIds.map((subjectId) => ({ subjectId })) },
    },
    requestKey,
  );
  return { response, requestKey };
}

async function worker() {
  const dependencies = {
    pool: f.pool,
    access: f.access,
    tokens: f.tokens,
    clock,
    readConsent: async () => ({
      actorAccountId: f.owner.actor.accountId,
      clientId: f.owner.actor.clientId,
      scopes: f.owner.actor.scopes,
    }),
  };
  return {
    ...dependencies,
    readInitiator: readCollectionBulkInitiator,
    initiators: createInitiatorRestorer({ ...dependencies, readOperation: readCollectionBulkInitiator }),
  };
}

async function outcomes(operationId: string) {
  const response = await f.send('owner', 'GET', `/v1/libraryOperations/${operationId}/outcomes`);
  expect(response.status).toBe(200);
  return (await response.json()) as { outcomes: { state: string; reason: string | null; resultingMemberId: string | null }[] };
}

test('explicit add preview stores native targets without membership effects; replay and lost response reuse one occurrence', async () => {
  const collectionId = await collection('Bulk add preview');
  const subjectId = await f.createSubject('game', 'Bulk target');
  const { response, requestKey } = await preview(collectionId, [subjectId]);
  expect(response.status).toBe(201);
  const created = (await response.json()) as { operation: { id: string; route: number } };
  const { id: operationId, route } = created.operation;
  const replay = await preview(collectionId, [subjectId], requestKey);
  expect(replay.response.status).toBe(201);
  expect(((await replay.response.json()) as { operation: { id: string } }).operation.id).toBe(operationId);

  const stored = await withConnection(f.pool, async (tx) => {
    const locator = { route, accountId: f.owner.actor.accountId, operationId };
    return {
      operation: await readCollectionBulk(tx, locator),
      targets: await pageCollectionBulkManifest(tx, { ...locator, limit: 10 }),
      entry: await tx.query<{ incarnation: string | null; sequence: string | null; revision: number }>(
        `SELECT incarnation_id AS incarnation,owner_write_seq::text AS sequence,revision FROM library.entry
         WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
        [locator.route, locator.accountId, subjectId],
      ),
      counter: await tx.query<{ sequence: string }>(
        'SELECT seq::text AS sequence FROM library.owner_write_counter WHERE route=$1 AND account_id=$2',
        [locator.route, locator.accountId],
      ),
    };
  });
  expect(stored.operation?.request).toMatchObject({ action: 'add_to_collection', collectionId });
  expect(stored.targets).toHaveLength(1);
  expect(stored.targets[0]?.target).toMatchObject({ kind: 'subject', subjectId, collectionId });
  const entry = stored.entry.rows[0];
  if (!entry)
    expect(stored.targets[0]?.target.expected).toEqual({
      kind: 'absent',
      slotGeneration: stored.counter.rows[0]?.sequence ?? '0',
    });
  else {
    if (!entry.incarnation || !entry.sequence) throw new Error('Selected personal entry has incomplete native stamps');
    expect(stored.targets[0]?.target.expected).toEqual({
      kind: 'present',
      incarnation: entry.incarnation,
      admissionSequence: entry.sequence,
      revision: entry.revision,
    });
  }
  const members = await f.send('owner', 'GET', `/v1/collections/${collectionId}/members`);
  expect((await members.json() as { members: unknown[] }).members).toHaveLength(0);

  const confirmKey = key();
  expect((await f.send('owner', 'POST', `/v1/libraryOperations/${operationId}:confirm`, {}, confirmKey)).status).toBe(200);
  expect((await f.send('owner', 'POST', `/v1/libraryOperations/${operationId}:confirm`, {}, confirmKey)).status).toBe(200);
  const runtime = await worker();
  await runCollectionBulkPage(runtime, { route, operationId });
  await runCollectionBulkPage(runtime, { route, operationId });
  const result = await outcomes(operationId);
  expect(result.outcomes).toHaveLength(1);
  expect(result.outcomes[0]).toMatchObject({ state: 'applied', reason: null });
  expect(result.outcomes[0]?.resultingMemberId).toBeTruthy();
  const appliedMembers = await f.send('owner', 'GET', `/v1/collections/${collectionId}/members`);
  expect((await appliedMembers.json() as { members: { subjectId: string }[] }).members.map((member) => member.subjectId)).toEqual([
    subjectId,
  ]);
});

test('represented subjects skip and capacity failures stay individual outcomes', async () => {
  const collectionId = await collection('Bulk add outcomes');
  const represented = await f.createSubject('game', 'Already represented');
  const newSubject = await f.createSubject('game', 'At capacity');
  expect((await f.send('owner', 'POST', `/v1/collections/${collectionId}/members`, { subjectId: represented })).status).toBe(
    201,
  );
  const { response } = await preview(collectionId, [represented, newSubject]);
  expect(response.status).toBe(201);
  const created = (await response.json()) as { operation: { id: string; route: number } };
  const { id: operationId, route } = created.operation;
  await withConnection(f.pool, (tx) =>
    tx.query('UPDATE library.collection SET member_count=1000 WHERE route=$1 AND collection_id=$2', [
      route,
      collectionId,
    ]),
  );
  expect((await f.send('owner', 'POST', `/v1/libraryOperations/${operationId}:confirm`, {}, key())).status).toBe(200);
  const stored = await withConnection(f.pool, (tx) =>
    readCollectionBulk(tx, {
      route,
      accountId: f.owner.actor.accountId,
      operationId,
    }),
  );
  await runCollectionBulkPage(await worker(), { route, operationId });
  expect((await outcomes(operationId)).outcomes.map(({ state, reason }) => [state, reason])).toEqual([
    ['no_effect', null],
    ['failed', 'collection_full'],
  ]);
  const members = await f.send('owner', 'GET', `/v1/collections/${collectionId}/members`);
  expect((await members.json() as { members: { subjectId: string }[] }).members.map(({ subjectId }) => subjectId)).toEqual([
    represented,
  ]);
});

test('a destination that loses authority remains the stored target through confirmation', async () => {
  const destination = await collection('Original destination');
  const otherDestination = await collection('Replacement destination');
  const subjectId = await f.createSubject('game', 'Authority target');
  const { response } = await preview(destination, [subjectId]);
  expect(response.status).toBe(201);
  const created = (await response.json()) as { operation: { id: string; route: number } };
  const { id: operationId, route } = created.operation;
  const ownerRole = await withConnection(f.pool, (tx) =>
    tx.query<{ valid: string }>(
      `SELECT valid::text AS valid FROM access.resource_role_grant
       WHERE route=$1 AND resource_id=$2 AND subject_kind='identity' AND subject_id=$3
         AND grant_role='library.collection.owner'`,
      [route, destination, f.owner.actor.accountId],
    ),
  );
  expect(ownerRole.rows).toHaveLength(1);
  await createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant', clock }).transferRealmOwner(
    { pool: f.pool, actor: f.steward.actor, deadline: Date.now() + 30_000 },
    {
      resource: { route, id: destination },
      fromAccountId: f.owner.actor.accountId,
      toAccountId: f.other.actor.accountId,
      previousValid: ownerRole.rows[0]!.valid,
      key: key(),
    },
  );
  const confirmKey = key();
  expect((await f.send('owner', 'POST', `/v1/libraryOperations/${operationId}:confirm`, {}, confirmKey)).status).toBe(200);
  expect((await f.send('owner', 'POST', `/v1/libraryOperations/${operationId}:confirm`, {}, confirmKey)).status).toBe(200);

  const stored = await withConnection(f.pool, async (tx) => {
    const locator = { route, accountId: f.owner.actor.accountId, operationId };
    return {
      operation: await readCollectionBulk(tx, locator),
      targets: await pageCollectionBulkManifest(tx, { ...locator, limit: 10 }),
    };
  });
  if (stored.operation?.request.action !== 'add_to_collection') throw new Error('Expected stored add intent');
  expect(stored.operation.request.collectionId).toBe(destination);
  expect(stored.targets.map(({ target }) => target.collectionId)).toEqual([destination]);
  await runCollectionBulkPage(await worker(), { route, operationId });
  expect((await outcomes(operationId)).outcomes[0]).toMatchObject({ state: 'cancelled', reason: 'authority_lost' });
  const replacementMembers = await f.send('owner', 'GET', `/v1/collections/${otherDestination}/members`);
  expect((await replacementMembers.json() as { members: unknown[] }).members).toHaveLength(0);
});
