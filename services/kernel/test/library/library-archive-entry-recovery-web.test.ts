import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { ArchiveEntryRecoveryJourney } from '../../../../apps/web/src/library/archive-entry-recovery/controller';
import { archiveRecoveryNative } from '../../../../apps/web/src/library/archive-entry-recovery/native';
import { createPersonalLabelCommands } from '../../src/library/label-commands';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands';
import { routeOf } from '../../src/route/route';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture';

const scopes = [
  'subject:create',
  'subject:read',
  'library_entry:read',
  'library_entry:list',
  'library_entry:update',
  'library_entry:delete',
  'progress_session:list',
  'progress_session:read',
  'copy:list',
  'collection:read',
];
let f: NativeProfileFixture;
let subjectId: string;
let artifact: { manifest: Record<string, unknown>; records: Record<string, unknown>[] };
beforeAll(async () => {
  f = await createProfileEntryFixture({ ownerScopes: scopes });
  for (const group of ['personal_library', 'reading_progress', 'collections'])
    expect((await f.send('steward', 'POST', `/v1/platform/exposure/${group}:open`)).status).toBe(200);
  subjectId = await f.createSubject('game', 'Web archive recovery');
  await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, entryKey());
  const labels = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
  const label = (await labels.createLabel(f.owner.actor, { name: 'Archived private label' }, entryKey())).value.label;
  await createLabelAssignmentCommands({ pool: f.pool, access: f.access, tokens: f.tokens }).assignLabel(
    f.owner.actor,
    label.id,
    { subjectId },
    entryKey(),
  );
  const created = await f.send('owner', 'POST', '/v1/libraryExports');
  expect(created.status).toBe(200);
  const { exportId } = await created.json();
  const status = await (await f.send('owner', 'GET', `/v1/libraryExports/${exportId}`)).json();
  const records: Record<string, unknown>[] = [];
  let manifest: Record<string, unknown> | null = null;
  for (let cursor = status.first; cursor;) {
    const page = await (
      await f.send('owner', 'GET', `/v1/libraryExports/${exportId}/pages?cursor=${encodeURIComponent(cursor)}`)
    ).json();
    records.push(...page.records);
    manifest = page.manifest ?? manifest;
    cursor = page.next;
  }
  expect(manifest).not.toBeNull();
  expect(manifest!.version).toBe(4);
  artifact = { manifest: manifest!, records };
}, 120_000);
afterAll(async () => {
  await f?.close();
});

