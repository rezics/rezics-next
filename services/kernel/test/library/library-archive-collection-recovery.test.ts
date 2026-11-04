import { bundledRelease } from '@rezics/definitions/bundled';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createLibraryArchiveCollectionRecovery } from '../../src/library/library-archive-collection-recovery.ts';
import { routeOf } from '../../src/route/route.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

type Identity = Awaited<ReturnType<NativeProfileFixture['identity']>>;
let f: NativeProfileFixture, source: Identity;
let artifact: { manifest: Record<string, any>; records: Record<string, any>[] }, collectionId: string, subject: string;
const scopes = [
  'subject:read',
  'collection:read',
  'collection:create',
  'collection:update',
  'collection:delete',
  'library_entry:read',
  'library_entry:list',
  'copy:list',
  'progress_session:list',
  'library_pin:list',
  'library_pin:update',
];
const path = '/v1/libraryArchiveCollectionRecoveries';
async function json(person: Identity, method: string, url: string, body?: unknown, status = 200) {
  const response = await f.send(person.bearer, method, url, body);
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}
async function upload(person: Identity, rawKind?: string) {
  const copy = structuredClone(artifact);
  if (rawKind !== undefined) {
    copy.records.find((row) => row.section === 'collections' && row.collection_id === collectionId)!.presentation_kind =
      rawKind;
    copy.manifest.recordBytes = copy.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
    const rows = copy.records.filter((row) => row.section === 'collections');
    copy.manifest.sectionTotals.collections.recordBytes = rows.reduce(
      (sum, row) => sum + Buffer.byteLength(JSON.stringify(row)),
      0,
    );
  }
  return json(person, 'POST', path, { archiveBase64: Buffer.from(JSON.stringify(copy)).toString('base64') });
}
async function review(person: Identity, id: string, kind?: string | null) {
  const preview = await json(person, 'GET', `${path}/${id}/collections/${collectionId}/occurrences`);
  return json(person, 'POST', `${path}/${id}/review`, {
    collectionId,
    selectedOccurrenceIds: preview.occurrences.map((row: any) => row.sourceOccurrenceId),
    mappings: [{ sourceSubjectId: subject, targetSubjectId: subject }],
    ...(kind === undefined ? {} : { presentationKind: kind }),
  });
}
beforeAll(async () => {
  f = await createProfileEntryFixture();
  source = await f.identity(scopes);
  await f.send('steward', 'POST', '/v1/platform/exposure/collections:open');
  await f.send('steward', 'POST', '/v1/platform/exposure/personal_library:open');
  subject = await f.createSubject('game');
  const made = await json(
    source,
    'POST',
    '/v1/collections',
    {
      title: 'Portable presentation',
      visibility: 'private',
      presentationKind: 'ex:Child',
    },
    201,
  );
  collectionId = made.collection.id;
  const a = (await json(source, 'POST', `/v1/collections/${collectionId}/members`, { subjectId: subject }, 201)).member;
  const b = (await json(source, 'POST', `/v1/collections/${collectionId}/members`, { subjectId: subject }, 201)).member;
  await json(source, 'PATCH', `/v1/collections/${collectionId}/members/${a.id}`, { note: '' });
  await json(source, 'POST', `/v1/collections/${collectionId}/members/${b.id}:move`, { after: null });
  await json(source, 'PUT', `/v1/libraryPins/${collectionId}`, { revision: 0 });
  const capture = await json(source, 'POST', '/v1/libraryExports');
  const records = [];
  let cursor = capture.first,
    manifest;
  for (let pages = 0; cursor && pages < 100; pages++) {
    const page = await json(
      source,
      'GET',
      `/v1/libraryExports/${capture.exportId}/pages?cursor=${encodeURIComponent(cursor)}`,
    );
    records.push(...page.records);
    cursor = page.next;
    manifest = page.manifest ?? manifest;
  }
  expect(cursor).toBeNull();
  expect(manifest).toBeDefined();
  artifact = { manifest, records };
}, 120000);
afterAll(async () => {
  await f?.close();
});

test('actual export recovers an explicitly selected current Type, fresh private duplicate order, notes and pin', async () => {
  const owner = await f.identity(scopes),
    id = (await upload(owner)).uploadId;
  const preview = await json(owner, 'GET', `${path}/${id}/collections/${collectionId}/occurrences`);
  expect(preview.collection).toMatchObject({ presentationKind: 'ex:Child', presentationAdmissible: true });
  const chosen = await review(owner, id, 'ex:Child');
  expect(chosen.review.presentation.source).toBe('archived');
  const done = await json(owner, 'POST', `${path}/${id}/apply`, chosen.confirmation);
  expect(done).toMatchObject({
    state: 'complete',
    fullRestoration: false,
    presentation: { state: 'adopted', kind: 'ex:Child' },
  });
  expect(done.collectionId).not.toBe(collectionId);
  expect((await json(owner, 'GET', `/v1/collections/${done.collectionId}`)).collection).toMatchObject({
    presentationKind: 'ex:Child',
    presentationKindSource: 'owner',
    visibility: 'private',
    memberCount: 2,
  });
  const outcomes = await json(owner, 'GET', `${path}/${id}/outcomes`);
  expect(outcomes.outcomes.map((row: any) => [row.note, row.outcome])).toEqual([
    [null, 'applied'],
    ['', 'applied'],
  ]);
  expect(new Set(outcomes.outcomes.map((row: any) => row.nativeMemberId)).size).toBe(2);
  expect(done.pin.state).toBe('applied');
  await json(owner, 'DELETE', `/v1/collections/${done.collectionId}`);
}, 120000);

