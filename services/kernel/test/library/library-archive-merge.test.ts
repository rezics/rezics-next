import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { createEntryPersonalCommands } from '../../src/library/entry-personal.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands.ts';
import { createSessionCommands } from '../../src/library/sessions.ts';
import { createVoteCommands, STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

type Identity = Awaited<ReturnType<NativeProfileFixture['identity']>>;
type RecordRow = Record<string, unknown> & { section: string };
type Archive = { manifest: Record<string, unknown>; records: RecordRow[] };
const exportScopes = [
  'subject:create',
  'subject:read',
  'library_entry:read',
  'library_entry:list',
  'library_entry:update',
  'library_entry:delete',
  'copy:list',
  'progress_session:list',
  'progress_session:create',
  'progress_session:update',
  'progress_session:read',
  'collection:read',
];
const mergePath = '/v1/libraryArchiveMerges';
const mergeScopes = [...exportScopes, 'account:delete'];
const key = () => randomUUID();
let f: NativeProfileFixture;
let source: Identity, main: Identity, createOwner: Identity, staleRevision: Identity, staleIncarnation: Identity;
let unknownStateOwner: Identity, cancelledOwner: Identity, deletedOwner: Identity;
let staleFactOwner: Identity, missingFactOwner: Identity, pruneOwner: Identity;
let duplicateOwner: Identity, correctionOwner: Identity, capOwner: Identity, identityOwner: Identity;
let subjects: [string, string];
let artifact: Archive;
let sourceLabels: [string, string];
let sourceSessionId: string;
let repeatedSourceSessionId: string;
let targetSessionId: string;
let repeatedTargetSessionId: string;

function send(person: Identity, method: string, path: string, body?: unknown) {
  return f.send(person.bearer, method, path, body, key());
}
async function json(response: Response, status = 200) {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  expect(response.headers.get('cache-control')).toContain('no-store');
  return response.json() as Promise<Record<string, any>>;
}
function framed(records: RecordRow[], manifest: Record<string, unknown> = artifact.manifest): Archive {
  const recordBytes = records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  const sectionTotals = Object.fromEntries(
    Object.keys((manifest.sectionTotals as Record<string, unknown> | undefined) ?? {}).map((section) => {
      const rows = records.filter((row) => row.section === section);
      return [
        section,
        { rows: rows.length, recordBytes: rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0) },
      ];
    }),
  );
  return {
    manifest: {
      ...manifest,
      rows: records.length,
      recordBytes,
      ...(Object.keys(sectionTotals).length ? { sectionTotals } : {}),
    },
    records,
  };
}
async function upload(person: Identity, value: unknown = artifact) {
  return json(await send(person, 'POST', mergePath, value));
}
async function previewAll(person: Identity, id: string, limit = 100) {
  return json(await send(person, 'GET', `${mergePath}/${id}/preview?limit=${limit}`));
}
function selected(ordinals: number[], reviewRevision = 1) {
  return { items: ordinals.map((ordinal) => ({ ordinal, reviewRevision })) };
}
function selectedFrom(records: any[], ordinals: number[]) {
  return {
    items: ordinals.map((ordinal) => {
      const row = records.find((item) => item.ordinal === ordinal);
      return { ordinal, reviewRevision: row.reviewRevision };
    }),
  };
}
async function makeUpload(person: Identity, value: unknown = artifact) {
  const status = await upload(person, value);
  return { id: status.uploadId as string, status };
}

beforeAll(async () => {
  f = await createProfileEntryFixture();
  for (const group of ['personal_library', 'reading_progress', 'collections'])
    expect((await f.send('steward', 'POST', `/v1/platform/exposure/${group}:open`)).status).toBe(200);
  source = await f.identity(exportScopes);
  main = await f.identity([...mergeScopes, 'rating:vote']);
  createOwner = await f.identity(mergeScopes);
  staleRevision = await f.identity(mergeScopes);
  staleIncarnation = await f.identity(mergeScopes);
  unknownStateOwner = await f.identity(mergeScopes);
  cancelledOwner = await f.identity(mergeScopes);
  deletedOwner = await f.identity(mergeScopes);
  staleFactOwner = await f.identity(mergeScopes);
  missingFactOwner = await f.identity(mergeScopes);
  pruneOwner = await f.identity(mergeScopes);
  duplicateOwner = await f.identity(mergeScopes);
  correctionOwner = await f.identity(mergeScopes);
  capOwner = await f.identity(mergeScopes);
  identityOwner = await f.identity([...mergeScopes, 'subject:merge', 'gate:subject_identity']);
  const archiveGrants = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
  await archiveGrants.create(
    { pool: f.pool, actor: f.steward.actor, deadline: deadlineFor(30_000) },
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: identityOwner.actor.accountId },
      actions: ['subject:merge', 'gate:subject_identity'],
      valid: '(,)',
      key: key(),
    },
  );
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/subject_identity:open')).status).toBe(200);

  async function createSubject(label: string) {
    const response = await send(source, 'POST', '/v1/subjects', { type: 'ex:Child', labels: { en: label } });
    const result = await json(response, 201);
    return (result.subject as { id: string }).id;
  }
  subjects = [await createSubject('archive first subject'), await createSubject('archive second subject')];
  await createVoteCommands({ pool: f.pool, access: f.access }).putVoteOutcome(
    main.actor,
    { questionId: STANDARD_QUESTION_ID, targetId: subjects[0], units: 7 },
    key(),
  );
  await f.commands.putEntry(source.actor, subjects[0], { state: 'planned' }, entryKey());
  await f.commands.putEntry(source.actor, subjects[1], { state: 'playing' }, entryKey());

  const sourceLabelCommands = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
  const first = await sourceLabelCommands.createLabel(source.actor, { name: 'archive existing' }, key());
  const second = await sourceLabelCommands.createLabel(source.actor, { name: 'archive second' }, key());
  sourceLabels = [first.value.label.id, second.value.label.id];
  await createLabelAssignmentCommands({ pool: f.pool, access: f.access, tokens: f.tokens }).assignLabel(
    source.actor,
    sourceLabels[1],
    { subjectId: subjects[1] },
    key(),
  );

  await f.commands.putEntry(main.actor, subjects[0], { state: 'in_progress' }, entryKey());
  await f.commands.putEntry(main.actor, subjects[1], { state: 'completed' }, entryKey());
  const personal = createEntryPersonalCommands({ pool: f.pool, access: f.access });
  await personal.saveAnnotations(
    source.actor,
    subjects[0],
    {
      revision: 0,
      note: { op: 'set', value: 'Recovered owner note' },
      priority: { op: 'set', value: 42 },
    },
    key(),
  );
  await personal.saveAnnotations(
    main.actor,
    subjects[0],
    { revision: 0, note: { op: 'set', value: 'Current private note' }, priority: { op: 'set', value: 9 } },
    key(),
  );
  await personal.admitSourceObservation(
    source.actor,
    subjects[0],
    {
      provider: 'archive-fixture',
      recordId: 'source-visible-row',
      confirmReviewed: true,
      privacy: { status: 'known', meaning: 'source_visible' },
      sourceCreated: { status: 'known', value: '2022-11-17T14:03:04.123456789-00:00' },
      sourceUpdated: { status: 'unknown', sourceValue: 'source-clock-pending' },
    },
    key(),
  );
  await personal.admitSourceObservation(
    source.actor,
    subjects[0],
    {
      provider: 'archive-fixture',
      recordId: 'unknown-and-partial-row',
      confirmReviewed: true,
      privacy: { status: 'unknown', sourceValue: 'source_future_visibility' },
      sourceCreated: { status: 'known', value: '1984-02' },
      sourceUpdated: { status: 'absent' },
    },
    key(),
  );
  await personal.admitSourceObservation(
    source.actor,
    subjects[0],
    {
      provider: 'archive-fixture',
      recordId: 'cleared-row',
      confirmReviewed: true,
      privacy: { status: 'absent' },
      sourceCreated: { status: 'absent' },
      sourceUpdated: { status: 'absent' },
    },
    key(),
  );
  await personal.correctSourceObservation(
    source.actor,
    subjects[0],
    {
      provider: 'archive-fixture',
      recordId: 'cleared-row',
      revision: 1,
      confirmReviewed: true,
      privacy: { op: 'clear' },
      sourceCreated: { op: 'clear' },
      sourceUpdated: { op: 'set', value: { status: 'known', value: '2017' } },
    },
    key(),
  );
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  const sourceSession = await sessions.startSession(
    source.actor,
    { subjectId: subjects[0], mode: 'scalar_amount', unit: 'page' },
    key(),
  );
  sourceSessionId = sourceSession.value.id;
  await sessions.patchSessionJournal(
    source.actor,
    sourceSessionId,
    {
      revision: 0,
      startDate: { year: 2004, month: 2 },
      finishDate: { year: 2021, month: 6, day: 7 },
      reflection: '  A historical private reflection.\n',
      assessment: { units: 14 },
    },
    key(),
  );
  const repeatedSourceSession = await sessions.startSession(
    source.actor,
    { subjectId: subjects[0], mode: 'scalar_amount', unit: 'page' },
    key(),
  );
  repeatedSourceSessionId = repeatedSourceSession.value.id;
  await sessions.patchSessionJournal(
    source.actor,
    repeatedSourceSessionId,
    { revision: 0, reflection: 'A separate occurrence fact.', assessment: { units: 0 } },
    key(),
  );
  const targetSession = await sessions.startSession(
    main.actor,
    { subjectId: subjects[0], mode: 'scalar_amount', unit: 'page' },
    key(),
  );
  targetSessionId = targetSession.value.id;
  await sessions.patchSessionJournal(
    main.actor,
    targetSessionId,
    {
      revision: 0,
      startDate: { year: 2019 },
      finishDate: { year: 2020, month: 3 },
      reflection: 'Keep target reflection unless explicitly changed.',
      assessment: { units: 8 },
    },
    key(),
  );
  const repeatedTargetSession = await sessions.startSession(
    main.actor,
    { subjectId: subjects[0], mode: 'scalar_amount', unit: 'page' },
    key(),
  );
  repeatedTargetSessionId = repeatedTargetSession.value.id;
  await sessions.patchSessionJournal(
    main.actor,
    repeatedTargetSessionId,
    { revision: 0, assessment: { units: 20 } },
    key(),
  );
  const targetLabels = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
  await targetLabels.createLabel(main.actor, { name: 'my chosen label' }, key());

  const created = await json(await send(source, 'POST', '/v1/libraryExports'));
  // Read the V3 schema from the installed producer while V4 provider sections stay unsupported.
  await f.pool.query(
    'UPDATE library.library_export SET format_version=3 WHERE route=$1 AND account_id=$2 AND export_id=$3',
    [routeOf(source.actor.accountId), source.actor.accountId, created.exportId],
  );
  const captured = await json(await send(source, 'GET', `/v1/libraryExports/${created.exportId}`));
  const records: RecordRow[] = [];
  let cursor = captured.first as string | null;
  let manifest: Record<string, unknown> | null = null;
  for (let pages = 0; cursor && pages < 100; pages++) {
    const page = await json(
      await send(source, 'GET', `/v1/libraryExports/${captured.exportId}/pages?cursor=${encodeURIComponent(cursor)}`),
    );
    records.push(...(page.records as RecordRow[]));
    cursor = page.next as string | null;
    manifest = (page.manifest as Record<string, unknown> | null) ?? manifest;
  }
  expect(cursor).toBeNull();
  expect(manifest).not.toBeNull();
  artifact = { manifest: manifest!, records };
  expect(records.filter((row) => row.section === 'entries')).toHaveLength(2);
  expect(records.filter((row) => row.section === 'labels')).toHaveLength(2);
  expect(records.filter((row) => row.section === 'assignments')).toHaveLength(1);
  expect(records.filter((row) => row.section === 'journals')).toHaveLength(2);
  expect(artifact.manifest.version).toBe(3);
  expect(artifact.manifest.recordBytes).toBe(
    records.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row), 'utf8'), 0),
  );
  expect(Object.keys(artifact.manifest.sectionTotals as Record<string, unknown>)).toHaveLength(17);
}, 120_000);

