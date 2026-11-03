import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { batchCommand } from '../../src/semantic/bulk.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { bangumiMetadataProposals, createBangumiImport } from '../../src/library/list-import-bangumi.ts';
import { parseBangumiUpload } from '../../src/library/list-import-bangumi-model.ts';
import { malMetadataProposals } from '../../src/library/list-import-mal.ts';
import { parseMal } from '../../src/library/list-import-mal-parser.ts';
import { anilistMetadataProposals } from '../../src/library/list-import-anilist.ts';
import { parseAniList } from '../../src/library/list-import-anilist-parser.ts';
import { vndbMetadataProposals } from '../../src/library/list-import-vndb.ts';
import { parseVndb } from '../../src/library/list-import-vndb-parser.ts';
import { partitionOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { testRouteKey } from '../support/test-kernel.ts';

let f: NativeProfileFixture;
let subjectId: string;
const providerId = 815432;
const root = '/v1/libraryImports/bangumi';
const send = (method: string, path: string, body?: unknown, persona = 'owner') => f.send(persona, method, path, body);
const row = (source: Record<string, unknown>) => ({
  upload: JSON.stringify({ format: 'rezics.bangumi-collection.v1', collections: [source] }),
});
async function body(response: Response, expected = 200) {
  expect(response.status).toBe(expected);
  return response.json();
}
async function personal() {
  return (await body(await send('GET', `/v1/libraryEntries/${subjectId}/personal`))).personalEntry;
}

beforeAll(async () => {
  f = await createProfileEntryFixture();
  const importer = await f.identity(['subject:batch_write', 'subject:read']);
  await createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' }).create(
    { pool: f.pool, actor: f.steward.actor, deadline: Date.now() + 30_000 },
    {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: importer.actor.accountId },
      actions: ['subject:batch_write'],
      valid: '(,)',
      key: randomUUID(),
    },
  );
  const sourceRoute = tupleRoute(testRouteKey(), 'bangumi', String(providerId));
  const imported = await batchCommand(f.pool, {
    actor: importer.actor,
    route: sourceRoute,
    routeKey: testRouteKey(),
    clock: () => new Date(),
    deadline: Date.now() + 30_000,
    authorization: resourceAuthorization({
      access: f.access,
      actor: importer.actor,
      action: 'subject:batch_write',
      anchor: globalContextAnchor,
      context: { pool: f.pool, deadline: Date.now() + 30_000, partition: partitionOf(sourceRoute) },
    }),
    release: { digest: f.originalDigest, release: f.original },
    command: {
      op: 'create',
      key: randomUUID(),
      subject: { type: 'ex:Child', labels: { en: 'Retained provider subject' } },
      source: {
        source: 'bangumi',
        external_id: String(providerId),
        record_revision: 'v0',
        digest: 'a'.repeat(64),
        converter_revision: 'fixture',
        field_group: 'facts',
      },
    },
  });
  if (!('id' in imported.value)) throw new Error('Native provider subject was not created');
  subjectId = imported.value.id;
}, 120_000);

afterAll(async () => f?.close());

