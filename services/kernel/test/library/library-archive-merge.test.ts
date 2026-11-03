import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';
import { routeOf } from '../../src/route/route.ts';
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
  'progress_session:read',
  'collection:read',
];
const mergePath = '/v1/libraryArchiveMerges';
const key = () => randomUUID();
let f: NativeProfileFixture;
let source: Identity, main: Identity, createOwner: Identity, staleRevision: Identity, staleIncarnation: Identity;
let unknownStateOwner: Identity, cancelledOwner: Identity, deletedOwner: Identity;
let subjects: [string, string];
let artifact: Archive;
let sourceLabels: [string, string];

function send(person: Identity, method: string, path: string, body?: unknown) {
  return f.send(person.bearer, method, path, body, key());
}
async function json(response: Response, status = 200) {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  expect(response.headers.get('cache-control')).toContain('no-store');
  return response.json() as Promise<Record<string, any>>;
}
function framed(records: RecordRow[]): Archive {
  return {
    manifest: {
      ...artifact.manifest,
      rows: records.length,
      recordBytes: records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0),
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
}, 120_000);

afterAll(async () => {
  await f?.close();
});

test('the actual installed archive is privately reviewed, explicitly merged and replayed through native commands', async () => {
  const wrong = framed(artifact.records);
  wrong.manifest.version = 2;
  expect((await send(main, 'POST', mergePath, wrong)).status).toBe(400);
  expect((await send(main, 'POST', mergePath, { records: artifact.records })).status).toBe(400);
  expect((await send(main, 'POST', mergePath, framed([...artifact.records, artifact.records[0]!]))).status).toBe(400);
  const label = artifact.records.find((row) => row.section === 'labels')!;
  const duplicateName = { ...label, label_id: randomUUID() } as RecordRow;
  const duplicateNameResponse = await send(main, 'POST', mergePath, framed([...artifact.records, duplicateName]));
  expect(duplicateNameResponse.status).toBe(400);
  expect(await duplicateNameResponse.text()).not.toContain('archive second');

  const { id } = await makeUpload(main);
  expect((await send(source, 'GET', `${mergePath}/${id}`)).status).toBe(404);
  expect((await send(source, 'POST', `${mergePath}/${id}/apply`, { ordinals: [0] })).status).toBe(404);
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
    ]),
  );
  const entryOne = rows.find((row) => row.section === 'entries' && row.evidence.subject_id === subjects[0])!;
  const entryTwo = rows.find((row) => row.section === 'entries' && row.evidence.subject_id === subjects[1])!;
  const labelOne = rows.find((row) => row.section === 'labels' && row.evidence.label_id === sourceLabels[0])!;
  const labelTwo = rows.find((row) => row.section === 'labels' && row.evidence.label_id === sourceLabels[1])!;
  const assignment = rows.find((row) => row.section === 'assignments')!;
  const targetLabels = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
  const existingLabel = (await targetLabels.listLabels(main.actor, { limit: 100 })).labels[0]!;
  await json(
    await send(main, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        { ordinal: entryOne.ordinal, kind: 'entry', subjectId: subjects[0], stateId: 'planned', action: 'update' },
        { ordinal: entryTwo.ordinal, kind: 'entry', subjectId: subjects[1], action: 'preserve' },
        { ordinal: labelOne.ordinal, kind: 'label', target: { mode: 'existing', labelId: existingLabel.id } },
        { ordinal: labelTwo.ordinal, kind: 'label', target: { mode: 'create' } },
      ],
    }),
  );
  const historyBefore = await f.pool.query(
    'SELECT revision FROM library.entry_state_change WHERE route=$1 AND account_id=$2 AND subject_id=$3 ORDER BY revision',
    [routeOf(main.actor.accountId), main.actor.accountId, subjects[0]],
  );
  const appliedEntries = await json(
    await send(main, 'POST', `${mergePath}/${id}/apply`, { ordinals: [entryOne.ordinal, entryTwo.ordinal] }),
  );
  expect(appliedEntries.applied).toMatchObject([{ status: 'acknowledged' }, { status: 'preserved' }]);
  expect((await f.commands.readEntry(main.actor, subjects[0])).state).toBe('planned');
  expect((await f.commands.readEntry(main.actor, subjects[1])).state).toBe('completed');
  const historyAfter = await f.pool.query(
    'SELECT revision FROM library.entry_state_change WHERE route=$1 AND account_id=$2 AND subject_id=$3 ORDER BY revision',
    [routeOf(main.actor.accountId), main.actor.accountId, subjects[0]],
  );
  expect(historyAfter.rows.length).toBe(historyBefore.rows.length + 1);

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
  await json(await send(main, 'POST', `${mergePath}/${id}/apply`, { ordinals: [labelTwo.ordinal] }));
  const created = (await nativeLabels.listLabels(main.actor, { limit: 100, q: 'archive second' })).labels;
  expect(created).toHaveLength(1);
  expect(created[0]!.revision).toBe(1);

  await json(
    await send(main, 'PATCH', `${mergePath}/${id}/review`, {
      items: [{ ordinal: assignment.ordinal, kind: 'assignment', subjectId: subjects[1], action: 'assign' }],
    }),
  );
  await json(await send(main, 'POST', `${mergePath}/${id}/apply`, { ordinals: [assignment.ordinal] }));
  const assignmentRows = await createLabelAssignmentCommands({
    pool: f.pool,
    access: f.access,
    tokens: f.tokens,
  }).listAssignments(main.actor, { labelId: created[0]!.id, subjectId: subjects[1], limit: 1 });
  expect(assignmentRows.assignments).toHaveLength(1);
  const resultPage = await json(await send(main, 'GET', `${mergePath}/${id}/results?limit=1`));
  expect(resultPage.results).toHaveLength(1);
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
    await send(createOwner, 'POST', `${mergePath}/${id}/apply`, { ordinals: [first.ordinal, second.ordinal] }),
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
    const result = await json(await send(person, 'POST', `${mergePath}/${id}/apply`, { ordinals: [entry.ordinal] }));
    expect(result.applied).toMatchObject([{ status: 'current_conflict', result: { code: 'current_conflict' } }]);
  }
});