afterAll(async () => {
  await f?.close();
});

test('the actual installed archive is privately reviewed, explicitly merged and replayed through native commands', async () => {
  const wrong = framed(artifact.records);
  expect(wrong.manifest.version).toBe(3);
  const publicVoteCommands = createVoteCommands({ pool: f.pool, access: f.access });
  const publicVoteBefore = await publicVoteCommands.readOwnVote(main.actor, STANDARD_QUESTION_ID, subjects[0]);
  expect(publicVoteBefore?.units).toBe(7);
  const acceptedArchive = await upload(main, wrong);
  const id = acceptedArchive.uploadId as string;
  expect((await send(main, 'POST', mergePath, { records: artifact.records })).status).toBe(400);
  expect((await send(main, 'POST', mergePath, framed([...artifact.records, artifact.records[0]!]))).status).toBe(400);
  const label = artifact.records.find((row) => row.section === 'labels')!;
  const duplicateName = { ...label, label_id: randomUUID() } as RecordRow;
  const duplicateNameResponse = await send(main, 'POST', mergePath, framed([...artifact.records, duplicateName]));
  expect(duplicateNameResponse.status).toBe(400);
  expect(await duplicateNameResponse.text()).not.toContain('archive second');

  expect((await send(source, 'GET', `${mergePath}/${id}`)).status).toBe(404);
  expect((await send(source, 'POST', `${mergePath}/${id}/apply`, selected([0]))).status).toBe(404);
  const rows: Record<string, any>[] = [];
  let after = -1;
  while (true) {
    const page = await json(await send(main, 'GET', `${mergePath}/${id}/preview?after=${after}&limit=1`));
    rows.push(...page.records);
    if (page.next === null) break;
    after = page.next as number;
  }
  expect((await previewAll(main, id)).coverage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ section: 'sessions', treatment: 'retained-unsupported' }),
      expect.objectContaining({ section: 'holdings', treatment: 'retained-unsupported' }),
      expect.objectContaining({ section: 'collections', treatment: 'retained-unsupported' }),
      expect.objectContaining({ section: 'annotations', treatment: 'requires-explicit-mapping', rows: 1 }),
      expect.objectContaining({ section: 'journals', treatment: 'requires-explicit-mapping', rows: 2 }),
      expect.objectContaining({ section: 'provenance', treatment: 'requires-explicit-mapping', rows: 3 }),
    ]),
  );
  const entryOne = rows.find((row) => row.section === 'entries' && row.evidence.subject_id === subjects[0])!;
  const entryTwo = rows.find((row) => row.section === 'entries' && row.evidence.subject_id === subjects[1])!;
  const labelOne = rows.find((row) => row.section === 'labels' && row.evidence.label_id === sourceLabels[0])!;
  const labelTwo = rows.find((row) => row.section === 'labels' && row.evidence.label_id === sourceLabels[1])!;
  const assignment = rows.find((row) => row.section === 'assignments')!;
  const annotation = rows.find((row) => row.section === 'annotations' && row.evidence.subjectId === subjects[0])!;
  const journalItem = rows.find((row) => row.section === 'journals' && row.evidence.sessionId === sourceSessionId)!;
  const provenanceRows = rows.filter((row) => row.section === 'provenance');
  const visibleProvenance = provenanceRows.find((row) => row.evidence.observation.recordId === 'source-visible-row')!;
  const unknownProvenance = provenanceRows.find(
    (row) => row.evidence.observation.recordId === 'unknown-and-partial-row',
  )!;
  const clearedProvenance = provenanceRows.find((row) => row.evidence.observation.recordId === 'cleared-row')!;
  expect(provenanceRows.every((row) => row.status === 'unresolved')).toBe(true);
  expect(visibleProvenance.evidence.observation.privacy).toEqual({ status: 'known', meaning: 'source_visible' });
  expect(visibleProvenance.evidence.observation.sourceCreated).toEqual({
    status: 'known',
    value: '2022-11-17T14:03:04.123456789-00:00',
    precision: 'fraction',
    zone: 'unknown',
  });
  const repeatedJournalItem = rows.find(
    (row) => row.section === 'journals' && row.evidence.sessionId === repeatedSourceSessionId,
  )!;
  const targetLabels = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
  const existingLabel = (await targetLabels.listLabels(main.actor, { limit: 100 })).labels[0]!;
  const initialReview = await json(
    await send(main, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        { ordinal: entryOne.ordinal, kind: 'entry', subjectId: subjects[0], stateId: 'planned', action: 'update' },
        { ordinal: entryTwo.ordinal, kind: 'entry', subjectId: subjects[1], action: 'preserve' },
        { ordinal: labelOne.ordinal, kind: 'label', target: { mode: 'existing', labelId: existingLabel.id } },
        { ordinal: labelTwo.ordinal, kind: 'label', target: { mode: 'create' } },
        {
          ordinal: annotation.ordinal,
          kind: 'annotation',
          subjectId: subjects[0],
          incarnationId: (await f.commands.readEntry(main.actor, subjects[0])).incarnationId,
          fields: { note: 'set', priority: 'preserve' },
        },
        {
          ordinal: journalItem.ordinal,
          kind: 'journal',
          subjectId: subjects[0],
          sessionId: targetSessionId,
          fields: { startDate: 'set', finishDate: 'preserve', reflection: 'set', assessment: 'set' },
        },
        {
          ordinal: repeatedJournalItem.ordinal,
          kind: 'journal',
          subjectId: subjects[0],
          sessionId: repeatedTargetSessionId,
          fields: { assessment: 'set' },
        },
        {
          ordinal: visibleProvenance.ordinal,
          kind: 'observation',
          subjectId: subjects[0],
          provider: 'archive-fixture',
          recordId: 'source-visible-row',
          action: 'admit',
          fields: { privacy: 'set', sourceCreated: 'set', sourceUpdated: 'set' },
        },
        {
          ordinal: unknownProvenance.ordinal,
          kind: 'observation',
          subjectId: subjects[0],
          provider: 'archive-fixture',
          recordId: 'unknown-and-partial-row',
          action: 'admit',
          fields: { privacy: 'set', sourceCreated: 'set', sourceUpdated: 'set' },
        },
        {
          ordinal: clearedProvenance.ordinal,
          kind: 'observation',
          subjectId: subjects[0],
          provider: 'archive-fixture',
          recordId: 'cleared-row',
          action: 'admit',
          fields: { privacy: 'clear', sourceCreated: 'clear', sourceUpdated: 'set' },
        },
      ],
    }),
  );
  await json(
    await send(main, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        {
          ordinal: annotation.ordinal,
          kind: 'annotation',
          subjectId: subjects[0],
          incarnationId: (await f.commands.readEntry(main.actor, subjects[0])).incarnationId,
          fields: { note: 'set', priority: 'clear' },
        },
      ],
    }),
  );
  const staleSelection = {
    items: initialReview.reviewed
      .filter((row: any) => row.ordinal === entryOne.ordinal || row.ordinal === annotation.ordinal)
      .map(({ ordinal, reviewRevision }: { ordinal: number; reviewRevision: number }) => ({ ordinal, reviewRevision })),
  };
  expect((await send(main, 'POST', `${mergePath}/${id}/apply`, staleSelection)).status).toBe(409);
  expect((await f.commands.readEntry(main.actor, subjects[0])).state).toBe('in_progress');
  const refreshed = await previewAll(main, id);
  const reviewedAnnotation = refreshed.records.find((row: any) => row.ordinal === annotation.ordinal)!;
  const reviewedJournal = refreshed.records.find((row: any) => row.ordinal === journalItem.ordinal)!;
  const reviewedRepeatedJournal = refreshed.records.find((row: any) => row.ordinal === repeatedJournalItem.ordinal)!;
  expect(reviewedAnnotation.reviewRevision).toBe(
    initialReview.reviewed.find((row: any) => row.ordinal === annotation.ordinal).reviewRevision + 1,
  );
  expect(
    refreshed.records.filter((row: any) => provenanceRows.some((item) => item.ordinal === row.ordinal)),
  ).toMatchObject([
    { status: 'mapped', review: { visibility: 'private', action: 'admit' } },
    { status: 'mapped', review: { visibility: 'private', action: 'admit' } },
    { status: 'mapped', review: { visibility: 'private', action: 'admit' } },
  ]);
  expect(reviewedAnnotation.review.fields).toEqual({ note: 'set', priority: 'clear' });
  expect(reviewedJournal.review.fields).toEqual({
    startDate: 'set',
    finishDate: 'preserve',
    reflection: 'set',
    assessment: 'set',
  });
  expect(reviewedRepeatedJournal.review.fields).toEqual({ assessment: 'set' });
  const personal = createEntryPersonalCommands({ pool: f.pool, access: f.access });
  const visibleReview = refreshed.records.find((row: any) => row.ordinal === visibleProvenance.ordinal)!;
  const retainedObservation = await f.pool.query<{ review_revision: number; record_json: string }>(
    `SELECT review_revision,record_json FROM library.library_archive_merge_item
     WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
    [routeOf(main.actor.accountId), main.actor.accountId, id, visibleProvenance.ordinal],
  );
  const observationRevision = retainedObservation.rows[0]!.review_revision;
  const observationKey = `archive-merge-${id.replaceAll('-', '')}-${visibleProvenance.ordinal}-${observationRevision}`;
  const archiveReviewGuard = {
    uploadId: id,
    ordinal: visibleProvenance.ordinal,
    reviewRevision: observationRevision,
    sourceFingerprint: createHash('sha256').update(retainedObservation.rows[0]!.record_json).digest('hex'),
    action: 'admit',
    expectedRevision: null,
    fields: { privacy: 'set', sourceCreated: 'set', sourceUpdated: 'set' },
    profileGuard: visibleReview.review.profile,
  };
  const observationOperands = {
    subjectId: subjects[0],
    provider: 'archive-fixture',
    recordId: 'source-visible-row',
    confirmReviewed: true,
    privacy: { status: 'known', meaning: 'source_visible' },
    sourceCreated: {
      status: 'known',
      value: '2022-11-17T14:03:04.123456789-00:00',
      precision: 'fraction',
      zone: 'unknown',
    },
    sourceUpdated: { status: 'unknown', sourceValue: 'source-clock-pending' },
    archiveReviewGuard,
  };
  await f.pool.query(
    `UPDATE library.library_archive_merge_item SET status='applying',native_command_kind='observation',
      native_request_key=$5,native_operands=$6::jsonb
     WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
    [
      routeOf(main.actor.accountId),
      main.actor.accountId,
      id,
      visibleProvenance.ordinal,
      observationKey,
      JSON.stringify(observationOperands),
    ],
  );
  const committedObservation = await personal.admitSourceObservation(
    main.actor,
    subjects[0],
    {
      provider: 'archive-fixture',
      recordId: 'source-visible-row',
      confirmReviewed: true,
      privacy: { status: 'known', meaning: 'source_visible' },
      sourceCreated: { status: 'known', value: '2022-11-17T14:03:04.123456789-00:00' },
      sourceUpdated: { status: 'unknown', sourceValue: 'source-clock-pending' },
    },
    observationKey,
    archiveReviewGuard,
  );
  expect(committedObservation.value.sourceObservation.revision).toBe(1);
  const replayedObservation = await json(
    await send(main, 'POST', `${mergePath}/${id}/apply`, selectedFrom(refreshed.records, [visibleProvenance.ordinal])),
  );
  expect(replayedObservation.applied).toMatchObject([
    {
      status: 'accepted',
      result: {
        outcome: 'accepted',
        sourceObservation: {
          revision: 1,
          privacy: { status: 'known', meaning: 'source_visible' },
        },
      },
    },
  ]);
  expect(
    (
      await send(main, 'PATCH', `${mergePath}/${id}/review`, {
        items: [
          {
            ordinal: visibleProvenance.ordinal,
            kind: 'observation',
            subjectId: subjects[0],
            provider: 'archive-fixture',
            recordId: 'source-visible-row',
            action: 'admit',
            fields: { privacy: 'set', sourceCreated: 'set', sourceUpdated: 'set' },
          },
        ],
      })
    ).status,
  ).toBe(409);
  const observationReceipt = await f.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM core.receipt
     WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
       AND command_kind='library.entry.source-observation.admit' AND idempotency_key=$3`,
    [partitionOf(routeOf(main.actor.accountId)!), main.actor.accountId, observationKey],
  );
  expect(observationReceipt.rows[0]?.count).toBe('1');
  const currentAnnotation = await personal.readPersonalEntry(main.actor, subjects[0]);
  const currentEntry = await f.commands.readEntry(main.actor, subjects[0]);
  const annotationEpoch = await f.pool.query<{ review_revision: number }>(
    `SELECT review_revision FROM library.library_archive_merge_item
     WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
    [routeOf(main.actor.accountId), main.actor.accountId, id, annotation.ordinal],
  );
  const nativeRequestKey = `archive-merge-${id.replaceAll('-', '')}-${annotation.ordinal}-${annotationEpoch.rows[0]!.review_revision}`;
  const nativeOperands = {
    subjectId: subjects[0],
    incarnationId: currentEntry.incarnationId,
    entryRevision: currentEntry.revision,
    annotationRevision: currentAnnotation.annotationRevision,
    profile: reviewedAnnotation.review.profile,
    fields: {
      note: { op: 'set', value: annotation.evidence.note, outcome: 'accepted' },
      priority: { op: 'clear', outcome: 'accepted' },
    },
  };
  await f.pool.query(
    `UPDATE library.library_archive_merge_item SET status='applying',native_command_kind='annotation',
      native_request_key=$5,native_operands=$6::jsonb
     WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
    [
      routeOf(main.actor.accountId),
      main.actor.accountId,
      id,
      annotation.ordinal,
      nativeRequestKey,
      JSON.stringify(nativeOperands),
    ],
  );
  await personal.saveAnnotations(
    main.actor,
    subjects[0],
    {
      revision: currentAnnotation.annotationRevision,
      entryGuard: {
        incarnationId: currentEntry.incarnationId,
        currentRevision: currentEntry.revision,
        profileGuard: reviewedAnnotation.review.profile,
      },
      note: { op: 'set', value: annotation.evidence.note },
      priority: { op: 'clear' },
    },
    nativeRequestKey,
  );
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  const sessionBefore = await sessions.readSession(main.actor, targetSessionId);
  const journalBefore = await sessions.readSessionJournal(main.actor, targetSessionId);
  const repeatedJournalBefore = await sessions.readSessionJournal(main.actor, repeatedTargetSessionId);
  const progressChangesBefore = await f.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM library.progress_change WHERE route=$1 AND account_id=$2 AND session_id=$3',
    [routeOf(main.actor.accountId), main.actor.accountId, targetSessionId],
  );
  const historyBefore = await f.pool.query(
    'SELECT revision FROM library.entry_state_change WHERE route=$1 AND account_id=$2 AND subject_id=$3 ORDER BY revision',
    [routeOf(main.actor.accountId), main.actor.accountId, subjects[0]],
  );
  const appliedEntries = await json(
    await send(main, 'POST', `${mergePath}/${id}/apply`, selected([entryOne.ordinal, entryTwo.ordinal])),
  );
  expect(appliedEntries.applied).toMatchObject([{ status: 'acknowledged' }, { status: 'preserved' }]);
  expect((await f.commands.readEntry(main.actor, subjects[0])).state).toBe('planned');
  expect((await f.commands.readEntry(main.actor, subjects[1])).state).toBe('completed');
  const historyAfter = await f.pool.query(
    'SELECT revision FROM library.entry_state_change WHERE route=$1 AND account_id=$2 AND subject_id=$3 ORDER BY revision',
    [routeOf(main.actor.accountId), main.actor.accountId, subjects[0]],
  );
  expect(historyAfter.rows.length).toBe(historyBefore.rows.length + 1);

  const appliedFacts = await json(
    await send(main, 'POST', `${mergePath}/${id}/apply`, {
      ...selectedFrom(refreshed.records, [
        annotation.ordinal,
        journalItem.ordinal,
        repeatedJournalItem.ordinal,
        visibleProvenance.ordinal,
        unknownProvenance.ordinal,
        clearedProvenance.ordinal,
      ]),
    }),
  );
  expect(appliedFacts.applied).toMatchObject([
    {
      status: 'accepted',
      result: { outcome: 'accepted', visibility: 'private', fields: { note: 'accepted', priority: 'accepted' } },
    },
    {
      status: 'accepted',
      result: {
        outcome: 'accepted',
        fields: { startDate: 'accepted', finishDate: 'preserved', reflection: 'accepted', assessment: 'accepted' },
      },
    },
    { status: 'accepted', result: { outcome: 'accepted', fields: { assessment: 'accepted' } } },
    {
      status: 'accepted',
      result: {
        outcome: 'accepted',
        effect: 'entry.source-observation.admit',
        visibility: 'private',
        sourceObservation: {
          privacy: { status: 'known', meaning: 'source_visible' },
          sourceCreated: {
            status: 'known',
            value: '2022-11-17T14:03:04.123456789-00:00',
            precision: 'fraction',
            zone: 'unknown',
          },
          sourceUpdated: { status: 'unknown', sourceValue: 'source-clock-pending' },
        },
      },
    },
    {
      status: 'accepted',
      result: {
        outcome: 'accepted',
        visibility: 'private',
        sourceObservation: {
          privacy: { status: 'unknown', sourceValue: 'source_future_visibility' },
          sourceCreated: { status: 'known', value: '1984-02', precision: 'month', zone: 'unknown' },
          sourceUpdated: { status: 'absent' },
        },
      },
    },
    {
      status: 'accepted',
      result: {
        outcome: 'accepted',
        visibility: 'private',
        sourceObservation: {
          privacy: { status: 'cleared' },
          sourceCreated: { status: 'cleared' },
          sourceUpdated: { status: 'known', value: '2017', precision: 'year', zone: 'unknown' },
        },
      },
    },
  ]);
  const recoveredVisible = await personal.readSourceObservation(
    main.actor,
    subjects[0],
    'archive-fixture',
    'source-visible-row',
  );
  const recoveredUnknown = await personal.readSourceObservation(
    main.actor,
    subjects[0],
    'archive-fixture',
    'unknown-and-partial-row',
  );
  const recoveredCleared = await personal.readSourceObservation(
    main.actor,
    subjects[0],
    'archive-fixture',
    'cleared-row',
  );
  expect(recoveredVisible).toMatchObject({
    privacy: { status: 'known', meaning: 'source_visible' },
    sourceCreated: {
      status: 'known',
      value: '2022-11-17T14:03:04.123456789-00:00',
      precision: 'fraction',
      zone: 'unknown',
    },
    sourceUpdated: { status: 'unknown', sourceValue: 'source-clock-pending' },
  });
  expect(recoveredUnknown).toMatchObject({
    privacy: { status: 'unknown', sourceValue: 'source_future_visibility' },
    sourceCreated: { status: 'known', value: '1984-02', precision: 'month', zone: 'unknown' },
    sourceUpdated: { status: 'absent' },
  });
  expect(recoveredCleared).toMatchObject({
    privacy: { status: 'cleared' },
    sourceCreated: { status: 'cleared' },
    sourceUpdated: { status: 'known', value: '2017', precision: 'year', zone: 'unknown' },
  });
  expect(Date.parse(recoveredVisible!.recordedAt)).toBeGreaterThan(
    Date.parse(visibleProvenance.evidence.observation.recordedAt),
  );
  expect((await personal.readPersonalEntry(main.actor, subjects[0])).note).toBe('Recovered owner note');
  expect((await personal.readPersonalEntry(main.actor, subjects[0])).priority).toBeNull();
  const recoveredJournal = await sessions.readSessionJournal(main.actor, targetSessionId);
  expect(recoveredJournal).toMatchObject({
    startDate: { year: 2004, month: 2 },
    finishDate: { year: 2020, month: 3 },
    reflection: '  A historical private reflection.\n',
    assessment: { meaningRevision: 1, units: 14 },
  });
  expect(await publicVoteCommands.readOwnVote(main.actor, STANDARD_QUESTION_ID, subjects[0])).toEqual(publicVoteBefore);
  expect(recoveredJournal.finishDate).toEqual(journalBefore.finishDate);
  expect(recoveredJournal.revision).toBe(journalBefore.revision + 1);
  const recoveredRepeatedJournal = await sessions.readSessionJournal(main.actor, repeatedTargetSessionId);
  expect(recoveredRepeatedJournal).toMatchObject({
    revision: repeatedJournalBefore.revision + 1,
    assessment: { meaningRevision: 1, units: 0 },
  });
  const journalAudit = await f.pool.query<{ createdAt: string }>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
     FROM core.receipt
     WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
       AND command_kind='progress_session.journal'
     ORDER BY created_at DESC LIMIT 1`,
    [partitionOf(routeOf(main.actor.accountId)!), main.actor.accountId],
  );
  expect(Date.parse(journalAudit.rows[0]!.createdAt)).toBeGreaterThan(Date.parse('2004-02-01T00:00:00Z'));
  const sessionAfter = await sessions.readSession(main.actor, targetSessionId);
  expect(sessionAfter).toMatchObject({
    id: sessionBefore.id,
    state: sessionBefore.state,
    revision: sessionBefore.revision,
    startedAt: sessionBefore.startedAt,
    completedAt: null,
  });
  const progressChangesAfter = await f.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM library.progress_change WHERE route=$1 AND account_id=$2 AND session_id=$3',
    [routeOf(main.actor.accountId), main.actor.accountId, targetSessionId],
  );
  expect(progressChangesAfter.rows[0]?.count).toBe(progressChangesBefore.rows[0]?.count);
  const replayedFacts = await json(
    await send(main, 'POST', `${mergePath}/${id}/apply`, {
      ...selectedFrom(refreshed.records, [
        annotation.ordinal,
        journalItem.ordinal,
        repeatedJournalItem.ordinal,
        visibleProvenance.ordinal,
        unknownProvenance.ordinal,
        clearedProvenance.ordinal,
      ]),
    }),
  );
  expect(replayedFacts.applied).toEqual(appliedFacts.applied);
  const journalRequest = await f.pool.query<{
    native_request_key: string;
    patch: Record<string, unknown>;
  }>(
    `SELECT native_request_key,native_operands->'patch' AS patch FROM library.library_archive_merge_item
     WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
    [routeOf(main.actor.accountId), main.actor.accountId, id, journalItem.ordinal],
  );
  expect(journalRequest.rows[0]).toMatchObject({
    native_request_key: `archive-merge-${id.replaceAll('-', '')}-${journalItem.ordinal}-${reviewedJournal.reviewRevision}`,
    patch: {
      revision: journalBefore.revision,
      startDate: { year: 2004, month: 2 },
      reflection: '  A historical private reflection.\n',
      assessment: { units: 14 },
    },
  });
  await sessions.patchSessionJournal(
    main.actor,
    targetSessionId,
    { revision: recoveredJournal.revision, reflection: 'a later local correction' },
    key(),
  );
  await f.pool.query(
    `UPDATE library.library_archive_merge_item SET status='applying',result=NULL
     WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
    [routeOf(main.actor.accountId), main.actor.accountId, id, journalItem.ordinal],
  );
  const checkpointReplay = await json(
    await send(main, 'POST', `${mergePath}/${id}/apply`, {
      items: [{ ordinal: journalItem.ordinal, reviewRevision: reviewedJournal.reviewRevision }],
    }),
  );
  expect(checkpointReplay.applied[0]).toEqual(appliedFacts.applied[1]);
  expect((await sessions.readSessionJournal(main.actor, targetSessionId)).reflection).toBe('a later local correction');

  const nativeLabels = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
  const labelKey = `archive-merge-${id.replaceAll('-', '')}-${labelTwo.ordinal}-1`;
  await nativeLabels.createLabel(main.actor, { name: 'archive second' }, labelKey);
  const journal = await f.pool.query(
    `UPDATE library.library_archive_merge_item SET status='applying',native_command_kind='label',
      native_request_key=$5,native_operands=$6::jsonb
    WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
    [
      routeOf(main.actor.accountId),
      main.actor.accountId,
      id,
      labelTwo.ordinal,
      labelKey,
      JSON.stringify({ name: 'archive second' }),
    ],
  );
  expect(journal.rowCount).toBe(1);
  await json(await send(main, 'POST', `${mergePath}/${id}/apply`, selected([labelTwo.ordinal])));
  const created = (await nativeLabels.listLabels(main.actor, { limit: 100, q: 'archive second' })).labels;
  expect(created).toHaveLength(1);
  expect(created[0]!.revision).toBe(1);

  await json(
    await send(main, 'PATCH', `${mergePath}/${id}/review`, {
      items: [{ ordinal: assignment.ordinal, kind: 'assignment', subjectId: subjects[1], action: 'assign' }],
    }),
  );
  await json(await send(main, 'POST', `${mergePath}/${id}/apply`, selected([assignment.ordinal])));
  const assignmentRows = await createLabelAssignmentCommands({
    pool: f.pool,
    access: f.access,
    tokens: f.tokens,
  }).listAssignments(main.actor, { labelId: created[0]!.id, subjectId: subjects[1], limit: 1 });
  expect(assignmentRows.assignments).toHaveLength(1);
  const resultPage = await json(await send(main, 'GET', `${mergePath}/${id}/results?limit=1`));
  expect(resultPage.results).toHaveLength(1);
  await json(await send(main, 'DELETE', `${mergePath}/${id}`));
  await f.pool.query(
    `UPDATE library.library_archive_merge_upload SET expires_at=clock_timestamp()-interval '1 second'
     WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
    [routeOf(main.actor.accountId), main.actor.accountId, id],
  );
  expect((await json(await send(main, 'POST', `${mergePath}/${id}/prune`))).complete).toBe(true);
  expect((await personal.readPersonalEntry(main.actor, subjects[0])).note).toBe('Recovered owner note');
  expect((await sessions.readSessionJournal(main.actor, targetSessionId)).startDate).toEqual({ year: 2004, month: 2 });
  expect(
    await personal.readSourceObservation(main.actor, subjects[0], 'archive-fixture', 'source-visible-row'),
  ).toMatchObject({ privacy: { status: 'known', meaning: 'source_visible' } });
});

