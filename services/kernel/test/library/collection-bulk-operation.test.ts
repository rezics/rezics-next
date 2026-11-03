import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createCollectionBulkOperations,
  readCollectionBulkInitiator,
} from '../../src/library/collection-bulk-operation.ts';
import { expireCollectionBulkPage, runCollectionBulkPage } from '../../src/library/collection-bulk-work.ts';
import { pageCollectionBulkManifest, readCollectionBulk } from '../../src/library/collection-bulk-store.ts';
import { executeStatusTarget } from '../../src/library/bulk-contract.ts';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { withConnection } from '../../src/database/pool.ts';
import { workStepDeadline } from '../../src/library/command-support.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
const clock = () => new Date();
let bulk: ReturnType<typeof createCollectionBulkOperations>;
const key = () => randomUUID();
beforeAll(async () => {
  f = await createProfileEntryFixture();
  bulk = createCollectionBulkOperations({ pool: f.pool, access: f.access, tokens: f.tokens, clock });
});
afterAll(async () => {
  await f?.close();
});
const dependencies = () => ({
  pool: f.pool,
  access: f.access,
  tokens: f.tokens,
  clock,
  // Auth is an independently injected port; native Accounts/Access and receipts remain installed.
  readConsent: async () => ({
    actorAccountId: f.owner.actor.accountId,
    clientId: f.owner.actor.clientId,
    scopes: f.owner.actor.scopes,
  }),
});
async function entry() {
  const subjectId = await f.createSubject('game');
  const result = await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, key());
  return result.value.entry;
}
async function preview(subjectIds: string[], requestKey = key()) {
  return bulk.preview(
    f.owner.actor,
    {
      action: 'set_status',
      state: 'completed',
      selection: { kind: 'explicit', targets: subjectIds.map((subjectId) => ({ subjectId })) },
    },
    requestKey,
  );
}

test('preview is inert, confirmation binds stored peers, and changed entries are skipped individually', async () => {
  const a = await entry(),
    b = await entry();
  const requestKey = key(),
    created = await preview([a.subjectId, b.subjectId, a.subjectId], requestKey);
  const id = created.value.operation.id;
  expect((await preview([a.subjectId, b.subjectId, a.subjectId], requestKey)).value.operation.id).toBe(id);
  expect(created.value.operation.phase).toBe('preview');
  await runCollectionBulkPage(dependencies(), { route: created.value.operation.route, operationId: id });
  expect((await f.commands.readEntry(f.owner.actor, a.subjectId)).revision).toBe(a.revision);
  await f.commands.putEntry(
    f.owner.actor,
    b.subjectId,
    { state: 'paused', revision: b.revision, incarnationId: b.incarnationId! },
    key(),
  );
  await bulk.confirm(f.owner.actor, id, key());
  await bulk.confirm(f.owner.actor, id, key());
  const input = { route: created.value.operation.route, operationId: id };
  await runCollectionBulkPage(dependencies(), input);
  await runCollectionBulkPage(dependencies(), input); // lost step response / duplicate wakeup
  const page = await bulk.outcomes(f.owner.actor, id, {});
  expect(page.outcomes.map((row) => [row.state, row.reason])).toEqual([
    ['applied', null],
    ['conflict', 'revision_mismatch'],
  ]);
  expect((await f.commands.readEntry(f.owner.actor, a.subjectId)).revision).toBe(a.revision + 1);
  expect((await bulk.get(f.owner.actor, id)).operation.summary).toEqual({ changed: 1, unchanged: 0, failed: 1 });
  await expect(bulk.get(f.other.actor, id)).rejects.toThrow();
  await expect(bulk.outcomes(f.owner.actor, id, { cursor: 'invented' })).rejects.toThrow();
});

