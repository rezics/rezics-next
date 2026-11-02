import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCollectionBulkOperations } from '../../src/library/collection-bulk-operation.ts';
import { pageCollectionBulkManifest } from '../../src/library/collection-bulk-store.ts';
import { runCollectionBulkPage } from '../../src/library/collection-bulk-work.ts';
import { withConnection } from '../../src/database/pool.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
const clock = () => new Date();
let bulk: ReturnType<typeof createCollectionBulkOperations>;

beforeAll(async () => {
  f = await createProfileEntryFixture();
  bulk = createCollectionBulkOperations({ pool: f.pool, access: f.access, tokens: f.tokens, clock });
});
afterAll(async () => {
  await f?.close();
});

const subjectSelection = (subjectIds: string[]) => ({
  kind: 'explicit' as const,
  targets: subjectIds.map((subjectId) => ({ subjectId })),
});

async function preview(subjectIds: string[]) {
  const response = await f.send('owner', 'POST', '/v1/libraryOperations', {
    action: 'remove_from_library',
    selection: subjectSelection(subjectIds),
  });
  expect(response.status).toBe(201);
  return (await response.json()).operation;
}

async function entry() {
  const subjectId = await f.createSubject('game');
  return (await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing' }, entryKey())).value.entry;
}

function workerDependencies() {
  const actor = f.owner.actor;
  return {
    pool: f.pool,
    access: f.access,
    tokens: f.tokens,
    clock,
    readConsent: async ({ actorAccountId, clientId }: { actorAccountId: string; clientId: string }) =>
      actorAccountId === actor.accountId && clientId === actor.clientId
        ? { actorAccountId, clientId, scopes: actor.scopes }
        : null,
  };
}

test('explicit canonical subjects create an inert preview with native present and absent owner expectations', async () => {
  const tracked = await entry();
  const absent = await f.createSubject('game');
  const before = await f.inspect();
  const operation = await preview([tracked.subjectId, absent, tracked.subjectId]);
  const manifest = await withConnection(f.pool, (tx) =>
    pageCollectionBulkManifest(tx, {
      route: operation.route,
      accountId: f.owner.actor.accountId,
      operationId: operation.id,
    }),
  );
  const presentRow = before.entries.find(({ row }) => row.subject_id === tracked.subjectId)!.row;
  const ownerSeq = String(before.ownerCounter[0]!.row.seq);

  expect(operation).toMatchObject({ action: 'remove_from_library', phase: 'preview', counts: { targets: 2 } });
  expect(manifest.map(({ target }) => target.subjectId)).toEqual([tracked.subjectId, absent]);
  expect(manifest[0]!.target.expected).toEqual({
    kind: 'present',
    incarnation: tracked.incarnationId!,
    revision: tracked.revision,
    admissionSequence: String(presentRow.owner_write_seq),
  });
  expect(manifest[1]!.target.expected).toEqual({ kind: 'absent', slotGeneration: ownerSeq });
  expect((await f.inspect()).entries).toEqual(before.entries);
});

test('confirmation skips edited, recreated and owner-written absent targets individually', async () => {
  const edited = await entry();
  const recreated = await entry();
  const unchanged = await entry();
  const absent = await f.createSubject('game');
  const operation = await preview([absent, edited.subjectId, recreated.subjectId, unchanged.subjectId]);
  await bulk.confirm(f.owner.actor, operation.id, entryKey());

  await f.commands.putEntry(
    f.owner.actor,
    edited.subjectId,
    { state: 'planned', revision: edited.revision, incarnationId: edited.incarnationId! },
    entryKey(),
  );
  await f.commands.deleteEntry(f.owner.actor, recreated.subjectId, recreated.revision, entryKey(), recreated.incarnationId!);
  const replacement = (await f.commands.putEntry(f.owner.actor, recreated.subjectId, { state: 'playing' }, entryKey()))
    .value.entry;

  await runCollectionBulkPage(workerDependencies(), { route: operation.route, operationId: operation.id });
  const outcomes = (await bulk.outcomes(f.owner.actor, operation.id, {})).outcomes;
  const after = await f.inspect();

  expect(outcomes.map(({ state, reason }) => [state, reason])).toEqual([
    ['conflict', 'revision_mismatch'],
    ['conflict', 'revision_mismatch'],
    ['conflict', 'revision_mismatch'],
    ['applied', null],
  ]);
  expect(after.entries.some(({ row }) => row.subject_id === unchanged.subjectId)).toBe(false);
  expect(after.entries.some(({ row }) => row.subject_id === edited.subjectId)).toBe(true);
  expect(after.entries.find(({ row }) => row.subject_id === recreated.subjectId)!.row.incarnation_id).toBe(
    replacement.incarnationId,
  );
});