test('unknown archived state remains readable but cannot enter the current profile', async () => {
  const rows = artifact.records.map((row) =>
    row.section === 'entries' && row.subject_id === subjects[0]
      ? { ...row, state: 'unavailable-historic-state', library_profile_pin: null }
      : row,
  );
  const status = await upload(unknownStateOwner, framed(rows));
  const id = status.uploadId as string;
  const preview = await previewAll(unknownStateOwner, id);
  const entry = preview.records.find(
    (row: any) => row.section === 'entries' && row.evidence.subject_id === subjects[0],
  );
  expect(entry.evidence.state).toBe('unavailable-historic-state');
  await json(
    await send(unknownStateOwner, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        {
          ordinal: entry.ordinal,
          kind: 'entry',
          subjectId: subjects[0],
          stateId: 'unavailable-historic-state',
          action: 'create',
        },
      ],
    }),
  );
  expect(
    (await previewAll(unknownStateOwner, id)).records.find((row: any) => row.ordinal === entry.ordinal).status,
  ).toBe('unsupported');
});

test('V3 unknown and V2 absent assessments stay inert while an explicit archived null clears', async () => {
  const sourceRow = artifact.records.find((row) => row.section === 'journals')!;
  const cases: { version: 2 | 3; journal: Record<string, unknown>; expected: 'unsupported' | 'accepted' }[] = [
    {
      version: 3,
      journal: { ...(sourceRow.journal as Record<string, unknown>), assessment: { meaningRevision: 2, units: 14 } },
      expected: 'unsupported',
    },
    {
      version: 2,
      journal: Object.fromEntries(
        Object.entries(sourceRow.journal as Record<string, unknown>).filter(([name]) => name !== 'assessment'),
      ),
      expected: 'unsupported',
    },
    {
      version: 3,
      journal: { ...(sourceRow.journal as Record<string, unknown>), assessment: { meaningRevision: 1, units: null } },
      expected: 'accepted',
    },
  ];
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  for (const c of cases) {
    const owner = await f.identity([...exportScopes, 'account:delete']);
    const target = (
      await sessions.startSession(owner.actor, { subjectId: subjects[0], mode: 'scalar_amount', unit: 'page' }, key())
    ).value;
    await sessions.patchSessionJournal(owner.actor, target.id, { revision: 0, assessment: { units: 17 } }, key());
    const manifest = {
      ...artifact.manifest,
      version: c.version,
      coverage: `private-library-owner-facts-v${c.version}`,
    };
    const id = (await upload(owner, framed([{ ...sourceRow, journal: c.journal }], manifest))).uploadId as string;
    const row = (await previewAll(owner, id)).records.find((item: any) => item.section === 'journals')!;
    expect(row.evidence.journal).toEqual(c.journal);
    await json(
      await send(owner, 'PATCH', `${mergePath}/${id}/review`, {
        items: [
          {
            ordinal: row.ordinal,
            kind: 'journal',
            subjectId: subjects[0],
            sessionId: target.id,
            fields: { assessment: 'set' },
          },
        ],
      }),
    );
    const reviewed = (await previewAll(owner, id)).records.find((item: any) => item.ordinal === row.ordinal)!;
    const applied = await json(
      await send(owner, 'POST', `${mergePath}/${id}/apply`, selected([row.ordinal], reviewed.reviewRevision)),
    );
    expect(applied.applied[0].status).toBe(c.expected);
    expect((await sessions.readSessionJournal(owner.actor, target.id)).assessment).toEqual(
      c.expected === 'accepted' ? null : { meaningRevision: 1, units: 17 },
    );
  }
});