test('retained metadata review adopts selected native facts, preserves partial work and replays the original confirmation', async () => {
  await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, entryKey());
  await body(await send('PUT', `/v1/libraryEntries/${subjectId}/annotations`, {
    revision: 0,
    note: { op: 'set', value: 'Local note' },
    priority: { op: 'set', value: 7 },
  }));
  await body(await send('POST', `/v1/libraryEntries/${subjectId}/sourceObservations`, {
    provider: 'mal', recordId: 'list/17', confirmReviewed: true,
    privacy: { status: 'unknown', sourceValue: 'retained-privacy-v2' },
    sourceCreated: { status: 'absent' }, sourceUpdated: { status: 'absent' },
  }), 201);

  const source = {
    subject_id: providerId, subject_type: 2, type: 1, comment: 'Provider note', private: true,
    created_at: '2019-02-03T04:05:06.1234567+08:00', updated_at: '2022-06-19T18:44:13.6140127+08:00',
  };
  const { uploadId } = await body(await send('POST', `${root}:preview`, row(source)));
  const sourceReview = (await body(await send('POST', `${root}/${uploadId}:review`, { ordinal: 0 }))).review;
  await body(await send('POST', `${root}/${uploadId}:apply`, {
    rows: [{ ordinal: 0, reviewToken: sourceReview.token, state: 'replace', skip: false }],
  }));
  const beforeConsent = await personal();
  expect(beforeConsent).toMatchObject({ note: 'Local note', priority: 7, sourceObservations: [{ provider: 'mal' }] });

  const metadataReview = async () => body(await send('POST', `${root}/${uploadId}:reviewMetadata`, {
    ordinal: 0, sourceReviewToken: sourceReview.token,
  }));
  const first = await metadataReview();
  const firstView = await body(await send('GET', `${root}/${uploadId}/metadata/0?reviewToken=${first.reviewToken}`));
  expect(firstView).toMatchObject({ status: 'current', personal: { note: 'Local note', priority: 7 } });
  expect(firstView.proposals.note).toMatchObject({ state: 'value', sourceField: 'comment', value: 'Provider note' });
  expect(firstView.proposals.priority.state).toBe('unsupported');

  await body(await send('PUT', `/v1/libraryEntries/${subjectId}/annotations`, {
    revision: beforeConsent.annotationRevision,
    note: { op: 'set', value: 'Edited after review' },
    priority: { op: 'unchanged' },
  }));
  const staleFields = [{ field: 'note', action: 'adopt' }];
  const stale = await body(await send('POST', `${root}/${uploadId}:applyMetadata`, {
    ordinal: 0, reviewToken: first.reviewToken, fields: staleFields,
  }));
  expect(stale.fields).toEqual([{ field: 'note', status: 'stale' }]);
  expect(await body(await send('POST', `${root}/${uploadId}:applyMetadata`, {
    ordinal: 0, reviewToken: first.reviewToken, fields: staleFields,
  }))).toEqual(stale);

  const refreshed = await metadataReview();
  const refreshedView = await body(await send('GET', `${root}/${uploadId}/metadata/0?reviewToken=${refreshed.reviewToken}`));
  expect(refreshedView).toMatchObject({ status: 'current', personal: { note: 'Edited after review', priority: 7 } });
  const fields = [
    { field: 'note', action: 'adopt' }, { field: 'priority', action: 'adopt' },
    { field: 'privacy', action: 'adopt' }, { field: 'sourceCreated', action: 'adopt' },
    { field: 'sourceUpdated', action: 'adopt' },
  ];
  let signalReads = 0;
  const cancelAfterAnnotation = Object.defineProperty({}, 'aborted', {
    get: () => ++signalReads > 1,
  }) as AbortSignal;
  const engine = createBangumiImport({
    pool: f.pool, access: f.access, tokens: f.tokens, routeKey: testRouteKey(),
  });
  const partial = await engine.applyMetadata(f.owner.actor, uploadId, 0, refreshed.reviewToken, fields, cancelAfterAnnotation);
  expect(partial.fields.map(({ field, status }) => [field, status])).toEqual([
    ['note', 'applied'], ['priority', 'unsupported'], ['privacy', 'unattempted'],
    ['sourceCreated', 'unattempted'], ['sourceUpdated', 'unattempted'],
  ]);

  const applied = await body(await send('POST', `${root}/${uploadId}:applyMetadata`, {
    ordinal: 0, reviewToken: refreshed.reviewToken, fields,
  }));
  expect(applied.fields.map(({ field, status }: { field: string; status: string }) => [field, status])).toEqual([
    ['note', 'applied'], ['priority', 'unsupported'], ['privacy', 'applied'],
    ['sourceCreated', 'applied'], ['sourceUpdated', 'applied'],
  ]);
  const saved = await personal();
  expect(saved).toMatchObject({ annotationRevision: beforeConsent.annotationRevision + 2, note: 'Provider note', priority: 7 });
  const mal = saved.sourceObservations.find((item: { provider: string }) => item.provider === 'mal');
  const bangumi = saved.sourceObservations.find((item: { provider: string }) => item.provider === 'bangumi');
  expect(mal).toMatchObject({ privacy: { status: 'unknown', sourceValue: 'retained-privacy-v2' } });
  expect(bangumi).toMatchObject({
    privacy: { status: 'known', meaning: 'private' },
    sourceCreated: { status: 'known', value: source.created_at },
    sourceUpdated: { status: 'known', value: source.updated_at },
  });
  expect(bangumi.recordedAt).not.toBe(source.updated_at);
  expect(await body(await send('POST', `${root}/${uploadId}:applyMetadata`, {
    ordinal: 0, reviewToken: refreshed.reviewToken, fields,
  }))).toEqual(applied);
  expect(await personal()).toEqual(saved);
  expect((await send('GET', `${root}/${uploadId}/metadata/0?reviewToken=${refreshed.reviewToken}`, undefined, 'other')).status).toBe(404);

  await body(await send('DELETE', `${root}/${uploadId}`));
  expect((await send('GET', `${root}/${uploadId}/metadata/0?reviewToken=${refreshed.reviewToken}`)).status).toBe(404);
  expect(await personal()).toEqual(saved);

  const absentUpload = await body(await send('POST', `${root}:preview`, row({ subject_id: providerId, subject_type: 2, type: 1 })));
  const absentSourceReview = (await body(await send('POST', `${root}/${absentUpload.uploadId}:review`, { ordinal: 0 }))).review;
  const absentReview = await body(await send('POST', `${root}/${absentUpload.uploadId}:reviewMetadata`, {
    ordinal: 0, sourceReviewToken: absentSourceReview.token,
  }));
  const absentView = await body(await send('GET', `${root}/${absentUpload.uploadId}/metadata/0?reviewToken=${absentReview.reviewToken}`));
  expect(absentView.proposals).toMatchObject({
    note: { state: 'absent' }, privacy: { state: 'absent' },
    sourceCreated: { state: 'absent' }, sourceUpdated: { state: 'absent' },
  });
  const cleared = await body(await send('POST', `${root}/${absentUpload.uploadId}:applyMetadata`, {
    ordinal: 0, reviewToken: absentReview.reviewToken,
    fields: [
      { field: 'note', action: 'clear' }, { field: 'priority', action: 'clear' },
      { field: 'privacy', action: 'adopt' }, { field: 'sourceCreated', action: 'adopt' },
      { field: 'sourceUpdated', action: 'adopt' },
    ],
  }));
  expect(cleared.fields.every(({ status }: { status: string }) => status === 'applied')).toBe(true);
  const afterClear = await personal();
  expect(afterClear).toMatchObject({ note: null, priority: null });
  expect(afterClear.sourceObservations.find((item: { provider: string }) => item.provider === 'bangumi')).toMatchObject({
    privacy: { status: 'absent' }, sourceCreated: { status: 'absent' }, sourceUpdated: { status: 'absent' },
  });
  expect(afterClear.sourceObservations.find((item: { provider: string }) => item.provider === 'mal')).toEqual(mal);

  const pendingUpload = await body(await send('POST', `${root}:preview`, row(source)));
  const pendingSourceReview = (await body(await send('POST', `${root}/${pendingUpload.uploadId}:review`, { ordinal: 0 }))).review;
  const pending = await body(await send('POST', `${root}/${pendingUpload.uploadId}:reviewMetadata`, {
    ordinal: 0, sourceReviewToken: pendingSourceReview.token,
  }));
  await body(await send('POST', `${root}/${pendingUpload.uploadId}:cancel`));
  expect((await send('POST', `${root}/${pendingUpload.uploadId}:applyMetadata`, {
    ordinal: 0, reviewToken: pending.reviewToken, fields: [{ field: 'note', action: 'adopt' }],
  })).status).toBe(409);
  await body(await send('DELETE', `${root}/${pendingUpload.uploadId}`));
  expect((await send('GET', `${root}/${pendingUpload.uploadId}/metadata/0?reviewToken=${pending.reviewToken}`)).status).toBe(404);
  expect(await personal()).toEqual(afterClear);
});

