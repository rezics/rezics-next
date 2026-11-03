import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { readOwnerOriginalTruth } from '../../src/library/owner-index.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
let clockTime: number | undefined;
const clock = () => new Date(clockTime ?? Date.now());

beforeAll(async () => {
  f = await createProfileEntryFixture({ clock });
}, 120_000);
beforeEach(async () => {
  clockTime = undefined;
  await f.activate(f.originalDigest);
});
afterAll(async () => f?.close());

test('private annotations and reviewed provider observations have independent revisions, replay, privacy and source clocks', async () => {
  const subjectId = await f.createSubject('game');
  await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, entryKey());
  clockTime = Date.parse('2025-01-02T03:04:05.000Z');

  const annotationKey = entryKey();
  const saved = await f.send(
    'owner',
    'PUT',
    `/v1/libraryEntries/${subjectId}/annotations`,
    { revision: 0, note: { op: 'set', value: 'Read the revised edition.' }, priority: { op: 'set', value: 8 } },
    annotationKey,
  );
  expect(saved.status).toBe(200);
  const savedBody = await saved.json();
  expect(saved.headers.get('cache-control')).toBe('private, no-store');
  expect(savedBody.personalEntry).toMatchObject({ annotationRevision: 1, note: 'Read the revised edition.', priority: 8 });
  const replay = await f.send(
    'owner',
    'PUT',
    `/v1/libraryEntries/${subjectId}/annotations`,
    { revision: 0, note: { op: 'set', value: 'Read the revised edition.' }, priority: { op: 'set', value: 8 } },
    annotationKey,
  );
  expect(await replay.json()).toEqual(savedBody);

  const records = [
    {
      provider: 'mal', recordId: 'list/17', confirmReviewed: true,
      privacy: { status: 'known', meaning: 'private' },
      sourceCreated: { status: 'known', value: '2004-02' },
      sourceUpdated: { status: 'known', value: '2004-02-29T23:59:01.123+08:00' },
    },
    {
      provider: 'vndb', recordId: 'entry-2', confirmReviewed: true,
      privacy: { status: 'known', meaning: 'source_visible' },
      sourceCreated: { status: 'known', value: '2005' },
      sourceUpdated: { status: 'known', value: '2005-04-01T00:00-00:00' },
    },
    {
      provider: 'anilist', recordId: 'entry-3', confirmReviewed: true,
      privacy: { status: 'unknown', sourceValue: 'private_flag_v2' },
      sourceCreated: { status: 'absent' },
      sourceUpdated: { status: 'unknown', sourceValue: 'early 2004' },
    },
  ];
  for (const [index, record] of records.entries()) {
    const admissionKey = entryKey();
    const response = await f.send('owner', 'POST', `/v1/libraryEntries/${subjectId}/sourceObservations`, record, admissionKey);
    expect(response.status).toBe(201);
    if (index === 0) {
      const replay = await f.send('owner', 'POST', `/v1/libraryEntries/${subjectId}/sourceObservations`, record, admissionKey);
      expect(await replay.json()).toEqual(await response.json());
    }
  }
  const read = await f.send('owner', 'GET', `/v1/libraryEntries/${subjectId}/personal`);
  expect(read.status).toBe(200);
  const personal = (await read.json()).personalEntry;
  expect(personal.sourceObservations).toHaveLength(3);
  expect(personal.sourceObservations[0]).toMatchObject({
    provider: 'anilist',
    privacy: { status: 'unknown', sourceValue: 'private_flag_v2' },
    sourceCreated: { status: 'absent' },
    sourceUpdated: { status: 'unknown', sourceValue: 'early 2004' },
  });
  expect(personal.sourceObservations[1]).toMatchObject({
    provider: 'mal',
    privacy: { status: 'known', meaning: 'private' },
    sourceCreated: { status: 'known', value: '2004-02', precision: 'month', zone: 'unknown' },
    sourceUpdated: { status: 'known', value: '2004-02-29T23:59:01.123+08:00', precision: 'fraction', zone: 'offset' },
    recordedAt: '2025-01-02T03:04:05.000000Z',
  });
  expect(personal.sourceObservations[2]).toMatchObject({
    privacy: { status: 'known', meaning: 'source_visible' },
    sourceUpdated: { status: 'known', value: '2005-04-01T00:00-00:00', precision: 'minute', zone: 'unknown' },
  });
  expect(await f.commands.readEntry(f.owner.actor, subjectId)).toMatchObject({ state: 'planned' });

  const other = await f.send('other', 'GET', `/v1/libraryEntries/${subjectId}/personal`);
  expect(other.status).toBe(200);
  expect(await other.json()).toMatchObject({ personalEntry: { note: null, priority: null, sourceObservations: [] } });

  const clearKey = entryKey();
  const cleared = await f.send(
    'owner',
    'PUT',
    `/v1/libraryEntries/${subjectId}/annotations`,
    { revision: 1, note: { op: 'clear' }, priority: { op: 'unchanged' } },
    clearKey,
  );
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({ personalEntry: { annotationRevision: 2, note: null, priority: 8, sourceObservations: expect.any(Array) } });
  const stale = await f.send(
    'owner',
    'PUT',
    `/v1/libraryEntries/${subjectId}/annotations`,
    { revision: 1, note: { op: 'set', value: 'stale' }, priority: { op: 'unchanged' } },
  );
  expect(stale.status).toBe(409);

  const correctionKey = entryKey();
  clockTime = Date.parse('2025-02-03T04:05:06.000Z');
  const correctionBody = {
    provider: 'mal', recordId: 'list/17', revision: 1, confirmReviewed: true,
    privacy: { op: 'clear' }, sourceCreated: { op: 'unchanged' }, sourceUpdated: { op: 'clear' },
  };
  const corrected = await f.send(
    'owner',
    'PATCH',
    `/v1/libraryEntries/${subjectId}/sourceObservations`,
    correctionBody,
    correctionKey,
  );
  expect(corrected.status).toBe(200);
  expect(corrected.headers.get('cache-control')).toBe('private, no-store');
  const correctedBody = await corrected.json();
  const correctionReplay = await f.send(
    'owner', 'PATCH', `/v1/libraryEntries/${subjectId}/sourceObservations`, correctionBody, correctionKey,
  );
  expect(await correctionReplay.json()).toEqual(correctedBody);
  expect(correctedBody).toMatchObject({
    sourceObservation: {
      revision: 2,
      privacy: { status: 'cleared' },
      sourceCreated: { status: 'known', value: '2004-02', precision: 'month', zone: 'unknown' },
      sourceUpdated: { status: 'cleared' },
      recordedAt: '2025-02-03T04:05:06.000000Z',
    },
  });
  const staleCorrection = await f.send('owner', 'PATCH', `/v1/libraryEntries/${subjectId}/sourceObservations`, {
    provider: 'mal', recordId: 'list/17', revision: 1, confirmReviewed: true,
    privacy: { op: 'unchanged' }, sourceCreated: { op: 'clear' }, sourceUpdated: { op: 'unchanged' },
  });
  expect(staleCorrection.status).toBe(409);
  const duplicate = await f.send('owner', 'POST', `/v1/libraryEntries/${subjectId}/sourceObservations`, records[0]);
  expect(duplicate.status).toBe(409);
  const impossible = await f.send('owner', 'POST', `/v1/libraryEntries/${subjectId}/sourceObservations`, {
    provider: 'mal', recordId: 'bad-date', confirmReviewed: true, privacy: { status: 'unknown' },
    sourceCreated: { status: 'known', value: '2023-02-29' }, sourceUpdated: { status: 'absent' },
  });
  expect(impossible.status).toBe(400);
});