test('unknown evidence defaults to mixed; alternatives and replaced confirmations remain deliberate', async () => {
  for (const kind of [undefined, null, 'ex:Recipe'] as const) {
    const owner = await f.identity(scopes),
      id = (await upload(owner, 'ex:Retired')).uploadId;
    const preview = await json(owner, 'GET', `${path}/${id}/collections/${collectionId}/occurrences`);
    expect(preview.collection).toMatchObject({ presentationKind: 'ex:Retired', presentationAdmissible: false });
    const first = await review(owner, id, 'ex:Child'),
      chosen = await review(owner, id, kind);
    expect((await f.send(owner.bearer, 'POST', `${path}/${id}/apply`, first.confirmation)).status).toBe(409);
    const done = await json(owner, 'POST', `${path}/${id}/apply`, chosen.confirmation);
    expect(done.presentation).toMatchObject({
      state: kind ? 'adopted' : 'mixed',
      source: kind ? 'alternative' : 'mixed',
    });
    expect((await json(owner, 'GET', `/v1/collections/${done.collectionId}`)).collection.presentationKind).toBe(
      kind ?? null,
    );
  }
}, 120000);

test('current release changes refuse new create, while lost acknowledgement replays original accepted choice', async () => {
  const owner = await f.identity(scopes),
    id = (await upload(owner)).uploadId;
  const chosen = await review(owner, id, 'ex:Child');
  await f.activate(f.replacementDigest);
  const stale = await json(owner, 'POST', `${path}/${id}/apply`, chosen.confirmation);
  expect(stale).toMatchObject({
    collectionId: null,
    fullRestoration: false,
    presentation: { state: 'unsupported_or_stale' },
  });
  await f.activate(f.originalDigest);
  const revised = await review(owner, id, 'ex:Child');
  let accepted: string | undefined;
  const deps = { pool: f.pool, access: f.access, tokens: f.tokens, routeKey: testRouteKey(), clock: () => new Date() };
  const interrupted = createLibraryArchiveCollectionRecovery({
    ...deps,
    afterNativeEffect: async (kind) => {
      if (kind === 'create') {
        accepted = (
          await f.pool.query(
            `SELECT collection_id::text AS id FROM library.collection
        WHERE route=$1 AND curator_account_id=$2 ORDER BY created_at DESC LIMIT 1`,
            [routeOf(owner.actor.accountId), owner.actor.accountId],
          )
        ).rows[0].id;
        throw new Error('lost create acknowledgement');
      }
    },
  });
  await expect(interrupted.apply(owner.actor, id, revised.confirmation)).rejects.toThrow('lost create acknowledgement');
  await f.activate(await f.publish(bundledRelease));
  const replay = await createLibraryArchiveCollectionRecovery(deps).apply(owner.actor, id, revised.confirmation);
  expect(replay.collectionId).toBe(accepted!);
  expect(replay.presentation.state).toBe('adopted');
  expect((await json(owner, 'GET', `/v1/collections/${accepted}`)).collection.presentationKind).toBe('ex:Child');
  expect((await json(owner, 'POST', `${path}/${id}/apply`, revised.confirmation)).collectionId).toBe(accepted!);
  const cancelledId = (await upload(owner)).uploadId;
  const pending = await review(owner, cancelledId);
  await json(owner, 'DELETE', `${path}/${cancelledId}`);
  expect((await json(owner, 'POST', `${path}/${cancelledId}/apply`, pending.confirmation)).collectionId).toBeNull();
  await f.activate(f.originalDigest);
}, 120000);

test('Collection archive recovery journals each duplicate occurrence with withheld Subject context', async () => {
  const owner = await f.identity(scopes),
    id = (await upload(owner)).uploadId;
  const chosen = await review(owner, id, 'ex:Child');
  const recovered = await json(owner, 'POST', `${path}/${id}/apply`, chosen.confirmation);
  const history = await json(owner, 'GET', `/v1/collections/${recovered.collectionId}/structure-history`);
  const additions = history.changes.filter((change: { operation: string }) => change.operation === 'added');
  expect(additions).toHaveLength(2);
  expect(new Set(additions.map((change: { occurrenceId: string }) => change.occurrenceId)).size).toBe(2);
  expect(additions.every((change: { subjectContext: { state: string } }) => change.subjectContext.state === 'withheld'))
    .toBe(true);
  await json(owner, 'DELETE', `/v1/collections/${recovered.collectionId}`);
}, 120000);