test('provider proposals retain supported fields, unknown privacy and unsupported meanings without conversion', () => {
  const bangumiRow = parseBangumiUpload(JSON.stringify({
    format: 'rezics.bangumi-collection.v1',
    collections: [{ comment: 'note', private: true, created_at: '2020-01', updated_at: '2021-02-03' }],
  }))[0]!;
  expect(bangumiMetadataProposals(bangumiRow)).toMatchObject({
    note: { state: 'value', value: 'note' }, priority: { state: 'unsupported' },
    privacy: { state: 'value', value: { status: 'known', meaning: 'private' } },
    sourceCreated: { value: { status: 'known', value: '2020-01' } },
    sourceUpdated: { value: { status: 'known', value: '2021-02-03' } },
  });

  const vndbRow = parseVndb('<vndb-export version="1.0" uid="u1"><vns><vn id="v123"><title>Display</title><label label="Playing" private="1"/><notes>note</notes><started>2020-05-00</started></vn></vns></vndb-export>')[0]!;
  expect(vndbMetadataProposals(vndbRow)).toMatchObject({
    note: { state: 'value', value: 'note' }, privacy: { state: 'value', value: { status: 'known', meaning: 'private' } },
    priority: { state: 'unsupported' }, sourceCreated: { state: 'unsupported' }, sourceUpdated: { state: 'unsupported' },
  });

  const aniListRow = parseAniList(JSON.stringify([{ notes: 'note', private: true, priority: 3, createdAt: 1700000000 }])).rows[0]!;
  expect(anilistMetadataProposals(aniListRow)).toMatchObject({
    note: { state: 'value', value: 'note' }, privacy: { state: 'value', value: { status: 'known', meaning: 'private' } },
    priority: { state: 'unsupported' }, sourceCreated: { state: 'unknown', value: { status: 'unknown', sourceValue: '1700000000' } },
  });

  const malRows = parseMal(`<myanimelist>${[0, 1, 2].map((priority, index) =>
    `<anime><series_animedb_id>${index + 17}</series_animedb_id><series_title>Title</series_title><my_status>Completed</my_status><my_priority>${priority}</my_priority><my_privacy>1</my_privacy></anime>`,
  ).join('')}</myanimelist>`);
  const proposals = malRows.map(malMetadataProposals);
  expect(proposals.map(({ priority }) => priority.value)).toEqual([100, 50, 1]);
  expect(proposals.map(({ priority }) => priority.mapping?.id)).toEqual(Array(3).fill('mal-priority-position-v1'));
  expect(proposals.map(({ privacy }) => privacy.state)).toEqual(Array(3).fill('unknown'));
});