test('cancellation and expiry close pending targets without changing entries; query capture stays unavailable', async () => {
  const a = await entry();
  const cancelled = await preview([a.subjectId]);
  await bulk.confirm(f.owner.actor, cancelled.value.operation.id, key());
  await bulk.cancel(f.owner.actor, cancelled.value.operation.id, key());
  await runCollectionBulkPage(dependencies(), {
    route: cancelled.value.operation.route,
    operationId: cancelled.value.operation.id,
  });
  expect((await bulk.outcomes(f.owner.actor, cancelled.value.operation.id, {})).outcomes[0]?.state).toBe('cancelled');
  const expired = await preview([a.subjectId]);
  await bulk.confirm(f.owner.actor, expired.value.operation.id, key());
  await runCollectionBulkPage(
    { ...dependencies(), clock: () => new Date(Date.now() + 25 * 3600000) },
    { route: expired.value.operation.route, operationId: expired.value.operation.id },
  );
  expect((await bulk.outcomes(f.owner.actor, expired.value.operation.id, {})).outcomes[0]?.reason).toBe(
    'execution_expired',
  );
  expect((await f.commands.readEntry(f.owner.actor, a.subjectId)).revision).toBe(a.revision);
  await expect(
    bulk.preview(
      f.owner.actor,
      {
        action: 'set_status',
        state: 'completed',
        selection: { kind: 'query', sourceId: randomUUID(), filter: '{"state":"planned"}' },
      },
      key(),
    ),
  ).rejects.toMatchObject({ code: 'dependency_unavailable' });
  await expect(preview([])).rejects.toThrow();
  const response = await f.send('owner', 'POST', '/v1/libraryOperations', {
    action: 'set_status',
    state: 'completed',
    selection: { kind: 'explicit', targets: [{ subjectId: a.subjectId }] },
  });
  expect(response.status).toBe(201);
  const httpOperation = (await response.json()).operation;
  expect((await f.send('owner', 'GET', `/v1/libraryOperations/${httpOperation.id}`)).status).toBe(200);
  expect((await f.commands.readEntry(f.owner.actor, a.subjectId)).revision).toBe(a.revision);
  expect((await f.send('owner', 'POST', `/v1/libraryOperations/${httpOperation.id}:confirm`, {})).status).toBe(200);
  const late = () => new Date(Date.now() + 49 * 3600000);
  await expect(
    createCollectionBulkOperations({ ...dependencies(), clock: late }).get(f.owner.actor, expired.value.operation.id),
  ).rejects.toThrow();
  // Indexed cleanup drains private manifest rows and finally removes their root.
  for (let n = 0; n < 10; n++)
    await expireCollectionBulkPage({ pool: f.pool, clock: late }, expired.value.operation.route);
  await expect(bulk.get(f.owner.actor, expired.value.operation.id)).rejects.toThrow();
});