test('refreshed label mappings require the new confirmation and retain accepted operands on retry', async () => {
  const owner = await f.identity(exportScopes);
  const { id } = await makeUpload(owner);
  const row = (await previewAll(owner, id)).records.find((item: any) => item.section === 'labels');
  const labels = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
  const local = await labels.createLabel(owner.actor, { name: 'explicit local mapping' }, key());
  const first = await json(
    await send(owner, 'PATCH', `${mergePath}/${id}/review`, {
      items: [{ ordinal: row.ordinal, kind: 'label', target: { mode: 'existing', labelId: local.value.label.id } }],
    }),
  );
  const second = await json(
    await send(owner, 'PATCH', `${mergePath}/${id}/review`, {
      items: [{ ordinal: row.ordinal, kind: 'label', target: { mode: 'create' } }],
    }),
  );
  const confirmation = selected([row.ordinal], second.reviewed[0].reviewRevision);
  expect(second.reviewed[0].reviewRevision).not.toBe(first.reviewed[0].reviewRevision);
  expect(
    (await send(owner, 'POST', `${mergePath}/${id}/apply`, selected([row.ordinal], first.reviewed[0].reviewRevision)))
      .status,
  ).toBe(409);
  expect((await labels.listLabels(owner.actor, { limit: 100 })).labels).toHaveLength(1);
  expect((await send(source, 'POST', `${mergePath}/${id}/apply`, confirmation)).status).toBe(404);
  const accepted = await json(await send(owner, 'POST', `${mergePath}/${id}/apply`, confirmation));
  expect(accepted.applied[0].result.labelId).not.toBe(local.value.label.id);
  const binding = await f.pool.query(
    `SELECT native_request_key,native_operands,result FROM library.library_archive_merge_item
    WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
    [routeOf(owner.actor.accountId), owner.actor.accountId, id, row.ordinal],
  );
  expect(
    (
      await send(owner, 'PATCH', `${mergePath}/${id}/review`, {
        items: [{ ordinal: row.ordinal, kind: 'label', target: { mode: 'create' } }],
      })
    ).status,
  ).toBe(409);
  expect(
    (await send(owner, 'POST', `${mergePath}/${id}/apply`, selected([row.ordinal], first.reviewed[0].reviewRevision)))
      .status,
  ).toBe(409);
  await json(await send(owner, 'DELETE', `${mergePath}/${id}`));
  expect(await json(await send(owner, 'POST', `${mergePath}/${id}/apply`, confirmation))).toEqual(accepted);
  expect(
    (
      await f.pool.query(
        `SELECT native_request_key,native_operands,result FROM library.library_archive_merge_item
    WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
        [routeOf(owner.actor.accountId), owner.actor.accountId, id, row.ordinal],
      )
    ).rows,
  ).toEqual(binding.rows);
});

