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
import { createSessionCommands } from '../../src/library/sessions.ts';
import { createVoteCommands } from '../../src/rating/votes.ts';
import { createMalImport, malMetadataProposals } from '../../src/library/list-import-mal.ts';
import { parseMal } from '../../src/library/list-import-mal-parser.ts';
import { createAniListImport, anilistMetadataProposals } from '../../src/library/list-import-anilist.ts';
import { parseAniList } from '../../src/library/list-import-anilist-parser.ts';
import { vndbMetadataProposals } from '../../src/library/list-import-vndb.ts';
import { parseVndb } from '../../src/library/list-import-vndb-parser.ts';
import {
  entryImportMetadataDigest,
  type EntryImportMetadataReview,
} from '../../src/library/list-import-entry-metadata.ts';
import { partitionOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { testRouteKey } from '../support/test-kernel.ts';

let f: NativeProfileFixture;
let subjectId: string;
let anilistSubjectId: string;
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
  for (const provider of ['bangumi', 'anilist']) {
    const sourceRoute = tupleRoute(testRouteKey(), provider, String(providerId));
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
          source: provider,
          external_id: String(providerId),
          record_revision: 'v0',
          digest: 'a'.repeat(64),
          converter_revision: 'fixture',
          field_group: 'facts',
        },
      },
    });
    if (!('id' in imported.value)) throw new Error('Native provider subject was not created');
    if (provider === 'bangumi') subjectId = imported.value.id;
    else anilistSubjectId = imported.value.id;
  }
}, 120_000);

afterAll(async () => f?.close());