type Identity = Awaited<ReturnType<NativeProfileFixture['identity']>>;
function receiver(owner: Identity, loseAck = false) {
  const calls: { path: string; body: string; bytes: number; bodyBase64: string }[] = [];
  let dropped = false;
  const client = createKernelClient('http://kernel.test', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const bodyBase64 = Buffer.from(await request.clone().arrayBuffer()).toString('base64');
        const response = await f.handle(request.clone());
        const body = await request.text();
        calls.push({ path, body, bodyBase64, bytes: (await response.clone().arrayBuffer()).byteLength });
        if (loseAck && !dropped && path.endsWith('/apply') && response.status === 200) {
          dropped = true;
          const { uploadId, applied } = await response.clone().json();
          // Existing native uncertain-checkpoint scenario: the effect committed, its key remains,
          // but the archive checkpoint acknowledgement has not arrived.
          await f.pool.query(
            "UPDATE library.library_archive_merge_item SET status='applying', result=NULL WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4",
            [routeOf(owner.actor.accountId), owner.actor.accountId, uploadId, applied[0].ordinal],
          );
          return Response.json({ code: 'temporarily_unavailable' }, { status: 503 });
        }
        return response;
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const binding = {
    viewer: owner.actor.accountId,
    credentialEpoch: owner.bearer,
    csrfEpoch: 'native-bearer',
    admission: 'native-current',
    source: 'native-file',
    route: '/library/recover-archive',
    locale: 'en',
    exposure: 'native-current',
  };
  const port = archiveRecoveryNative(client, `Bearer ${owner.bearer}`);
  const journey = new ArchiveEntryRecoveryJourney(port, () => binding, Date.now() + 300_000);
  return { journey, port, calls };
}
const file = () => new File([JSON.stringify(artifact, null, 2)], 'completed-v4.json', { type: 'application/json' });

test('Native producer file passes mounted receiving selection, preserved Entry, label creation, assignment and current reads', async () => {
  const owner = await f.identity(scopes);
  const original = (await f.commands.putEntry(owner.actor, subjectId, { state: 'in_progress' }, entryKey())).value
    .entry;
  const { journey, calls } = receiver(owner);
  try {
    await journey.upload(file());
    const rows = journey.snapshot().state!.page!.rows;
    const entry = rows.find((row) => row.section === 'entries' && row.evidence.subject_id === subjectId)!;
    const label = rows.find((row) => row.section === 'labels')!;
    const assignment = rows.find((row) => row.section === 'assignments')!;
    expect(
      journey.snapshot().state!.upload!.metadata.coverage.some((item) => item.treatment === 'retained-unsupported'),
    ).toBe(true);
    journey.choose({ ordinal: entry.ordinal, kind: 'entry', subjectId, action: 'preserve' });
    journey.choose({ ordinal: label.ordinal, kind: 'label', target: { mode: 'create' } });
    await journey.review();
    const confirmation = journey.snapshot().state!.review!.body;
    expect(confirmation.items.every((item) => item.reviewRevision > 0)).toBe(true);
    await journey.apply();
    await journey.results();
    expect(await f.commands.readEntry(owner.actor, subjectId)).toMatchObject({
      state: 'in_progress',
      revision: original.revision,
    });
    await journey.readCurrent(label.ordinal);
    expect(journey.snapshot().readback?.value).toMatchObject({ label: { name: 'Archived private label' } });
    journey.unselect(entry.ordinal);
    journey.unselect(label.ordinal);
    journey.choose({ ordinal: assignment.ordinal, kind: 'assignment', subjectId, action: 'assign' });
    await journey.review();
    await journey.apply();
    await journey.readCurrent(assignment.ordinal);
    expect(journey.snapshot().readback?.value).toMatchObject({ libraryEntry: { state: 'in_progress' } });
    const assignments = await createLabelAssignmentCommands({
      pool: f.pool,
      access: f.access,
      tokens: f.tokens,
    }).listAssignments(owner.actor, { subjectId, limit: 1 });
    expect(assignments.assignments).toHaveLength(1);
    // Complete native envelopes, not page counts or artifact recordBytes, determine caller bytes.
    const previewBytes = calls.filter((call) => call.path.endsWith('/preview')).map((call) => call.bytes);
    const resultBytes = calls.filter((call) => call.path.endsWith('/results')).map((call) => call.bytes);
    expect(previewBytes.every((bytes) => bytes > 0)).toBe(true);
    console.info(
      JSON.stringify({
        archiveEntryCaller: {
          requests: calls.length,
          responseBytes: calls.reduce((sum, call) => sum + call.bytes, 0),
          previewBytes,
          resultBytes,
        },
      }),
    );
    expect(calls.filter((call) => call.path.endsWith('/preview'))).toHaveLength(3);
  } finally {
    journey.retire();
  }
}, 120_000);

test('Native effect before acknowledgement retries exact review/key after cancel and preserves a later local edit', async () => {
  const owner = await f.identity(scopes);
  const { journey, calls } = receiver(owner, true);
  try {
    await journey.upload(file());
    const entry = journey
      .snapshot()
      .state!.page!.rows.find((row) => row.section === 'entries' && row.evidence.subject_id === subjectId)!;
    journey.choose({ ordinal: entry.ordinal, kind: 'entry', subjectId, stateId: 'planned', action: 'create' });
    await journey.review();
    await journey.apply();
    expect(journey.snapshot().state!.phase).toBe('uncertain');
    const uploadId = journey.snapshot().state!.upload!.id;
    const keyBefore = await f.pool.query(
      'SELECT native_request_key FROM library.library_archive_merge_item WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4',
      [routeOf(owner.actor.accountId), owner.actor.accountId, uploadId, entry.ordinal],
    );
    const accepted = await f.commands.readEntry(owner.actor, subjectId);
    await f.commands.putEntry(
      owner.actor,
      subjectId,
      { state: 'completed', revision: accepted.revision, incarnationId: accepted.incarnationId },
      entryKey(),
    );
    await journey.cancel();
    await journey.results();
    expect(journey.snapshot().state!.phase).toBe('cancelling');
    await journey.apply();
    expect(journey.snapshot().state!.phase).toBe('cancelled');
    await journey.readCurrent(entry.ordinal);
    expect(journey.snapshot().readback?.value).toMatchObject({ libraryEntry: { state: 'completed' } });
    expect(calls.filter((call) => call.path.endsWith('/apply')).map((call) => call.body)).toEqual([
      calls.find((call) => call.path.endsWith('/apply'))!.body,
      calls.find((call) => call.path.endsWith('/apply'))!.body,
    ]);
    const keyAfter = await f.pool.query(
      'SELECT native_request_key FROM library.library_archive_merge_item WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4',
      [routeOf(owner.actor.accountId), owner.actor.accountId, uploadId, entry.ordinal],
    );
    expect(keyAfter.rows).toEqual(keyBefore.rows);
  } finally {
    journey.retire();
  }
}, 120_000);

test('Native file boundary preserves malformed, unsupported, count and cross-owner outcomes', async () => {
  const owner = await f.identity(scopes);
  const { journey, port } = receiver(owner);
  try {
    for (const text of [
      '{broken',
      JSON.stringify({ ...artifact, manifest: { ...artifact.manifest, sectionTotals: undefined } }),
      JSON.stringify({ ...artifact, manifest: { ...artifact.manifest, version: 5 } }),
      JSON.stringify({ ...artifact, manifest: { ...artifact.manifest, rows: Number(artifact.manifest.rows) + 1 } }),
    ]) {
      const reply = await port.upload(text, entryKey());
      expect(reply.kind).toBe('refused');
      if (reply.kind === 'refused') expect(reply.status).toBe(400);
    }
    await journey.upload(file());
    const id = journey.snapshot().state!.upload!.id;
    const foreign = receiver(await f.identity(scopes));
    try {
      expect(await foreign.port.status(id)).toMatchObject({ kind: 'refused', status: 404 });
      expect(await foreign.port.preview(id)).toMatchObject({ kind: 'refused', status: 404 });
      expect(await foreign.port.apply(id, { items: [{ ordinal: 0, reviewRevision: 1 }] })).toMatchObject({
        kind: 'refused',
        status: 404,
      });
    } finally {
      foreign.journey.retire();
    }
  } finally {
    journey.retire();
  }
}, 120_000);

test('mounted file upload preserves invalid UTF-8 for native rejection and original-intent replay', async () => {
  const owner = await f.identity(scopes);
  const { journey, calls } = receiver(owner);
  const prefix = new TextEncoder().encode(JSON.stringify(artifact).replace('planned', 'MARKER'));
  const index = Buffer.from(prefix).indexOf('MARKER');
  expect(index).toBeGreaterThan(0);
  prefix[index] = 0xff;
  try {
    await journey.upload(new File([prefix], 'invalid-utf8.json'));
    expect(journey.snapshot().state?.upload).toBeNull();
    expect(journey.snapshot().notice).toBe('400:invalid_request');
    journey.restart();
    await journey.adoptOriginal();
    const uploads = calls.filter((call) => call.path === '/v1/libraryArchiveMerges');
    expect(uploads).toHaveLength(2);
    expect(uploads.map((call) => call.bodyBase64)).toEqual([
      Buffer.from(prefix).toString('base64'),
      Buffer.from(prefix).toString('base64'),
    ]);
    expect(journey.snapshot().notice).toBe('400:invalid_request');
    const live = await f.pool.query(
      'SELECT count(*)::int AS count FROM library.library_archive_merge_upload WHERE route=$1 AND account_id=$2',
      [routeOf(owner.actor.accountId), owner.actor.accountId],
    );
    expect(live.rows[0].count).toBe(0);
  } finally {
    journey.retire();
  }
}, 120_000);