test('create and already-equal entry choices have distinct reviewed outcomes', async () => {
  const equal = (await f.commands.putEntry(createOwner.actor, subjects[1], { state: 'playing' }, entryKey())).value
    .entry;
  const { id } = await makeUpload(createOwner);
  const rows = (await previewAll(createOwner, id)).records;
  const first = rows.find((row: any) => row.section === 'entries' && row.evidence.subject_id === subjects[0]);
  const second = rows.find((row: any) => row.section === 'entries' && row.evidence.subject_id === subjects[1]);
  const reviewed = await json(
    await send(createOwner, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        { ordinal: first.ordinal, kind: 'entry', subjectId: subjects[0], stateId: 'planned', action: 'create' },
        { ordinal: second.ordinal, kind: 'entry', subjectId: subjects[1], stateId: 'playing', action: 'create' },
      ],
    }),
  );
  expect(reviewed.reviewed).toMatchObject([{ status: 'create' }, { status: 'already_equal' }]);
  const applied = await json(
    await send(createOwner, 'POST', `${mergePath}/${id}/apply`, selected([first.ordinal, second.ordinal])),
  );
  expect(applied.applied).toMatchObject([{ status: 'acknowledged' }, { status: 'already_equal' }]);
  expect((await f.commands.readEntry(createOwner.actor, subjects[0])).state).toBe('planned');
  expect((await f.commands.readEntry(createOwner.actor, subjects[1])).revision).toBe(equal.revision);
});

test('reviewed entry revision and incarnation changes are refused at effect time', async () => {
  for (const [person, incarnation] of [
    [staleRevision, false],
    [staleIncarnation, true],
  ] as const) {
    const original = (await f.commands.putEntry(person.actor, subjects[0], { state: 'in_progress' }, entryKey())).value
      .entry;
    const { id } = await makeUpload(person);
    const entry = (await previewAll(person, id)).records.find(
      (row: any) => row.section === 'entries' && row.evidence.subject_id === subjects[0],
    );
    await json(
      await send(person, 'PATCH', `${mergePath}/${id}/review`, {
        items: [
          { ordinal: entry.ordinal, kind: 'entry', subjectId: subjects[0], stateId: 'planned', action: 'update' },
        ],
      }),
    );
    if (incarnation) {
      await f.commands.deleteEntry(person.actor, subjects[0], original.revision, entryKey(), original.incarnationId!);
      const recreated = (await f.commands.putEntry(person.actor, subjects[0], { state: 'completed' }, entryKey())).value
        .entry;
      expect(recreated.incarnationId).not.toBe(original.incarnationId);
      expect(recreated.revision).toBe(original.revision);
    } else {
      await f.commands.putEntry(
        person.actor,
        subjects[0],
        { state: 'completed', revision: original.revision, incarnationId: original.incarnationId },
        entryKey(),
      );
    }
    const result = await json(await send(person, 'POST', `${mergePath}/${id}/apply`, selected([entry.ordinal])));
    expect(result.applied).toMatchObject([{ status: 'current_conflict', result: { code: 'current_conflict' } }]);
  }
});

