import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { createEntryPersonalCommands } from '../../src/library/entry-personal.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands.ts';
import { createSessionCommands } from '../../src/library/sessions.ts';
import { libraryExportManifest } from '../../src/library/library-export-format.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
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
const key = () => randomUUID();
let f: NativeProfileFixture;
let source: Identity, main: Identity, createOwner: Identity, staleRevision: Identity, staleIncarnation: Identity;
let unknownStateOwner: Identity, cancelledOwner: Identity, deletedOwner: Identity;
let staleFactOwner: Identity, missingFactOwner: Identity, pruneOwner: Identity;
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
function framed(records: RecordRow[], baseManifest: Record<string, unknown> = artifact.manifest): Archive {
  const recordBytes = records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  const sectionTotals = Object.fromEntries(
    Object.keys((baseManifest.sectionTotals as Record<string, unknown> | undefined) ?? {}).map((section) => {
      const rows = records.filter((row) => row.section === section);
      return [
        section,
        { rows: rows.length, recordBytes: rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0) },
      ];
    }),
  );
  return {
    manifest: {
      ...baseManifest,
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
async function makeUpload(person: Identity) {
  const status = await upload(person);
  return { id: status.uploadId as string, status };
}

beforeAll(async () => {
  f = await createProfileEntryFixture();
  for (const group of ['personal_library', 'reading_progress', 'collections'])
    expect((await f.send('steward', 'POST', `/v1/platform/exposure/${group}:open`)).status).toBe(200);
  source = await f.identity(exportScopes);
  const mergeScopes = [...exportScopes, 'account:delete'];
  main = await f.identity(mergeScopes);
  createOwner = await f.identity(mergeScopes);
  staleRevision = await f.identity(mergeScopes);
  staleIncarnation = await f.identity(mergeScopes);
  unknownStateOwner = await f.identity(mergeScopes);
  cancelledOwner = await f.identity(mergeScopes);
  deletedOwner = await f.identity(mergeScopes);
  staleFactOwner = await f.identity(mergeScopes);
  missingFactOwner = await f.identity(mergeScopes);
  pruneOwner = await f.identity(mergeScopes);

  async function createSubject(label: string) {
    const response = await send(source, 'POST', '/v1/subjects', { type: 'ex:Child', labels: { en: label } });
    const result = await json(response, 201);
    return (result.subject as { id: string }).id;
  }
  subjects = [await createSubject('archive first subject'), await createSubject('archive second subject')];
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
      sourceCreated: { status: 'absent' },
      sourceUpdated: { status: 'absent' },
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
      reflection: 'A historical reflection is retained as evidence only.',
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

  const captured = await json(await send(source, 'POST', '/v1/libraryExports'));
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
}, 120_000);

afterAll(async () => {
  await f?.close();
});

test('the actual installed archive is privately reviewed, explicitly merged and replayed through native commands', async () => {
  const wrong = framed(artifact.records);
  expect(wrong.manifest.version).toBe(3);
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
      expect.objectContaining({ section: 'provenance', treatment: 'retained-unsupported', rows: 1 }),
    ]),
  );
  const entryOne = rows.find((row) => row.section === 'entries' && row.evidence.subject_id === subjects[0])!;
  const entryTwo = rows.find((row) => row.section === 'entries' && row.evidence.subject_id === subjects[1])!;
  const labelOne = rows.find((row) => row.section === 'labels' && row.evidence.label_id === sourceLabels[0])!;
  const labelTwo = rows.find((row) => row.section === 'labels' && row.evidence.label_id === sourceLabels[1])!;
  const assignment = rows.find((row) => row.section === 'assignments')!;
  const annotation = rows.find((row) => row.section === 'annotations' && row.evidence.subjectId === subjects[0])!;
  const journalItem = rows.find((row) => row.section === 'journals' && row.evidence.sessionId === sourceSessionId)!;
  const repeatedJournalItem = rows.find(
    (row) => row.section === 'journals' && row.evidence.sessionId === repeatedSourceSessionId,
  )!;
  const provenance = rows.find((row) => row.section === 'provenance')!;
  expect(provenance.status).toBe('unsupported');
  expect(provenance.evidence.observation.privacy).toEqual({ status: 'known', meaning: 'source_visible' });
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
  expect(reviewedAnnotation.review.fields).toEqual({ note: 'set', priority: 'clear' });
  expect(reviewedJournal.review.fields).toEqual({
    startDate: 'set',
    finishDate: 'preserve',
    reflection: 'set',
    assessment: 'set',
  });
  expect(reviewedRepeatedJournal.review.fields).toEqual({ assessment: 'set' });
  const personal = createEntryPersonalCommands({ pool: f.pool, access: f.access });
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
  const journalRequestKey = `archive-merge-${id.replaceAll('-', '')}-${journalItem.ordinal}-${reviewedJournal.reviewRevision}`;
  const journalPatch = {
    revision: journalBefore.revision,
    startDate: journalItem.evidence.journal.startDate,
    reflection: journalItem.evidence.journal.reflection,
    assessment: { units: journalItem.evidence.journal.assessment.units },
  };
  const journalOperands = {
    sessionId: targetSessionId,
    subjectId: subjects[0],
    sessionRevision: sessionBefore.revision,
    sessionStartedAt: sessionBefore.startedAt,
    state: sessionBefore.state,
    journalRevision: journalBefore.revision,
    profile: reviewedJournal.review.profile,
    fields: {
      startDate: { choice: 'set', value: journalItem.evidence.journal.startDate, outcome: 'accepted' },
      finishDate: { choice: 'preserve', value: null, outcome: 'preserved' },
      reflection: { choice: 'set', value: journalItem.evidence.journal.reflection, outcome: 'accepted' },
      assessment: { choice: 'set', value: journalItem.evidence.journal.assessment, outcome: 'accepted' },
    },
    patch: journalPatch,
  };
  await f.pool.query(
    `UPDATE library.library_archive_merge_item SET status='applying',native_command_kind='journal',
      native_request_key=$5,native_operands=$6::jsonb
     WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
    [
      routeOf(main.actor.accountId),
      main.actor.accountId,
      id,
      journalItem.ordinal,
      journalRequestKey,
      JSON.stringify(journalOperands),
    ],
  );
  await sessions.patchSessionJournal(main.actor, targetSessionId, journalPatch, journalRequestKey, {
    identity: {
      profile: reviewedJournal.review.profile,
      subjectId: subjects[0],
      sessionRevision: sessionBefore.revision,
      sessionStartedAt: sessionBefore.startedAt,
      state: sessionBefore.state,
    },
    assert: async () => {},
  });
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
      items: [...selected([annotation.ordinal], 2).items, ...selected([journalItem.ordinal]).items],
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
        fields: {
          startDate: 'accepted',
          finishDate: 'preserved',
          reflection: 'accepted',
          assessment: 'accepted',
        },
      },
    },
    { status: 'accepted', result: { outcome: 'accepted', fields: { assessment: 'accepted' } } },
  ]);
  expect((await personal.readPersonalEntry(main.actor, subjects[0])).note).toBe('Recovered owner note');
  expect((await personal.readPersonalEntry(main.actor, subjects[0])).priority).toBeNull();
  const recoveredJournal = await sessions.readSessionJournal(main.actor, targetSessionId);
  expect(recoveredJournal).toMatchObject({
    startDate: { year: 2004, month: 2 },
    finishDate: { year: 2020, month: 3 },
    reflection: 'A historical reflection is retained as evidence only.',
    assessment: { meaningRevision: 1, units: 14 },
  });
  expect(recoveredJournal.finishDate).toEqual(journalBefore.finishDate);
  expect(recoveredJournal.revision).toBe(journalBefore.revision + 1);
  const recoveredRepeatedJournal = await sessions.readSessionJournal(main.actor, repeatedTargetSessionId);
  expect(recoveredRepeatedJournal).toMatchObject({
    revision: repeatedJournalBefore.revision + 1,
    assessment: { meaningRevision: 1, units: 0 },
  });
  const storedJournalEffect = await f.pool.query<{ native_request_key: string; patch: Record<string, unknown> }>(
    `SELECT native_request_key,native_operands->'patch' AS patch FROM library.library_archive_merge_item
     WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
    [routeOf(main.actor.accountId), main.actor.accountId, id, journalItem.ordinal],
  );
  expect(storedJournalEffect.rows[0]).toEqual({ native_request_key: journalRequestKey, patch: journalPatch });
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
      items: [
        ...selected([annotation.ordinal], 2).items,
        ...selected([journalItem.ordinal, repeatedJournalItem.ordinal]).items,
      ],
    }),
  );
  expect(replayedFacts.applied).toEqual(appliedFacts.applied);

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
});