test('retained metadata review adopts selected native facts, preserves partial work and replays the original confirmation', async () => {
  await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, entryKey());
  await body(
    await send('PUT', `/v1/libraryEntries/${subjectId}/annotations`, {
      revision: 0,
      note: { op: 'set', value: 'Local note' },
      priority: { op: 'set', value: 7 },
    }),
  );
  await body(
    await send('POST', `/v1/libraryEntries/${subjectId}/sourceObservations`, {
      provider: 'mal',
      recordId: 'list/17',
      confirmReviewed: true,
      privacy: { status: 'unknown', sourceValue: 'retained-privacy-v2' },
      sourceCreated: { status: 'absent' },
      sourceUpdated: { status: 'absent' },
    }),
    201,
  );

  const source = {
    subject_id: providerId,
    subject_type: 2,
    type: 1,
    comment: 'Provider note',
    private: true,
    created_at: '2019-02-03T04:05:06.1234567+08:00',
    updated_at: '2022-06-19T18:44:13.6140127+08:00',
  };
  const { uploadId } = await body(await send('POST', `${root}:preview`, row(source)));
  const sourceReview = (await body(await send('POST', `${root}/${uploadId}:review`, { ordinal: 0 }))).review;
  await body(
    await send('POST', `${root}/${uploadId}:apply`, {
      rows: [{ ordinal: 0, reviewToken: sourceReview.token, state: 'replace', skip: false }],
    }),
  );
  const beforeConsent = await personal();
  expect(beforeConsent).toMatchObject({ note: 'Local note', priority: 7, sourceObservations: [{ provider: 'mal' }] });

  const metadataReview = async () =>
    body(
      await send('POST', `${root}/${uploadId}:reviewMetadata`, {
        ordinal: 0,
        sourceReviewToken: sourceReview.token,
      }),
    );
  const first = await metadataReview();
  const firstView = await body(await send('GET', `${root}/${uploadId}/metadata/0?reviewToken=${first.reviewToken}`));
  expect(firstView).toMatchObject({ status: 'current', personal: { note: 'Local note', priority: 7 } });
  expect(firstView.proposals.note).toMatchObject({ state: 'value', sourceField: 'comment', value: 'Provider note' });
  expect(firstView.proposals.priority.state).toBe('unsupported');

  await body(
    await send('PUT', `/v1/libraryEntries/${subjectId}/annotations`, {
      revision: beforeConsent.annotationRevision,
      note: { op: 'set', value: 'Edited after review' },
      priority: { op: 'unchanged' },
    }),
  );
  const staleFields = [{ field: 'note', action: 'adopt' }];
  const stale = await body(
    await send('POST', `${root}/${uploadId}:applyMetadata`, {
      ordinal: 0,
      reviewToken: first.reviewToken,
      fields: staleFields,
    }),
  );
  expect(stale.fields).toEqual([{ field: 'note', status: 'stale' }]);
  expect(
    await body(
      await send('POST', `${root}/${uploadId}:applyMetadata`, {
        ordinal: 0,
        reviewToken: first.reviewToken,
        fields: staleFields,
      }),
    ),
  ).toEqual(stale);

  const refreshed = await metadataReview();
  const refreshedView = await body(
    await send('GET', `${root}/${uploadId}/metadata/0?reviewToken=${refreshed.reviewToken}`),
  );
  expect(refreshedView).toMatchObject({ status: 'current', personal: { note: 'Edited after review', priority: 7 } });
  const fields = [
    { field: 'note', action: 'adopt' },
    { field: 'priority', action: 'adopt' },
    { field: 'privacy', action: 'adopt' },
    { field: 'sourceCreated', action: 'adopt' },
    { field: 'sourceUpdated', action: 'adopt' },
  ];
  let signalReads = 0;
  const cancelAfterAnnotation = Object.defineProperty({}, 'aborted', {
    get: () => ++signalReads > 1,
  }) as AbortSignal;
  const engine = createBangumiImport({
    pool: f.pool,
    access: f.access,
    tokens: f.tokens,
    routeKey: testRouteKey(),
    votes: createVoteCommands({ pool: f.pool, access: f.access }),
  });
  const partial = await engine.applyMetadata(
    f.owner.actor,
    uploadId,
    0,
    refreshed.reviewToken,
    fields,
    cancelAfterAnnotation,
  );
  expect(partial.fields.map(({ field, status }) => [field, status])).toEqual([
    ['note', 'applied'],
    ['priority', 'unsupported'],
    ['privacy', 'unattempted'],
    ['sourceCreated', 'unattempted'],
    ['sourceUpdated', 'unattempted'],
  ]);

  const applied = await body(
    await send('POST', `${root}/${uploadId}:applyMetadata`, {
      ordinal: 0,
      reviewToken: refreshed.reviewToken,
      fields,
    }),
  );
  expect(applied.fields.map(({ field, status }: { field: string; status: string }) => [field, status])).toEqual([
    ['note', 'applied'],
    ['priority', 'unsupported'],
    ['privacy', 'applied'],
    ['sourceCreated', 'applied'],
    ['sourceUpdated', 'applied'],
  ]);
  const saved = await personal();
  expect(saved).toMatchObject({
    annotationRevision: beforeConsent.annotationRevision + 2,
    note: 'Provider note',
    priority: 7,
  });
  const mal = saved.sourceObservations.find((item: { provider: string }) => item.provider === 'mal');
  const bangumi = saved.sourceObservations.find((item: { provider: string }) => item.provider === 'bangumi');
  expect(mal).toMatchObject({ privacy: { status: 'unknown', sourceValue: 'retained-privacy-v2' } });
  expect(bangumi).toMatchObject({
    privacy: { status: 'known', meaning: 'private' },
    sourceCreated: { status: 'known', value: source.created_at },
    sourceUpdated: { status: 'known', value: source.updated_at },
  });
  expect(bangumi.recordedAt).not.toBe(source.updated_at);
  expect(
    await body(
      await send('POST', `${root}/${uploadId}:applyMetadata`, {
        ordinal: 0,
        reviewToken: refreshed.reviewToken,
        fields,
      }),
    ),
  ).toEqual(applied);
  expect(await personal()).toEqual(saved);
  expect(
    (await send('GET', `${root}/${uploadId}/metadata/0?reviewToken=${refreshed.reviewToken}`, undefined, 'other'))
      .status,
  ).toBe(404);

  await body(await send('DELETE', `${root}/${uploadId}`));
  expect((await send('GET', `${root}/${uploadId}/metadata/0?reviewToken=${refreshed.reviewToken}`)).status).toBe(404);
  expect(await personal()).toEqual(saved);

  const absentUpload = await body(
    await send('POST', `${root}:preview`, row({ subject_id: providerId, subject_type: 2, type: 1 })),
  );
  const absentSourceReview = (await body(await send('POST', `${root}/${absentUpload.uploadId}:review`, { ordinal: 0 })))
    .review;
  const absentReview = await body(
    await send('POST', `${root}/${absentUpload.uploadId}:reviewMetadata`, {
      ordinal: 0,
      sourceReviewToken: absentSourceReview.token,
    }),
  );
  const absentView = await body(
    await send('GET', `${root}/${absentUpload.uploadId}/metadata/0?reviewToken=${absentReview.reviewToken}`),
  );
  expect(absentView.proposals).toMatchObject({
    note: { state: 'absent' },
    privacy: { state: 'absent' },
    sourceCreated: { state: 'absent' },
    sourceUpdated: { state: 'absent' },
  });
  const cleared = await body(
    await send('POST', `${root}/${absentUpload.uploadId}:applyMetadata`, {
      ordinal: 0,
      reviewToken: absentReview.reviewToken,
      fields: [
        { field: 'note', action: 'clear' },
        { field: 'priority', action: 'clear' },
        { field: 'privacy', action: 'adopt' },
        { field: 'sourceCreated', action: 'adopt' },
        { field: 'sourceUpdated', action: 'adopt' },
      ],
    }),
  );
  expect(cleared.fields.every(({ status }: { status: string }) => status === 'applied')).toBe(true);
  const afterClear = await personal();
  expect(afterClear).toMatchObject({ note: null, priority: null });
  expect(afterClear.sourceObservations.find((item: { provider: string }) => item.provider === 'bangumi')).toMatchObject(
    {
      privacy: { status: 'absent' },
      sourceCreated: { status: 'absent' },
      sourceUpdated: { status: 'absent' },
    },
  );
  expect(afterClear.sourceObservations.find((item: { provider: string }) => item.provider === 'mal')).toEqual(mal);

  const pendingUpload = await body(await send('POST', `${root}:preview`, row(source)));
  const pendingSourceReview = (
    await body(await send('POST', `${root}/${pendingUpload.uploadId}:review`, { ordinal: 0 }))
  ).review;
  const pending = await body(
    await send('POST', `${root}/${pendingUpload.uploadId}:reviewMetadata`, {
      ordinal: 0,
      sourceReviewToken: pendingSourceReview.token,
    }),
  );
  await body(await send('POST', `${root}/${pendingUpload.uploadId}:cancel`));
  expect(
    (
      await send('POST', `${root}/${pendingUpload.uploadId}:applyMetadata`, {
        ordinal: 0,
        reviewToken: pending.reviewToken,
        fields: [{ field: 'note', action: 'adopt' }],
      })
    ).status,
  ).toBe(409);
  await body(await send('DELETE', `${root}/${pendingUpload.uploadId}`));
  expect(
    (await send('GET', `${root}/${pendingUpload.uploadId}/metadata/0?reviewToken=${pending.reviewToken}`)).status,
  ).toBe(404);
  expect(await personal()).toEqual(afterClear);
});