test('missing personal targets stay inert and concurrent annotation or journal revisions become stale', async () => {
  const missing = await makeUpload(missingFactOwner);
  const missingRows = (await previewAll(missingFactOwner, missing.id)).records;
  const missingAnnotation = missingRows.find((row: any) => row.section === 'annotations')!;
  const missingJournal = missingRows.find(
    (row: any) => row.section === 'journals' && row.evidence.sessionId === sourceSessionId,
  )!;
  const foreignJournal = missingRows.find(
    (row: any) => row.section === 'journals' && row.evidence.sessionId === repeatedSourceSessionId,
  )!;
  await json(
    await send(missingFactOwner, 'PATCH', `${mergePath}/${missing.id}/review`, {
      items: [
        {
          ordinal: missingAnnotation.ordinal,
          kind: 'annotation',
          subjectId: subjects[0],
          incarnationId: key(),
          fields: { note: 'set' },
        },
        {
          ordinal: missingJournal.ordinal,
          kind: 'journal',
          subjectId: subjects[0],
          sessionId: key(),
          fields: { startDate: 'set' },
        },
        {
          ordinal: foreignJournal.ordinal,
          kind: 'journal',
          subjectId: subjects[0],
          sessionId: sourceSessionId,
          fields: { assessment: 'set' },
        },
      ],
    }),
  );
  const missingReviewed = (await previewAll(missingFactOwner, missing.id)).records;
  expect(missingReviewed.find((row: any) => row.ordinal === missingAnnotation.ordinal).status).toBe('unresolved');
  expect(missingReviewed.find((row: any) => row.ordinal === missingJournal.ordinal).status).toBe('unresolved');
  expect(missingReviewed.find((row: any) => row.ordinal === foreignJournal.ordinal).status).toBe('unresolved');
  expect(
    (
      await json(
        await send(
          missingFactOwner,
          'POST',
          `${mergePath}/${missing.id}/apply`,
          selected([missingAnnotation.ordinal, missingJournal.ordinal, foreignJournal.ordinal]),
        ),
      )
    ).applied,
  ).toMatchObject([{ status: 'stale' }, { status: 'stale' }, { status: 'stale' }]);

  const entry = (await f.commands.putEntry(staleFactOwner.actor, subjects[0], { state: 'planned' }, entryKey())).value
    .entry;
  const personal = createEntryPersonalCommands({ pool: f.pool, access: f.access });
  await personal.saveAnnotations(
    staleFactOwner.actor,
    subjects[0],
    { revision: 0, note: { op: 'set', value: 'before review' }, priority: { op: 'unchanged' } },
    key(),
  );
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  const session = await sessions.startSession(
    staleFactOwner.actor,
    { subjectId: subjects[0], mode: 'scalar_amount', unit: 'page' },
    key(),
  );
  await sessions.patchSessionJournal(
    staleFactOwner.actor,
    session.value.id,
    { revision: 0, startDate: { year: 2010 } },
    key(),
  );
  const stale = await makeUpload(staleFactOwner);
  const rows = (await previewAll(staleFactOwner, stale.id)).records;
  const annotation = rows.find((row: any) => row.section === 'annotations')!;
  const journal = rows.find((row: any) => row.section === 'journals')!;
  await json(
    await send(staleFactOwner, 'PATCH', `${mergePath}/${stale.id}/review`, {
      items: [
        {
          ordinal: annotation.ordinal,
          kind: 'annotation',
          subjectId: subjects[0],
          incarnationId: entry.incarnationId,
          fields: { note: 'set' },
        },
        {
          ordinal: journal.ordinal,
          kind: 'journal',
          subjectId: subjects[0],
          sessionId: session.value.id,
          fields: { startDate: 'set' },
        },
      ],
    }),
  );
  await personal.saveAnnotations(
    staleFactOwner.actor,
    subjects[0],
    { revision: 1, note: { op: 'set', value: 'changed after review' }, priority: { op: 'unchanged' } },
    key(),
  );
  await sessions.patchSessionJournal(
    staleFactOwner.actor,
    session.value.id,
    { revision: 1, startDate: { year: 2011 } },
    key(),
  );
  expect(
    (
      await json(
        await send(
          staleFactOwner,
          'POST',
          `${mergePath}/${stale.id}/apply`,
          selected([annotation.ordinal, journal.ordinal]),
        ),
      )
    ).applied,
  ).toMatchObject([{ status: 'stale' }, { status: 'stale' }]);
});