test('filtered preview exhausts native Members pages before status confirmation', async () => {
  const owner = await f.identity([
    ...f.owner.actor.scopes,
    'collection:create',
    'collection:read',
    'collection:update',
  ]);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
  const collections = createCollectionCommands({ pool: f.pool, access: f.access, clock });
  const source = (
    await collections.createCollection(owner.actor, { title: 'Paged bulk source', visibility: 'private' }, key())
  ).value;
  const subjectId = await f.createSubject('game');
  await f.commands.putEntry(owner.actor, subjectId, { state: 'planned' }, key());
  for (let n = 0; n < 101; n++)
    await collections.addMember(owner.actor, source.id, { subjectId, note: `occurrence-${n}` }, key());

  const response = await f.send(owner.bearer, 'POST', '/v1/libraryOperations', {
    action: 'set_status',
    state: 'completed',
    selection: { kind: 'query', sourceId: source.id },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const operation = (await response.json()).operation;
  expect(operation.selectionSource).toMatchObject({
    id: source.id,
    revision: source.revision + 101,
    scannedCandidates: 101,
    selectedSubjects: 1,
  });
  expect(operation.counts.targets).toBe(1);

  await f.send(owner.bearer, 'POST', `/v1/libraryOperations/${operation.id}:confirm`, {});
  const readConsent = async () => ({
    actorAccountId: owner.actor.accountId,
    clientId: owner.actor.clientId,
    scopes: owner.actor.scopes,
  });
  await runCollectionBulkPage({ ...dependencies(), readConsent }, {
    route: operation.route,
    operationId: operation.id,
  });
  expect((await f.commands.readEntry(owner.actor, subjectId)).state).toBe('completed');

  const destination = (
    await collections.createCollection(owner.actor, { title: 'Bulk destination', visibility: 'private' }, key())
  ).value;
  const addResponse = await f.send(owner.bearer, 'POST', '/v1/libraryOperations', {
    action: 'add_to_collection',
    collectionId: destination.id,
    selection: { kind: 'query', sourceId: source.id },
  });
  expect(addResponse.status, await addResponse.clone().text()).toBe(201);
  const add = (await addResponse.json()).operation;
  expect(add.selectionSource.selectedSubjects).toBe(1);
  expect(add.counts.targets).toBe(1);
  await f.send(owner.bearer, 'POST', `/v1/libraryOperations/${add.id}:confirm`, {});
  await runCollectionBulkPage({ ...dependencies(), readConsent }, { route: add.route, operationId: add.id });
  const destinationMembers = await f.pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM library.collection_member
     WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL`,
    [add.route, destination.id],
  );
  expect(destinationMembers.rows[0]?.count).toBe(1);

  const libraryRemovalResponse = await f.send(owner.bearer, 'POST', '/v1/libraryOperations', {
    action: 'remove_from_library',
    selection: { kind: 'query', sourceId: source.id },
  });
  expect(libraryRemovalResponse.status, await libraryRemovalResponse.clone().text()).toBe(201);
  const libraryRemoval = (await libraryRemovalResponse.json()).operation;
  expect(libraryRemoval.counts.targets).toBe(1);
  await f.send(owner.bearer, 'POST', `/v1/libraryOperations/${libraryRemoval.id}:confirm`, {});
  await runCollectionBulkPage({ ...dependencies(), readConsent }, {
    route: libraryRemoval.route,
    operationId: libraryRemoval.id,
  });
  expect((await f.send(owner.bearer, 'GET', `/v1/libraryEntries/${subjectId}`)).status).toBe(404);

  const removalResponse = await f.send(owner.bearer, 'POST', '/v1/libraryOperations', {
    action: 'remove_from_collection',
    collectionId: source.id,
    selection: { kind: 'query', sourceId: source.id },
  });
  expect(removalResponse.status, await removalResponse.clone().text()).toBe(201);
  const removal = (await removalResponse.json()).operation;
  expect(removal.counts).toMatchObject({ scannedCandidates: 101, selectedSubjects: 1, targets: 101 });
  const occurrences = await f.pool.query<{ count: number; distinctMembers: number }>(
    `SELECT count(*)::integer AS count,count(DISTINCT member_id)::integer AS "distinctMembers"
     FROM library.bulk_target WHERE route=$1 AND operation_id=$2`,
    [removal.route, removal.id],
  );
  expect(occurrences.rows[0]).toEqual({ count: 101, distinctMembers: 101 });
  await f.send(owner.bearer, 'POST', `/v1/libraryOperations/${removal.id}:confirm`, {});
  expect(await runCollectionBulkPage({ ...dependencies(), readConsent }, {
    route: removal.route,
    operationId: removal.id,
  })).toBe(true);
  expect(await runCollectionBulkPage({ ...dependencies(), readConsent }, {
    route: removal.route,
    operationId: removal.id,
  })).toBe(false);
  const remaining = await f.pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM library.collection_member
     WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL`,
    [removal.route, source.id],
  );
  expect(remaining.rows[0]?.count).toBe(0);
}, 300000);

test('current authority loss prevents another effect and result disclosure', async () => {
  await f.setLibraryOpen(false);
  await f.grantLibraryGate(f.owner.actor.accountId);
  const a = await entry(),
    b = await entry(),
    created = await preview([a.subjectId, b.subjectId]),
    id = created.value.operation.id;
  await bulk.confirm(f.owner.actor, id, key());
  const stored = await withConnection(f.pool, async (tx) => {
    const locator = { route: created.value.operation.route, operationId: id, accountId: f.owner.actor.accountId };
    return {
      operation: (await readCollectionBulk(tx, locator))!,
      row: (await pageCollectionBulkManifest(tx, { ...locator, limit: 1 }))[0]!,
    };
  });
  const runtime = {
    ...dependencies(),
    readInitiator: readCollectionBulkInitiator,
    initiators: createInitiatorRestorer({ ...dependencies(), readOperation: readCollectionBulkInitiator }),
  };
  const command = {
    source: stored.operation.initiator.operation,
    sourceDigest: stored.operation.sourceDigest,
    target: { ...stored.row.target, operationId: id, ordinal: stored.row.ordinal },
    receipt: stored.row.receipt,
    identity: {
      clientId: stored.operation.initiator.actor.clientId,
      requestedBy: stored.operation.initiator.actor.requestedBy,
    },
    chunkIndex: 0,
    deadline: workStepDeadline(),
  };
  const committed = await executeStatusTarget(runtime, command);
  expect(committed.kind).toBe('terminal');
  await f.revokeLibraryGate(f.owner.actor.accountId);
  // A lost native response is privately recoverable even after write/disclosure authority is gone.
  expect(await executeStatusTarget(runtime, command)).toEqual(committed);
  await runCollectionBulkPage(dependencies(), { route: created.value.operation.route, operationId: id });
  await expect(bulk.get(f.owner.actor, id)).rejects.toThrow();
  await f.grantLibraryGate(f.owner.actor.accountId);
  expect((await f.commands.readEntry(f.owner.actor, a.subjectId)).revision).toBe(a.revision + 1);
  expect((await f.commands.readEntry(f.owner.actor, b.subjectId)).revision).toBe(b.revision);
  expect((await bulk.outcomes(f.owner.actor, id, {})).outcomes.map((outcome) => outcome.reason)).toEqual([
    null,
    'authority_lost',
  ]);
});