test('annotation-only and provenance-only facts support Everything without creating explicit state', async () => {
  const route = routeOf(f.owner.actor.accountId)!;
  async function supported(subjectId: string) {
    const { rows } = await f.pool.query<{ present: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM library.owner_member_index WHERE route=$1 AND account_id=$2 AND subject_id=$3) AS present',
      [route, f.owner.actor.accountId, subjectId],
    );
    return rows[0]?.present ?? false;
  }
  async function truth(subjectId: string) {
    return readOwnerOriginalTruth(f.pool, f.owner.actor.accountId, subjectId);
  }

  const annotationOnly = await f.createSubject('recipe');
  const annotation = await f.send('owner', 'PUT', `/v1/libraryEntries/${annotationOnly}/annotations`, {
    revision: 0, note: { op: 'set', value: 'Owner-only note' }, priority: { op: 'unchanged' },
  });
  expect(annotation.status).toBe(200);
  expect((await truth(annotationOnly)).presence).toBe(true);
  expect(await supported(annotationOnly)).toBe(true);
  expect((await f.pool.query('SELECT 1 FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', [route, f.owner.actor.accountId, annotationOnly])).rowCount).toBe(0);

  const cleared = await f.send('owner', 'PUT', `/v1/libraryEntries/${annotationOnly}/annotations`, {
    revision: 1, note: { op: 'clear' }, priority: { op: 'unchanged' },
  });
  expect(cleared.status).toBe(200);
  expect((await truth(annotationOnly)).presence).toBe(false);
  expect(await supported(annotationOnly)).toBe(false);

  const provenanceOnly = await f.createSubject('record');
  const source = await f.send('owner', 'POST', `/v1/libraryEntries/${provenanceOnly}/sourceObservations`, {
    provider: 'vndb', recordId: 'record-only', confirmReviewed: true,
    privacy: { status: 'unknown' }, sourceCreated: { status: 'absent' }, sourceUpdated: { status: 'absent' },
  });
  expect(source.status).toBe(201);
  expect((await truth(provenanceOnly)).presence).toBe(true);
  expect(await supported(provenanceOnly)).toBe(true);
  expect((await f.pool.query('SELECT 1 FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', [route, f.owner.actor.accountId, provenanceOnly])).rowCount).toBe(0);
});