test('annotation application rejects a recreated Entry and expiry cleanup removes retained v2 evidence', async () => {
  const original = await f.commands.readEntry(staleIncarnation.actor, subjects[0]);
  const { id } = await makeUpload(staleIncarnation);
  const annotation = (await previewAll(staleIncarnation, id)).records.find((row: any) => row.section === 'annotations');
  await json(
    await send(staleIncarnation, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        {
          ordinal: annotation.ordinal,
          kind: 'annotation',
          subjectId: subjects[0],
          incarnationId: original.incarnationId,
          fields: { note: 'set' },
        },
      ],
    }),
  );
  await f.commands.deleteEntry(
    staleIncarnation.actor,
    subjects[0],
    original.revision,
    entryKey(),
    original.incarnationId!,
  );
  const recreated = (await f.commands.putEntry(staleIncarnation.actor, subjects[0], { state: 'completed' }, entryKey()))
    .value.entry;
  expect(recreated.incarnationId).not.toBe(original.incarnationId);
  expect(
    (await json(await send(staleIncarnation, 'POST', `${mergePath}/${id}/apply`, selected([annotation.ordinal]))))
      .applied,
  ).toMatchObject([{ status: 'stale' }]);

  const expiring = await makeUpload(pruneOwner);
  const expiredObservation = (await previewAll(pruneOwner, expiring.id)).records.find(
    (row: any) => row.section === 'provenance' && row.evidence.observation.recordId === 'source-visible-row',
  )!;
  await json(
    await send(pruneOwner, 'PATCH', `${mergePath}/${expiring.id}/review`, {
      items: [
        {
          ordinal: expiredObservation.ordinal,
          kind: 'observation',
          subjectId: subjects[0],
          provider: 'archive-fixture',
          recordId: 'source-visible-row',
          action: 'admit',
          fields: { privacy: 'set', sourceCreated: 'set', sourceUpdated: 'set' },
        },
      ],
    }),
  );
  await f.pool.query(
    `UPDATE library.library_archive_merge_upload SET expires_at=clock_timestamp()-interval '1 second'
     WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
    [routeOf(pruneOwner.actor.accountId), pruneOwner.actor.accountId, expiring.id],
  );
  expect(
    (await send(pruneOwner, 'POST', `${mergePath}/${expiring.id}/apply`, selected([expiredObservation.ordinal])))
      .status,
  ).toBe(404);
  expect(
    await createEntryPersonalCommands({ pool: f.pool, access: f.access }).readSourceObservation(
      pruneOwner.actor,
      subjects[0],
      'archive-fixture',
      'source-visible-row',
    ),
  ).toBeNull();
  const pruned = await json(await send(pruneOwner, 'POST', `${mergePath}/${expiring.id}/prune`));
  expect(pruned).toMatchObject({ removed: artifact.records.length, complete: true });
});

test('cancellation stops pending effects and terminal erasure removes retained archive data', async () => {
  const before = (await f.commands.putEntry(cancelledOwner.actor, subjects[0], { state: 'completed' }, entryKey()))
    .value.entry;
  const { id } = await makeUpload(cancelledOwner);
  const rows = (await previewAll(cancelledOwner, id)).records;
  const entry = rows.find((row: any) => row.section === 'entries' && row.evidence.subject_id === subjects[0]);
  const label = rows.find((row: any) => row.section === 'labels' && row.evidence.label_id === sourceLabels[1]);
  const provenance = rows.find(
    (row: any) => row.section === 'provenance' && row.evidence.observation.recordId === 'source-visible-row',
  );
  const journal = rows.find((row: any) => row.section === 'journals' && row.evidence.sessionId === sourceSessionId);
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  const target = (
    await sessions.startSession(
      cancelledOwner.actor,
      { subjectId: subjects[0], mode: 'scalar_amount', unit: 'page' },
      key(),
    )
  ).value;
  await json(
    await send(cancelledOwner, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        { ordinal: entry.ordinal, kind: 'entry', subjectId: subjects[0], stateId: 'planned', action: 'update' },
        { ordinal: label.ordinal, kind: 'label', target: { mode: 'create' } },
        {
          ordinal: journal.ordinal,
          kind: 'journal',
          subjectId: subjects[0],
          sessionId: target.id,
          fields: { assessment: 'set' },
        },
        {
          ordinal: provenance.ordinal,
          kind: 'observation',
          subjectId: subjects[0],
          provider: 'archive-fixture',
          recordId: 'source-visible-row',
          action: 'admit',
          fields: { privacy: 'set', sourceCreated: 'set', sourceUpdated: 'set' },
        },
      ],
    }),
  );
  await json(
    await send(cancelledOwner, 'POST', `${mergePath}/${id}/apply`, {
      ...selectedFrom(await previewAll(cancelledOwner, id).then((result) => result.records), [
        label.ordinal,
        journal.ordinal,
        provenance.ordinal,
      ]),
    }),
  );
  await json(await send(cancelledOwner, 'DELETE', `${mergePath}/${id}`));
  expect((await send(cancelledOwner, 'POST', `${mergePath}/${id}/apply`, selected([entry.ordinal]))).status).toBe(409);
  expect((await f.commands.readEntry(cancelledOwner.actor, subjects[0])).state).toBe(before.state);
  const results = await json(await send(cancelledOwner, 'GET', `${mergePath}/${id}/results`));
  expect(results.results.find((row: any) => row.ordinal === label.ordinal).status).toBe('acknowledged');
  expect(results.results.find((row: any) => row.ordinal === journal.ordinal).status).toBe('accepted');
  expect((await sessions.readSessionJournal(cancelledOwner.actor, target.id)).assessment).toEqual({
    meaningRevision: 1,
    units: 14,
  });
  expect(results.results.find((row: any) => row.ordinal === provenance.ordinal).status).toBe('accepted');
  expect(
    await createEntryPersonalCommands({ pool: f.pool, access: f.access }).readSourceObservation(
      cancelledOwner.actor,
      subjects[0],
      'archive-fixture',
      'source-visible-row',
    ),
  ).toMatchObject({ privacy: { status: 'known', meaning: 'source_visible' } });

  const { id: deletedId } = await makeUpload(deletedOwner);
  const grants = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
  await grants.create(
    { pool: f.pool, actor: f.steward.actor, deadline: deadlineFor(30_000) },
    {
      resource: { route: routeOf(deletedOwner.actor.accountId)!, id: deletedOwner.actor.accountId },
      subject: { kind: 'account', id: deletedOwner.actor.accountId },
      actions: ['account:delete'],
      valid: '(,)',
      key: key(),
    },
  );
  await createLifecycleCommands({ pool: f.pool, access: f.access }).tombstone(
    { actor: deletedOwner.actor, deadline: deadlineFor(30_000) },
    { accountId: deletedOwner.actor.accountId, key: key() },
  );
  const methods: [string, string, unknown?][] = [
    ['GET', `${mergePath}/${deletedId}`],
    ['GET', `${mergePath}/${deletedId}/preview`],
    ['GET', `${mergePath}/${deletedId}/results`],
    [
      'PATCH',
      `${mergePath}/${deletedId}/review`,
      { items: [{ ordinal: 0, kind: 'entry', subjectId: subjects[0], stateId: 'planned', action: 'create' }] },
    ],
    ['POST', `${mergePath}/${deletedId}/apply`, selected([0])],
    ['DELETE', `${mergePath}/${deletedId}`],
    ['POST', `${mergePath}/${deletedId}/prune`],
    ['POST', mergePath, artifact],
  ];
  for (const [method, path, body] of methods)
    expect([401, 403]).toContain((await send(deletedOwner, method, path, body)).status);
  const erased = await purgeOwnedGraphPage(f.pool, {
    accountId: deletedOwner.actor.accountId,
    kind: 'library_archive_merge',
    parent: null,
    after: null,
    ordinal: 0,
    segment: 500,
  });
  expect(erased.hasMore).not.toBe(true);
  expect(
    await f.pool.query('SELECT 1 FROM library.library_archive_merge_upload WHERE route=$1 AND account_id=$2', [
      routeOf(deletedOwner.actor.accountId),
      deletedOwner.actor.accountId,
    ]),
  ).toMatchObject({ rowCount: 0 });
});

test('reflection choices retain empty, null and absent evidence and exact bounded plain text', async () => {
  const sourceRow = artifact.records.find((row) => row.section === 'journals')!;
  const cases = [
    { value: '', choice: 'set', expected: '' },
    { value: null, choice: 'clear', expected: null },
    { value: null, choice: 'set', unsupported: true },
    { choice: 'set', unsupported: true },
    { choice: 'preserve', expected: 'local' },
    { value: '😀'.repeat(1024), choice: 'set', expected: '😀'.repeat(1024) },
    { value: '\u0001'.repeat(2000), choice: 'set', expected: '\u0001'.repeat(2000) },
    { value: 'x'.repeat(2001), choice: 'set', unsupported: true },
    { value: '😀'.repeat(1025), choice: 'set', unsupported: true },
    { value: '\ud800', choice: 'set', unsupported: true },
  ];
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  for (const c of cases) {
    const owner = await f.identity(exportScopes);
    const target = (
      await sessions.startSession(owner.actor, { subjectId: subjects[0], mode: 'scalar_amount', unit: 'page' }, key())
    ).value;
    await sessions.patchSessionJournal(
      owner.actor,
      target.id,
      { revision: 0, reflection: 'local', finishDate: { year: 2020 }, assessment: { units: 17 } },
      key(),
    );
    const journal = { ...(sourceRow.journal as Record<string, unknown>) };
    if ('value' in c) journal.reflection = c.value;
    else delete journal.reflection;
    const id = (await upload(owner, framed([{ ...sourceRow, journal }]))).uploadId;
    const row = (await previewAll(owner, id)).records[0];
    expect(row.evidence.journal).toEqual(journal);
    const reviewed = await json(
      await send(owner, 'PATCH', `${mergePath}/${id}/review`, {
        items: [
          {
            ordinal: row.ordinal,
            kind: 'journal',
            subjectId: subjects[0],
            sessionId: target.id,
            fields: { reflection: c.choice },
          },
        ],
      }),
    );
    if (c.unsupported)
      expect((await previewAll(owner, id)).records[0].review.reason).toMatch(
        /unsupported-field|invalid-journal-reflection/,
      );
    const result = await json(
      await send(owner, 'POST', `${mergePath}/${id}/apply`, {
        items: reviewed.reviewed.map(({ ordinal, reviewRevision }: any) => ({ ordinal, reviewRevision })),
      }),
    );
    expect(result.applied[0].status).toBe(
      c.unsupported ? 'unsupported' : c.choice === 'preserve' ? 'unchanged' : 'accepted',
    );
    const current = await sessions.readSessionJournal(owner.actor, target.id);
    expect(current).toMatchObject({
      reflection: c.unsupported ? 'local' : c.expected,
      revision: c.unsupported || c.choice === 'preserve' ? 1 : 2,
      assessment: { meaningRevision: 1, units: 17 },
      finishDate: { year: 2020 },
      startDate: null,
    });
    expect(await sessions.readSession(owner.actor, target.id)).toEqual(target);
  }
}, 120_000);

test('exact occurrence confirmations fence competing corrections and replay the original committed patch', async () => {
  const owner = await f.identity(exportScopes);
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  const targets = [];
  for (let i = 0; i < 2; i++)
    targets.push(
      (await sessions.startSession(owner.actor, { subjectId: subjects[0], mode: 'scalar_amount', unit: 'page' }, key()))
        .value.id,
    );
  const { id } = await makeUpload(owner);
  const rows = (await previewAll(owner, id)).records;
  const row = rows.find((r: any) => r.section === 'journals');
  const label = rows.find((r: any) => r.section === 'labels');
  const review = (sessionId: string) =>
    send(owner, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        {
          ordinal: row.ordinal,
          kind: 'journal',
          subjectId: subjects[0],
          sessionId,
          fields: { reflection: 'set', startDate: 'set', assessment: 'set' },
        },
        { ordinal: label.ordinal, kind: 'label', target: { mode: 'create' } },
      ],
    }).then((r) => json(r));
  const old = await review(targets[0]!);
  const latest = await review(targets[1]!);
  const confirmation = {
    items: latest.reviewed.map(({ ordinal, reviewRevision }: any) => ({ ordinal, reviewRevision })),
  };
  expect(
    (
      await send(owner, 'POST', `${mergePath}/${id}/apply`, {
        items: [confirmation.items[1], { ordinal: row.ordinal, reviewRevision: old.reviewed[0].reviewRevision }],
      })
    ).status,
  ).toBe(409);
  expect((await sessions.readSessionJournal(owner.actor, targets[1]!)).revision).toBe(0);
  await sessions.patchSessionJournal(
    owner.actor,
    targets[1]!,
    { revision: 0, reflection: 'competing correction', assessment: { units: 19 } },
    key(),
  );
  const stale = await json(await send(owner, 'POST', `${mergePath}/${id}/apply`, { items: [confirmation.items[0]] }));
  expect(stale.applied[0].status).toBe('stale');
  const refreshed = await review(targets[1]!);
  const exact = selected([row.ordinal], refreshed.reviewed[0].reviewRevision);
  const accepted = await json(await send(owner, 'POST', `${mergePath}/${id}/apply`, exact));
  const committed = await sessions.readSessionJournal(owner.actor, targets[1]!);
  expect(committed).toMatchObject({
    reflection: '  A historical private reflection.\n',
    startDate: { year: 2004, month: 2 },
    assessment: { meaningRevision: 1, units: 14 },
  });
  await sessions.patchSessionJournal(
    owner.actor,
    targets[1]!,
    { revision: committed.revision, reflection: 'later local correction', assessment: { units: 0 } },
    key(),
  );
  // Simulate native commit before the archive acknowledgement checkpoint.
  await f.pool.query(
    `UPDATE library.library_archive_merge_item SET status='applying',result=NULL WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
    [routeOf(owner.actor.accountId), owner.actor.accountId, id, row.ordinal],
  );
  expect(await json(await send(owner, 'POST', `${mergePath}/${id}/apply`, exact))).toEqual(accepted);
  expect(await sessions.readSessionJournal(owner.actor, targets[1]!)).toMatchObject({
    reflection: 'later local correction',
    assessment: { meaningRevision: 1, units: 0 },
  });
  expect((await sessions.readSessionJournal(owner.actor, targets[0]!)).revision).toBe(0);
  expect(
    (
      await send(owner, 'PATCH', `${mergePath}/${id}/review`, {
        items: [
          {
            ordinal: row.ordinal,
            kind: 'journal',
            subjectId: subjects[0],
            sessionId: targets[0],
            fields: { reflection: 'clear', assessment: 'clear' },
          },
        ],
      })
    ).status,
  ).toBe(409);
  await json(await send(owner, 'DELETE', `${mergePath}/${id}`));
  expect((await send(owner, 'POST', `${mergePath}/${id}/apply`, { items: [confirmation.items[1]] })).status).toBe(409);
  expect(await sessions.readSessionJournal(owner.actor, targets[1]!)).toMatchObject({
    reflection: 'later local correction',
    assessment: { meaningRevision: 1, units: 0 },
  });
}, 120_000);
test('archive admission refuses an address that appears after review without replacing it', async () => {
  const { id } = await makeUpload(duplicateOwner);
  const row = (await previewAll(duplicateOwner, id)).records.find(
    (item: any) => item.section === 'provenance' && item.evidence.observation.recordId === 'source-visible-row',
  )!;
  await json(
    await send(duplicateOwner, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        {
          ordinal: row.ordinal,
          kind: 'observation',
          subjectId: subjects[0],
          provider: 'archive-fixture',
          recordId: 'source-visible-row',
          action: 'admit',
          fields: { privacy: 'set', sourceCreated: 'set', sourceUpdated: 'set' },
        },
      ],
    }),
  );
  const personal = createEntryPersonalCommands({ pool: f.pool, access: f.access });
  await personal.admitSourceObservation(
    duplicateOwner.actor,
    subjects[0],
    {
      provider: 'archive-fixture',
      recordId: 'source-visible-row',
      confirmReviewed: true,
      privacy: { status: 'known', meaning: 'private' },
      sourceCreated: { status: 'known', value: '1990' },
      sourceUpdated: { status: 'absent' },
    },
    key(),
  );
  const applied = await json(await send(duplicateOwner, 'POST', `${mergePath}/${id}/apply`, selected([row.ordinal])));
  expect(applied.applied).toMatchObject([{ status: 'stale', result: { visibility: 'private' } }]);
  expect(
    await personal.readSourceObservation(duplicateOwner.actor, subjects[0], 'archive-fixture', 'source-visible-row'),
  ).toMatchObject({
    revision: 1,
    privacy: { status: 'known', meaning: 'private' },
    sourceCreated: { status: 'known', value: '1990', precision: 'year', zone: 'unknown' },
    sourceUpdated: { status: 'absent' },
  });
});