test('provider proposals retain supported fields, unknown privacy and unsupported meanings without conversion', () => {
  const bangumiRow = parseBangumiUpload(
    JSON.stringify({
      format: 'rezics.bangumi-collection.v1',
      collections: [{ comment: 'note', private: true, created_at: '2020-01', updated_at: '2021-02-03' }],
    }),
  )[0]!;
  expect(bangumiMetadataProposals(bangumiRow)).toMatchObject({
    note: { state: 'value', value: 'note' },
    priority: { state: 'unsupported' },
    privacy: { state: 'value', value: { status: 'known', meaning: 'private' } },
    sourceCreated: { value: { status: 'known', value: '2020-01' } },
    sourceUpdated: { value: { status: 'known', value: '2021-02-03' } },
  });

  const vndbRow = parseVndb(
    '<vndb-export version="1.0" uid="u1"><vns><vn id="v123"><title>Display</title><label label="Playing" private="1"/><notes>note</notes><started>2020-05-00</started></vn></vns></vndb-export>',
  )[0]!;
  expect(vndbMetadataProposals(vndbRow)).toMatchObject({
    note: { state: 'value', value: 'note' },
    privacy: { state: 'value', value: { status: 'known', meaning: 'private' } },
    priority: { state: 'unsupported' },
    sourceCreated: { state: 'unsupported' },
    sourceUpdated: { state: 'unsupported' },
  });

  const aniListRow = parseAniList(
    JSON.stringify([{ notes: 'note', private: true, priority: 3, createdAt: 1700000000 }]),
  ).rows[0]!;
  expect(anilistMetadataProposals(aniListRow)).toMatchObject({
    note: { state: 'value', value: 'note' },
    privacy: { state: 'value', value: { status: 'known', meaning: 'private' } },
    priority: { state: 'unsupported' },
    sourceCreated: { state: 'unknown', value: { status: 'unknown', sourceValue: '1700000000' } },
  });

  const malRows = parseMal(
    `<myanimelist>${[0, 1, 2]
      .map(
        (priority, index) =>
          `<anime><series_animedb_id>${index + 17}</series_animedb_id><series_title>Title</series_title><my_status>Completed</my_status><my_priority>${priority}</my_priority><my_privacy>1</my_privacy></anime>`,
      )
      .join('')}</myanimelist>`,
  );
  const proposals = malRows.map(malMetadataProposals);
  expect(proposals.map(({ priority }) => priority.value)).toEqual([100, 50, 1]);
  expect(proposals.map(({ priority }) => priority.mapping?.id)).toEqual(Array(3).fill('mal-priority-position-v1'));
  expect(proposals.map(({ privacy }) => privacy.state)).toEqual(Array(3).fill('unknown'));
});

