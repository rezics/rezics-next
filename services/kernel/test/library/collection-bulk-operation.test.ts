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
      { action: 'set_status', state: 'completed', selection: { kind: 'query', filter: {} } },
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
    identity: {
      clientId: stored.operation.initiator.actor.clientId,
      requestedBy: stored.operation.initiator.actor.requestedBy,
    },
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