test('correction binds its reviewed revision and permits a fresh deliberately selected correction', async () => {
  const personal = createEntryPersonalCommands({ pool: f.pool, access: f.access });
  await personal.admitSourceObservation(
    correctionOwner.actor,
    subjects[0],
    {
      provider: 'archive-fixture',
      recordId: 'source-visible-row',
      confirmReviewed: true,
      privacy: { status: 'known', meaning: 'private' },
      sourceCreated: { status: 'absent' },
      sourceUpdated: { status: 'absent' },
    },
    key(),
  );
  const { id } = await makeUpload(correctionOwner);
  const row = (await previewAll(correctionOwner, id)).records.find(
    (item: any) => item.section === 'provenance' && item.evidence.observation.recordId === 'source-visible-row',
  )!;
  const review = async (revision: number, fields: Record<string, string>) =>
    json(
      await send(correctionOwner, 'PATCH', `${mergePath}/${id}/review`, {
        items: [
          {
            ordinal: row.ordinal,
            kind: 'observation',
            subjectId: subjects[0],
            provider: 'archive-fixture',
            recordId: 'source-visible-row',
            action: 'correct',
            revision,
            fields,
          },
        ],
      }),
    );
  await review(1, { privacy: 'set', sourceCreated: 'preserve', sourceUpdated: 'clear' });
  await personal.correctSourceObservation(
    correctionOwner.actor,
    subjects[0],
    {
      provider: 'archive-fixture',
      recordId: 'source-visible-row',
      revision: 1,
      confirmReviewed: true,
      privacy: { op: 'set', value: { status: 'unknown', sourceValue: 'local-correction' } },
      sourceCreated: { op: 'unchanged' },
      sourceUpdated: { op: 'set', value: { status: 'known', value: '2001' } },
    },
    key(),
  );
  const stale = await json(await send(correctionOwner, 'POST', `${mergePath}/${id}/apply`, selected([row.ordinal])));
  expect(stale.applied).toMatchObject([{ status: 'stale' }]);
  expect(
    await personal.readSourceObservation(correctionOwner.actor, subjects[0], 'archive-fixture', 'source-visible-row'),
  ).toMatchObject({ revision: 2, privacy: { status: 'unknown', sourceValue: 'local-correction' } });

  const refreshed = await review(2, { privacy: 'preserve', sourceCreated: 'set', sourceUpdated: 'preserve' });
  const accepted = await json(
    await send(
      correctionOwner,
      'POST',
      `${mergePath}/${id}/apply`,
      selected([row.ordinal], refreshed.reviewed[0]!.reviewRevision),
    ),
  );
  expect(accepted.applied).toMatchObject([
    { status: 'accepted', result: { outcome: 'accepted', visibility: 'private' } },
  ]);
  expect(
    await personal.readSourceObservation(correctionOwner.actor, subjects[0], 'archive-fixture', 'source-visible-row'),
  ).toMatchObject({
    revision: 3,
    privacy: { status: 'unknown', sourceValue: 'local-correction' },
    sourceCreated: {
      status: 'known',
      value: '2022-11-17T14:03:04.123456789-00:00',
      precision: 'fraction',
      zone: 'unknown',
    },
    sourceUpdated: { status: 'known', value: '2001', precision: 'year', zone: 'unknown' },
  });
});

test('observation admission refuses when the native per-Subject cap is full', async () => {
  const personal = createEntryPersonalCommands({ pool: f.pool, access: f.access });
  for (let ordinal = 0; ordinal < 32; ordinal++)
    await personal.admitSourceObservation(
      capOwner.actor,
      subjects[0],
      {
        provider: 'cap-fixture',
        recordId: `row-${ordinal}`,
        confirmReviewed: true,
        privacy: { status: 'absent' },
        sourceCreated: { status: 'absent' },
        sourceUpdated: { status: 'absent' },
      },
      key(),
    );
  const { id } = await makeUpload(capOwner);
  const row = (await previewAll(capOwner, id)).records.find(
    (item: any) => item.section === 'provenance' && item.evidence.observation.recordId === 'source-visible-row',
  )!;
  await json(
    await send(capOwner, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        {
          ordinal: row.ordinal,
          kind: 'observation',
          subjectId: subjects[0],
          provider: 'archive-fixture',
          recordId: 'source-visible-row',
          action: 'admit',
          fields: { privacy: 'set', sourceCreated: 'set', sourceUpdated: 'set' },
        },
      ],
    }),
  );
  const applied = await json(await send(capOwner, 'POST', `${mergePath}/${id}/apply`, selected([row.ordinal])));
  expect(applied.applied).toMatchObject([
    { status: 'stale', result: { visibility: 'private', reason: 'observation-cap-reached' } },
  ]);
  expect(
    await personal.readSourceObservation(capOwner.actor, subjects[0], 'archive-fixture', 'source-visible-row'),
  ).toBeNull();
});

test('a merged canonical target invalidates the reviewed observation identity', async () => {
  const subjectIds: string[] = [];
  for (const label of ['archive identity first', 'archive identity second']) {
    const response = await send(identityOwner, 'POST', '/v1/subjects', { type: 'ex:Child', labels: { en: label } });
    expect(response.status).toBe(201);
    subjectIds.push(((await response.json()) as { subject: { id: string } }).subject.id);
  }
  const sortedSubjects = [...subjectIds].sort();
  const survivor = sortedSubjects[0]!;
  const redirected = sortedSubjects[1]!;
  const { id } = await makeUpload(identityOwner);
  const row = (await previewAll(identityOwner, id)).records.find(
    (item: any) => item.section === 'provenance' && item.evidence.observation.recordId === 'source-visible-row',
  )!;
  await json(
    await send(identityOwner, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        {
          ordinal: row.ordinal,
          kind: 'observation',
          subjectId: redirected,
          provider: 'archive-fixture',
          recordId: 'source-visible-row',
          action: 'admit',
          fields: { privacy: 'set', sourceCreated: 'set', sourceUpdated: 'set' },
        },
      ],
    }),
  );
  const merged = await send(identityOwner, 'POST', '/v1/subjects:merge', { subjects: [survivor, redirected] });
  expect(merged.status).toBe(200);
  expect(await merged.json()).toMatchObject({ survivor, redirected });
  const applied = await json(await send(identityOwner, 'POST', `${mergePath}/${id}/apply`, selected([row.ordinal])));
  expect(applied.applied).toMatchObject([{ status: 'stale' }]);
  const personal = createEntryPersonalCommands({ pool: f.pool, access: f.access });
  expect(
    await personal.readSourceObservation(identityOwner.actor, survivor, 'archive-fixture', 'source-visible-row'),
  ).toBeNull();
});

test('unsupported archived observation tokens stay private evidence with a field reason', async () => {
  const records = artifact.records.map((row) => {
    if (row.section !== 'provenance') return row;
    const observation = (row as any).observation;
    if (observation.recordId === 'source-visible-row')
      return { ...row, observation: { ...observation, privacy: { status: 'known', meaning: 'future-public' } } };
    if (observation.recordId === 'unknown-and-partial-row')
      return {
        ...row,
        observation: { ...observation, sourceCreated: { ...observation.sourceCreated, precision: 'day' } },
      };
    if (observation.recordId === 'cleared-row')
      return {
        ...row,
        observation: { ...observation, sourceUpdated: { ...observation.sourceUpdated, zone: 'utc' } },
      };
    return row;
  });
  const { id } = await makeUpload(pruneOwner, framed(records));
  const provenance = (await previewAll(pruneOwner, id)).records.filter((item: any) => item.section === 'provenance');
  const selected = provenance.filter((item: any) =>
    ['source-visible-row', 'unknown-and-partial-row', 'cleared-row'].includes(item.evidence.observation.recordId),
  );
  await json(
    await send(pruneOwner, 'PATCH', `${mergePath}/${id}/review`, {
      items: selected.map((row: any) => ({
        ordinal: row.ordinal,
        kind: 'observation',
        subjectId: subjects[0],
        provider: 'archive-fixture',
        recordId: row.evidence.observation.recordId,
        action: 'admit',
        fields: { privacy: 'set', sourceCreated: 'set', sourceUpdated: 'set' },
      })),
    }),
  );
  const reviewed = (await previewAll(pruneOwner, id)).records.filter((item: any) =>
    selected.some((row: any) => row.ordinal === item.ordinal),
  );
  expect(
    reviewed.map((item: any) => ({ status: item.status, reason: item.review.reason, field: item.review.field })),
  ).toEqual(
    expect.arrayContaining([
      { status: 'unsupported', reason: 'unsupported-privacy-value', field: 'privacy' },
      { status: 'unsupported', reason: 'declared-timestamp-precision-mismatch', field: 'sourceCreated' },
      { status: 'unsupported', reason: 'declared-timestamp-zone-mismatch', field: 'sourceUpdated' },
    ]),
  );
  expect(reviewed.every((item: any) => item.review.visibility === 'private')).toBe(true);
});