for (const provider of ['mal', 'anilist'] as const) {
  test(`${provider} keeps persisted identities, native receipts and separate partial results through the coordinator`, async () => {
    const target = provider === 'mal' ? await f.createSubject('game') : anilistSubjectId;
    await f.commands.putEntry(f.owner.actor, target, { state: 'planned' }, entryKey());
    await body(
      await send('POST', `/v1/libraryEntries/${target}/sourceObservations`, {
        provider,
        recordId: provider === 'mal' ? 'anime/17' : '17',
        confirmReviewed: true,
        privacy: { status: 'known', meaning: 'public' },
        sourceCreated: { status: 'absent' },
        sourceUpdated: { status: 'absent' },
      }),
      201,
    );
    const root = `/v1/libraryImports/${provider}`;
    const payload =
      provider === 'mal'
        ? {
            xml: '<myanimelist><anime><series_animedb_id>17</series_animedb_id><series_title>Metadata</series_title><my_status>Plan to Watch</my_status><my_comments>Retained note</my_comments><my_priority>2</my_priority><my_privacy>private</my_privacy></anime></myanimelist>',
          }
        : {
            upload: JSON.stringify([
              {
                id: 17,
                mediaId: providerId,
                notes: 'Retained note',
                priority: 2,
                private: true,
                createdAt: '2020-01',
                updatedAt: '2021-02-03',
              },
            ]),
          };
    const createUpload = async () => (await body(await send('POST', `${root}:preview`, payload))).id as string;
    const id = await createUpload();
    const sourceKey = entryKey();
    const source = await body(
      await f.send(
        'owner',
        'POST',
        provider === 'mal' ? `${root}/${id}/review` : `${root}/${id}:review`,
        provider === 'mal' ? { row: 0, target, replace: false, skip: false } : { ordinal: 0, fields: ['status'] },
        sourceKey,
      ),
    );
    const sourceReviewToken = provider === 'mal' ? sourceKey : (source.review.id as string);
    const reviewKey = entryKey();
    const reviewPath = provider === 'mal' ? `${root}/${id}/metadata/review` : `${root}/${id}:reviewMetadata`;
    const reviewInput = provider === 'mal' ? { row: 0, sourceReviewToken } : { ordinal: 0, sourceReviewToken };
    const first = await body(await f.send('owner', 'POST', reviewPath, reviewInput, reviewKey));
    const readHistory = async (): Promise<EntryImportMetadataReview[]> => {
      if (provider === 'mal')
        return (
          await f.pool.query<{ history: EntryImportMetadataReview[] }>(
            `SELECT document->'metadataReviews'->'0' AS history FROM library.list_import_mal WHERE account_id=$1 AND id=$2`,
            [f.owner.actor.accountId, id],
          )
        ).rows[0]!.history;
      return (
        await f.pool.query<{ history: EntryImportMetadataReview[] }>(
          `SELECT payload->'metadataReviews' AS history FROM library.list_import_anilist WHERE account_id=$1 AND import_id=$2 AND ordinal=0`,
          [f.owner.actor.accountId, id],
        )
      ).rows[0]!.history;
    };
    const writeHistory = async (history: EntryImportMetadataReview[]) => {
      if (provider === 'mal')
        await f.pool.query(
          `UPDATE library.list_import_mal SET document=jsonb_set(document,'{metadataReviews,0}',$3::jsonb) WHERE account_id=$1 AND id=$2`,
          [f.owner.actor.accountId, id, JSON.stringify(history)],
        );
      else
        await f.pool.query(
          `UPDATE library.list_import_anilist SET payload=jsonb_set(payload,'{metadataReviews}',$3::jsonb) WHERE account_id=$1 AND import_id=$2 AND ordinal=0`,
          [f.owner.actor.accountId, id, JSON.stringify(history)],
        );
    };
    const history = await readHistory();
    expect(history[0]!.requestDigest).toBe(entryImportMetadataDigest({ sourceReviewToken, key: reviewKey }));
    // This is the pre-extraction on-disk shape: no nativeAdmission marker and original digest/token.
    const token = entryKey();
    history[0]!.token = token;
    await writeHistory(history);
    const retried = await body(await f.send('owner', 'POST', reviewPath, reviewInput, reviewKey));
    expect(retried.reviewToken).toBe(token);
    expect(retried.reviewToken).not.toBe(first.reviewToken);
    const fields = [
      { field: 'note', action: 'adopt' },
      { field: 'priority', action: 'adopt', mapping: 'mal-priority-position-v1' },
      { field: 'privacy', action: 'adopt' },
      { field: 'sourceCreated', action: 'adopt' },
      { field: 'sourceUpdated', action: 'adopt' },
    ];
    const selectionDigest = entryImportMetadataDigest(fields);
    history[0]!.confirmation = {
      fields: fields as NonNullable<EntryImportMetadataReview['confirmation']>['fields'],
      selectionDigest,
      annotationKey: `retained-${provider}-annotation-${id}`,
      provenanceKey: `retained-${provider}-provenance-${id}`,
      annotationStarted: false,
      provenanceStarted: false,
    };
    await writeHistory(history);
    // Lose the acknowledgement after the real annotation transaction commits, before a checkpoint exists.
    let loseResponse = true;
    const faultPool = Object.create(f.pool) as typeof f.pool;
    faultPool.query = f.pool.query.bind(f.pool);
    faultPool.connect = (async () => {
      const client = await f.pool.connect();
      let annotation = false;
      return new Proxy(client, {
        get(current, key) {
          if (key !== 'query') {
            const value = Reflect.get(current, key);
            return typeof value === 'function' ? value.bind(current) : value;
          }
          return async (...args: unknown[]) => {
            const query = args[0] as string | { text: string },
              text = typeof query === 'string' ? query : query.text;
            if (text.includes('UPDATE library.entry_personal_fact')) annotation = true;
            const result = await Reflect.apply(current.query, current, args);
            if (annotation && text === 'COMMIT' && loseResponse) {
              loseResponse = false;
              throw new Error('Lost native annotation response');
            }
            return result;
          };
        },
      });
    }) as typeof faultPool.connect;
    const deps = { pool: faultPool, access: f.access, tokens: f.tokens, routeKey: testRouteKey() };
    const engine =
      provider === 'mal'
        ? createMalImport({ ...deps, journal: createSessionCommands(deps) })
        : createAniListImport(deps);
    const partial =
      provider === 'mal'
        ? await (engine as ReturnType<typeof createMalImport>).applyMetadata(
            f.owner.actor,
            id,
            0,
            token,
            fields,
            Date.now() + 30_000,
          )
        : await (engine as ReturnType<typeof createAniListImport>).applyMetadata(f.owner.actor, id, 0, token, fields);
    expect(loseResponse).toBe(false);
    expect(partial.fields.find((field) => field.field === 'note')?.status).toBe('failed');
    const nativeFacts = async () =>
      (await body(await send('GET', `/v1/libraryEntries/${target}/personal`))).personalEntry;
    const admitted = await nativeFacts();
    expect(admitted.note).toBe('Retained note');
    const pending = (await readHistory())[0]!.confirmation!;
    expect(pending.annotationStarted).toBe(true);
    expect(pending.annotationKey).toBe(history[0]!.confirmation!.annotationKey);
    expect(pending.annotationInput?.note).toEqual({ op: 'set', value: 'Retained note' });
    expect(pending.outcome).toBeUndefined();
    const applyPath = provider === 'mal' ? `${root}/${id}/metadata/apply` : `${root}/${id}:applyMetadata`;
    const applyInput = { ...(provider === 'mal' ? { row: 0 } : { ordinal: 0 }), reviewToken: token, fields };
    expect(
      (await send('POST', applyPath, { ...applyInput, fields: [{ field: 'note', action: 'clear' }] })).status,
    ).toBe(409);
    expect((await send('POST', reviewPath, reviewInput)).status).toBe(409);
    expect((await send('POST', applyPath, { ...applyInput, reviewToken: first.reviewToken })).status).toBe(200);
    const complete = await body(await send('POST', applyPath, applyInput));
    expect(complete.fields.find((field: { field: string }) => field.field === 'note').status).toBe('applied');
    expect(complete.fields.find((field: { field: string }) => field.field === 'priority').status).toBe(
      provider === 'mal' ? 'applied' : 'unsupported',
    );
    const saved = await nativeFacts();
    expect(saved.annotationRevision).toBe(admitted.annotationRevision);
    expect(saved.priority).toBe(provider === 'mal' ? 1 : null);
    if (provider === 'anilist')
      expect(saved.sourceObservations).toMatchObject([
        { provider, recordId: '17', privacy: { status: 'known', meaning: 'private' } },
      ]);
    else
      expect(complete.fields.find((field: { field: string }) => field.field === 'sourceCreated').status).toBe(
        'unsupported',
      );
    const final = (await readHistory())[0]!.confirmation!;
    expect(final.annotationKey).toBe(pending.annotationKey);
    expect(final.annotationInput).toEqual(pending.annotationInput);
    expect(final.outcome).toEqual(complete);
    expect(await body(await send('POST', applyPath, applyInput))).toEqual(complete);
    expect(await nativeFacts()).toEqual(saved);
    const viewPath = `${root}/${id}/metadata/0?reviewToken=${token}`;
    expect((await send('GET', viewPath, undefined, 'other')).status).toBe(404);
    const second = await body(await send('POST', reviewPath, reviewInput));
    expect(second.reviewToken).not.toBe(token);
    expect((await send('POST', reviewPath, reviewInput)).status).toBe(409);
    const clearFields = [
      { field: 'note', action: 'clear' },
      { field: 'privacy', action: 'clear' },
    ];
    let signalReads = 0;
    const signal = Object.defineProperty({}, 'aborted', { get: () => ++signalReads > 1 }) as AbortSignal;
    const interrupted =
      provider === 'mal'
        ? await (engine as ReturnType<typeof createMalImport>).applyMetadata(
            f.owner.actor,
            id,
            0,
            second.reviewToken,
            clearFields,
            Date.now() + 30_000,
            signal,
          )
        : await (engine as ReturnType<typeof createAniListImport>).applyMetadata(
            f.owner.actor,
            id,
            0,
            second.reviewToken,
            clearFields,
            signal,
          );
    expect(interrupted.fields).toEqual([
      { field: 'note', status: 'applied' },
      { field: 'privacy', status: 'unattempted' },
    ]);
    expect((await readHistory())[1]!.confirmation?.outcome).toBeUndefined();
    const stoppedFacts = await nativeFacts();
    expect(stoppedFacts.note).toBeNull();
    expect(stoppedFacts.sourceObservations[0].privacy).toEqual({ status: 'known', meaning: 'private' });
    const otherUpload = await createUpload();
    const otherApply =
      provider === 'mal' ? `${root}/${otherUpload}/metadata/apply` : `${root}/${otherUpload}:applyMetadata`;
    expect(
      (await body(await send('POST', otherApply, applyInput))).fields.every(
        (item: { status: string }) => item.status === 'stale',
      ),
    ).toBe(true);
    await body(await send('POST', provider === 'mal' ? `${root}/${id}/cancel` : `${root}/${id}:cancel`, {}));
    expect(
      await body(
        await send('POST', applyPath, { ...applyInput, reviewToken: second.reviewToken, fields: clearFields }),
      ),
    ).toEqual(interrupted);
    expect((await readHistory())[1]!.confirmation?.outcome).toEqual(interrupted);
    expect(await body(await send('POST', applyPath, applyInput))).toEqual(complete);
    await body(
      await send(
        provider === 'mal' ? 'DELETE' : 'POST',
        provider === 'mal' ? `${root}/${id}` : `${root}/${id}:cancel`,
        provider === 'mal' ? undefined : { remove: true },
      ),
    );
    expect((await send('GET', viewPath)).status).toBe(404);
    expect(await nativeFacts()).toEqual(stoppedFacts);
    await body(
      await send(
        provider === 'mal' ? 'DELETE' : 'POST',
        provider === 'mal' ? `${root}/${otherUpload}` : `${root}/${otherUpload}:cancel`,
        provider === 'mal' ? undefined : { remove: true },
      ),
    );
  }, 120_000);
}