test('unknown and legacy assessment evidence stay unsupported without changing the chosen occurrence', async () => {
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  async function target(person: Identity, units: number) {
    const created = await sessions.startSession(
      person.actor,
      { subjectId: subjects[0], mode: 'scalar_amount', unit: 'page' },
      key(),
    );
    await sessions.patchSessionJournal(
      person.actor,
      created.value.id,
      { revision: 0, assessment: { units } },
      key(),
    );
    return created.value.id;
  }
  const unknownOwner = await f.identity(exportScopes);
  const unknownTarget = await target(unknownOwner, 7);
  const clearTarget = await target(unknownOwner, 9);
  const unknownRecords = artifact.records.map((row) => {
    if (row.section !== 'journals') return row;
    const assessment =
      row.sessionId === sourceSessionId ? { meaningRevision: 2, units: 25 } : { meaningRevision: 1, units: null };
    return { ...row, journal: { ...(row.journal as Record<string, unknown>), assessment } };
  });
  const incompleteRecords = unknownRecords.map((row) => {
    if (row.section !== 'journals') return row;
    const journal = { ...(row.journal as Record<string, unknown>) };
    delete journal.assessment;
    return { ...row, journal };
  });
  expect((await send(unknownOwner, 'POST', mergePath, framed(incompleteRecords))).status).toBe(400);
  const unknown = await upload(unknownOwner, framed(unknownRecords));
  const unknownRows = (await previewAll(unknownOwner, unknown.uploadId as string)).records.filter(
    (row: any) => row.section === 'journals',
  );
  const unknownRow = unknownRows.find((row: any) => row.evidence.sessionId === sourceSessionId)!;
  const clearRow = unknownRows.find((row: any) => row.evidence.sessionId === repeatedSourceSessionId)!;
  await json(
    await send(unknownOwner, 'PATCH', `${mergePath}/${unknown.uploadId}/review`, {
      items: [
        {
          ordinal: unknownRow.ordinal,
          kind: 'journal',
          subjectId: subjects[0],
          sessionId: unknownTarget,
          fields: { assessment: 'set' },
        },
        {
          ordinal: clearRow.ordinal,
          kind: 'journal',
          subjectId: subjects[0],
          sessionId: clearTarget,
          fields: { assessment: 'clear' },
        },
      ],
    }),
  );
  const unknownReviewed = (await previewAll(unknownOwner, unknown.uploadId as string)).records;
  expect(unknownReviewed[unknownRow.ordinal]).toMatchObject({
    status: 'unsupported',
    review: { field: 'assessment', reason: 'unsupported-field-value' },
  });
  expect(unknownReviewed[clearRow.ordinal].status).toBe('mapped');
  expect(
    (
      await json(
        await send(unknownOwner, 'POST', `${mergePath}/${unknown.uploadId}/apply`, selected([clearRow.ordinal])),
      )
    ).applied,
  ).toMatchObject([{ status: 'accepted' }]);
  expect(await sessions.readSessionJournal(unknownOwner.actor, unknownTarget)).toMatchObject({
    revision: 1,
    assessment: { meaningRevision: 1, units: 7 },
  });
  expect(await sessions.readSessionJournal(unknownOwner.actor, clearTarget)).toMatchObject({
    revision: 2,
    assessment: { meaningRevision: 1, units: null },
  });

  const legacyOwner = await f.identity(exportScopes);
  const legacyTarget = await target(legacyOwner, 9);
  const legacyRecords = artifact.records.map((row) => {
    if (row.section !== 'journals') return row;
    const journal = { ...(row.journal as Record<string, unknown>) };
    delete journal.assessment;
    return { ...row, journal };
  });
  const legacyManifest = {
    ...libraryExportManifest({
      export_id: randomUUID(),
      created_at: artifact.manifest.capturedAt as string,
      expires_at: artifact.manifest.expiresAt as string,
      format_version: 2,
    }),
    fullExport: false,
  };
  const legacy = await upload(legacyOwner, framed(legacyRecords, legacyManifest));
  const legacyRow = (await previewAll(legacyOwner, legacy.uploadId as string)).records.find(
    (row: any) => row.section === 'journals',
  );
  await json(
    await send(legacyOwner, 'PATCH', `${mergePath}/${legacy.uploadId}/review`, {
      items: [
        {
          ordinal: legacyRow.ordinal,
          kind: 'journal',
          subjectId: subjects[0],
          sessionId: legacyTarget,
          fields: { assessment: 'clear' },
        },
      ],
    }),
  );
  expect((await previewAll(legacyOwner, legacy.uploadId as string)).records[legacyRow.ordinal]).toMatchObject({
    status: 'unsupported',
    review: { field: 'assessment', reason: 'unsupported-field-value' },
  });
  expect(await sessions.readSessionJournal(legacyOwner.actor, legacyTarget)).toMatchObject({
    revision: 1,
    assessment: { meaningRevision: 1, units: 9 },
  });
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
  const missingJournal = missingRows.find((row: any) => row.section === 'journals')!;
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
          sessionId: sourceSessionId,
          fields: { startDate: 'set' },
        },
      ],
    }),
  );
  const missingReviewed = (await previewAll(missingFactOwner, missing.id)).records;
  expect(missingReviewed.find((row: any) => row.ordinal === missingAnnotation.ordinal).status).toBe('unresolved');
  expect(missingReviewed.find((row: any) => row.ordinal === missingJournal.ordinal).status).toBe('unresolved');
  expect(
    (
      await json(
        await send(
          missingFactOwner,
          'POST',
          `${mergePath}/${missing.id}/apply`,
          selected([missingAnnotation.ordinal, missingJournal.ordinal]),
        ),
      )
    ).applied,
  ).toMatchObject([{ status: 'stale' }, { status: 'stale' }]);

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
  await f.pool.query(
    `UPDATE library.library_archive_merge_upload SET expires_at=clock_timestamp()-interval '1 second'
     WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
    [routeOf(pruneOwner.actor.accountId), pruneOwner.actor.accountId, expiring.id],
  );
  const pruned = await json(await send(pruneOwner, 'POST', `${mergePath}/${expiring.id}/prune`));
  expect(pruned).toMatchObject({ removed: artifact.records.length, complete: true });
});

test('cancellation stops pending effects and terminal erasure removes retained archive data', async () => {
  const before = (await f.commands.putEntry(cancelledOwner.actor, subjects[0], { state: 'completed' }, entryKey()))
    .value.entry;
  const sessions = createSessionCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  const targetSession = await sessions.startSession(
    cancelledOwner.actor,
    { subjectId: subjects[0], mode: 'scalar_amount', unit: 'page' },
    key(),
  );
  await sessions.patchSessionJournal(
    cancelledOwner.actor,
    targetSession.value.id,
    { revision: 0, assessment: { units: 2 } },
    key(),
  );
  const { id } = await makeUpload(cancelledOwner);
  const rows = (await previewAll(cancelledOwner, id)).records;
  const entry = rows.find((row: any) => row.section === 'entries' && row.evidence.subject_id === subjects[0]);
  const label = rows.find((row: any) => row.section === 'labels' && row.evidence.label_id === sourceLabels[1]);
  const journal = rows.find((row: any) => row.section === 'journals');
  await json(
    await send(cancelledOwner, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        { ordinal: entry.ordinal, kind: 'entry', subjectId: subjects[0], stateId: 'planned', action: 'update' },
        { ordinal: label.ordinal, kind: 'label', target: { mode: 'create' } },
        {
          ordinal: journal.ordinal,
          kind: 'journal',
          subjectId: subjects[0],
          sessionId: targetSession.value.id,
          fields: { assessment: 'set' },
        },
      ],
    }),
  );
  await json(await send(cancelledOwner, 'POST', `${mergePath}/${id}/apply`, selected([label.ordinal, journal.ordinal])));
  await json(await send(cancelledOwner, 'DELETE', `${mergePath}/${id}`));
  expect((await send(cancelledOwner, 'POST', `${mergePath}/${id}/apply`, selected([entry.ordinal]))).status).toBe(409);
  expect((await f.commands.readEntry(cancelledOwner.actor, subjects[0])).state).toBe(before.state);
  const results = await json(await send(cancelledOwner, 'GET', `${mergePath}/${id}/results`));
  expect(results.results.find((row: any) => row.ordinal === label.ordinal).status).toBe('acknowledged');
  expect(results.results.find((row: any) => row.ordinal === journal.ordinal).status).toBe('accepted');
  expect(await sessions.readSessionJournal(cancelledOwner.actor, targetSession.value.id)).toMatchObject({
    assessment: { meaningRevision: 1, units: 14 },
  });

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