test('cancellation stops pending effects and terminal erasure removes retained archive data', async () => {
  const before = (await f.commands.putEntry(cancelledOwner.actor, subjects[0], { state: 'completed' }, entryKey()))
    .value.entry;
  const { id } = await makeUpload(cancelledOwner);
  const rows = (await previewAll(cancelledOwner, id)).records;
  const entry = rows.find((row: any) => row.section === 'entries' && row.evidence.subject_id === subjects[0]);
  const label = rows.find((row: any) => row.section === 'labels' && row.evidence.label_id === sourceLabels[1]);
  await json(
    await send(cancelledOwner, 'PATCH', `${mergePath}/${id}/review`, {
      items: [
        { ordinal: entry.ordinal, kind: 'entry', subjectId: subjects[0], stateId: 'planned', action: 'update' },
        { ordinal: label.ordinal, kind: 'label', target: { mode: 'create' } },
      ],
    }),
  );
  await json(await send(cancelledOwner, 'POST', `${mergePath}/${id}/apply`, { ordinals: [label.ordinal] }));
  await json(await send(cancelledOwner, 'DELETE', `${mergePath}/${id}`));
  expect((await send(cancelledOwner, 'POST', `${mergePath}/${id}/apply`, { ordinals: [entry.ordinal] })).status).toBe(
    409,
  );
  expect((await f.commands.readEntry(cancelledOwner.actor, subjects[0])).state).toBe(before.state);
  const results = await json(await send(cancelledOwner, 'GET', `${mergePath}/${id}/results`));
  expect(results.results.find((row: any) => row.ordinal === label.ordinal).status).toBe('acknowledged');

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
    ['POST', `${mergePath}/${deletedId}/apply`, { ordinals: [0] }],
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
