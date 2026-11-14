import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';
import readChain from '../../src/content/read-chain.sql';
import { readHostedLanguageNamespaceBinding } from '../../src/content/hosted-chapter-language-namespace.ts';
import { advanceHostedPublicationStagingCleanup } from '../../src/content/hosted-publication-staging-cleanup.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../support/account-deletion.ts';
import { eraseAccountAuthoredItem } from '../../src/content/account-erasure-authored.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';

setDefaultTimeout(240_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

async function cleanupStage(catalogueId: string, stageId: string) {
  for (let page = 0; page < 32; page++) {
    const client = await f.native.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await advanceHostedPublicationStagingCleanup(
        client,
        f.native.author.actor,
        { catalogueId, stageId },
        f.newOccurrenceIdFor(catalogueId),
      );
      await client.query('COMMIT');
      expect(result.deletedRows).toBeLessThanOrEqual(100);
      if (result.progress.completed) return;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error('The bounded language staging fixture did not finish cleanup');
}

test('chapter languages freeze authored bodies, select preferred keys, preserve old exact links and obey source revocation', async () => {
  const book = await f.native.thread('published');
  const english = await f.native.thread('published', fromPlainText('The original English chapter.'));
  const chinese = await f.native.thread('draft', fromPlainText('中文章节正文。'));
  const target = f.target(english);
  const alternative = f.target(chinese);
  const catalogueId = book.firstPost.id;
  const path = `/v1/hostedCatalogues/${catalogueId}`;
  const occurrenceId = f.newOccurrenceIdFor(catalogueId);
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId: book.id,
    placements: [{ occurrenceId, parentId: null, position: 0, title: 'English chapter', kind: 'chapter', target }],
  });
  expect(
    (await f.native.call('POST', `${path}:convertDraft`, { step: 'capture', expectedRevisionId: created.revisionId }))
      .status,
  ).toBe(404);
  expect((await f.native.call('POST', `${path}:advanceLegacyPublicBaseline`, {})).status).toBe(404);
  const bindPath = `${path}/occurrences/${occurrenceId}:bindLanguage`;
  const defaultLanguage = await f.native.command(
    bindPath,
    {
      expectedRevisionId: created.revisionId,
      language: 'en',
      title: 'English chapter',
      target,
      makeDefault: true,
    },
    200,
  );
  const input = {
    expectedRevisionId: defaultLanguage.revisionId,
    language: 'zh-Hans',
    title: '中文章节',
    target: alternative,
  };
  const key = crypto.randomUUID();
  const bound = await f.native.call('POST', bindPath, input, { key });
  expect(bound.status, JSON.stringify(bound.value)).toBe(200);
  expect((await f.native.call('POST', bindPath, input, { key })).value).toEqual(bound.value);
  expect((await f.native.call('POST', bindPath, input, { other: true })).status).toBe(403);
  expect((await f.native.call('POST', bindPath, { ...input, language: 'zh-hans' })).status).toBe(400);
  const consent = await f.native.command(
    `/v1/posts/${alternative.postId}:issueRevisionDisclosure`,
    { catalogueId, target: alternative },
    200,
  );
  const publication = await f.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: bound.value.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [occurrenceId],
    },
    200,
  );
  const base = `${path}/occurrences/${occurrenceId}`;
  const publicationQuery = `kind=publication&revisionId=${publication.revisionId}`;
  const read = (suffix: string) => f.native.call('GET', `${base}${suffix}`, undefined, { anonymous: true });
  expect((await f.native.call('GET', `/v1/posts/${alternative.postId}`, undefined, { anonymous: true })).status).toBe(
    404,
  );
  for (const invalid of [
    `targetRevisionId=${alternative.revisionId}`,
    'language=zh-hans',
    'preferredLanguages=en,en',
    'preferredLanguages=en,%20zh-Hans',
  ])
    expect((await read(`/body?${publicationQuery}&${invalid}`)).status).toBe(400);
  const observer = observeSql(f.native.pool);
  let languages: Awaited<ReturnType<typeof read>>;
  try {
    languages = await read(`/languages?${publicationQuery}`);
    const metadataOnly = await read(`/metadata?${publicationQuery}&preferredLanguages=zh-Hans`);
    expect(metadataOnly.value.occurrence.target).toEqual(alternative);
    expect(
      observer.records.filter(
        (row) => row.statement === readChain.sql && row.parameters[readChain.params.indexOf('include_body')] === true,
      ),
    ).toHaveLength(0);
  } finally {
    await observer.close();
  }
  expect(languages.status, JSON.stringify(languages.value)).toBe(200);
  expect(languages.value.items).toEqual([
    { language: 'en', title: 'English chapter', target, isDefault: true },
    { language: 'zh-Hans', title: '中文章节', target: alternative, isDefault: false },
  ]);
  const selected = await read(`/body?${publicationQuery}&preferredLanguages=fr,zh-Hans,en`);
  expect(selected.value.selectedLanguage).toBe('zh-Hans');
  expect(selected.value.occurrence.target).toEqual(alternative);
  expect(selected.value.document.sha256).toBe(alternative.sha256);
  expect(selected.value.document).toMatchObject({ authorId: f.native.author.actor.accountId, licence: 'MIT' });
  expect((await read(`/body?${publicationQuery}&language=fr`)).value.selectedLanguage).toBe('en');
  const exact = `${publicationQuery}&language=zh-Hans&targetPostId=${alternative.postId}&targetRevisionId=${alternative.revisionId}&targetSha256=${alternative.sha256}`;
  const original = await read(`/body?${exact}`);
  const metadata = await read(`/metadata?${exact}`);
  expect(metadata.value.occurrence).toEqual(original.value.occurrence);
  expect(metadata.value).not.toHaveProperty('document');
  const future = await f.native.revise(chinese.firstPost, { body: fromPlainText('A later private Chinese revision.') });
  const newTarget = { ...alternative, revisionId: future.value.post.revisionId, sha256: future.value.post.sha256 };
  const futureBinding = await f.native.command(
    bindPath,
    { ...input, expectedRevisionId: bound.value.revisionId, target: newTarget },
    200,
  );
  const partId = f.newOccurrenceIdFor(catalogueId);
  const moved = await f.native.command(
    `${path}:revise`,
    {
      expectedRevisionId: futureBinding.revisionId,
      placements: [
        { occurrenceId: partId, parentId: null, position: 0, title: 'A private new part', kind: 'part' },
        { occurrenceId, parentId: partId, position: 0, title: 'Moved English chapter', kind: 'chapter', target },
      ],
    },
    200,
  );
  expect(
    (await f.native.call('GET', `${base}/metadata?kind=structure&language=zh-Hans`)).value.occurrence.target,
  ).toEqual(newTarget);
  const preparedHead = moved.revisionId;
  const preparedChoice = await f.native.call('GET', `${base}/metadata?kind=structure&language=zh-Hans`);
  expect(preparedChoice.value.occurrence.target).toEqual(newTarget);
  await f.native.command(
    bindPath,
    { ...input, expectedRevisionId: preparedHead, target: newTarget, title: 'Another private title' },
    200,
  );
  expect((await read(`/body?${exact}`)).value.document).toEqual(original.value.document);
  expect((await read(`/body?${exact}&preferredLanguages=en`)).value.document).toEqual(original.value.document);
  expect(
    (
      await read(
        `/body?${publicationQuery}&language=zh-Hans&targetPostId=${target.postId}&targetRevisionId=${target.revisionId}&targetSha256=${target.sha256}`,
      )
    ).value.document,
  ).toBeNull();
  const children = await f.native.call(
    'GET',
    `${path}/children?${publicationQuery}&preferredLanguages=zh-Hans,en`,
    undefined,
    { anonymous: true },
  );
  expect(children.value.items[0].selectedLanguage).toBe('zh-Hans');
  expect(children.value.items[0].target).toEqual(alternative);
  await f.native.command(
    `/v1/posts/${alternative.postId}:revokeRevisionDisclosure`,
    { disclosureId: consent.disclosureId },
    200,
  );
  expect(
    (await read(`/languages?${publicationQuery}`)).value.items.map((item: { language: string }) => item.language),
  ).toEqual(['en']);
  expect((await read(`/body?${exact}`)).value.document).toBeNull();
  expect((await read(`/body?${publicationQuery}&language=zh-Hans`)).value.selectedLanguage).toBe('en');
});

test('prepared release ingests more than one page of language alternatives and activates one complete selection', async () => {
  const book = await f.native.thread('published');
  const source = await f.native.thread('published', fromPlainText('A separately authored language body.'));
  const catalogueId = book.firstPost.id;
  const path = `/v1/hostedCatalogues/${catalogueId}`;
  const occurrenceId = f.newOccurrenceIdFor(catalogueId);
  const target = f.target(source);
  const partId = f.newOccurrenceIdFor(catalogueId);
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId: book.id,
    placements: [
      { occurrenceId: partId, parentId: null, position: 0, title: 'Part', kind: 'part' },
      { occurrenceId, parentId: partId, position: 0, title: 'Chapter', kind: 'chapter', target },
    ],
  });
  let head = created.revisionId;
  const languageKeys = Array.from({ length: 25 }, (_, index) => `en-x-l${index}`);
  for (const language of languageKeys) {
    const bound = await f.native.command(
      `${path}/occurrences/${occurrenceId}:bindLanguage`,
      {
        expectedRevisionId: head,
        language,
        title: `Authored ${language}`,
        target,
      },
      200,
    );
    head = bound.revisionId;
  }
  const abortedStageId = f.newOccurrenceIdFor(catalogueId);
  const abortedStage = `${path}/publicationPreparations/${abortedStageId}`;
  await f.native.command(
    `${path}:prepareRelease`,
    {
      stageId: abortedStageId,
      expectedRevisionId: head,
      expectedPublicationId: null,
      mode: 'whole',
    },
    202,
  );
  for (let page = 0; page < 2; page++)
    await f.native.command(`${abortedStage}:advance`, { stepId: f.newOccurrenceIdFor(catalogueId) }, 200);
  expect(
    (
      await f.native.pool.query(
        `SELECT 1 FROM content.hosted_chapter_language_namespace
    WHERE route=$1 AND catalogue_id=$2 AND namespace_id=$3`,
        [routeOf(catalogueId), catalogueId, abortedStageId],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    await readHostedLanguageNamespaceBinding(
      f.native.pool,
      catalogueId,
      abortedStageId,
      occurrenceId,
      languageKeys[0]!,
    ),
  ).toBeNull();
  expect((await f.native.call('GET', `${path}`, undefined, { anonymous: true })).status).toBe(404);
  await f.native.command(`${abortedStage}:cancel`, {}, 200);
  await cleanupStage(catalogueId, abortedStageId);
  expect(
    (
      await f.native.pool.query(
        `SELECT 1 FROM content.hosted_chapter_language_namespace
    WHERE route=$1 AND catalogue_id=$2 AND namespace_id=$3`,
        [routeOf(catalogueId), catalogueId, abortedStageId],
      )
    ).rowCount,
  ).toBe(0);
  const stageId = f.newOccurrenceIdFor(catalogueId);
  let result = await f.native.call('POST', `${path}:prepareRelease`, {
    stageId,
    expectedRevisionId: head,
    expectedPublicationId: null,
    mode: 'whole',
  });
  expect(result.status, JSON.stringify(result.value)).toBe(202);
  const stage = `${path}/publicationPreparations/${stageId}`;
  let steps = 0;
  while (!result.value.candidate?.coverageComplete) {
    expect(++steps).toBeLessThan(24);
    result = await f.native.call('POST', `${stage}:advance`, { stepId: f.newOccurrenceIdFor(catalogueId) });
    expect(result.status, JSON.stringify(result.value)).toBe(200);
    expect((await f.native.call('GET', `${path}`, undefined, { anonymous: true })).status).toBe(404);
  }
  expect(steps).toBeGreaterThanOrEqual(4);
  expect((await f.native.call('POST', `${stage}:seal`, {})).status).toBe(200);
  result = await f.native.call('POST', `${stage}:startActivation`, {});
  expect(result.status, JSON.stringify(result.value)).toBe(200);
  for (let step = 0; result.value.state !== 'ready'; step++) {
    expect(step).toBeLessThan(8);
    result = await f.native.call('POST', `${stage}:advanceActivation`, {});
    expect(result.status, JSON.stringify(result.value)).toBe(200);
  }
  const activated = await f.native.call('POST', `${stage}:activate`, {});
  expect(activated.status, JSON.stringify(activated.value)).toBe(200);
  const query = `kind=publication&revisionId=${activated.value.publicationId}`;
  const base = `${path}/occurrences/${occurrenceId}`;
  const first = await f.native.call('GET', `${base}/languages?${query}&limit=20`, undefined, { anonymous: true });
  expect(first.status, JSON.stringify(first.value)).toBe(200);
  expect(first.value.items).toHaveLength(20);
  expect(first.value.nextCursor).toEqual(expect.any(String));
  const next = await f.native.call(
    'GET',
    `${base}/languages?${query}&limit=20&cursor=${encodeURIComponent(first.value.nextCursor)}`,
    undefined,
    { anonymous: true },
  );
  expect(next.value.items).toHaveLength(5);
  expect(next.value.nextCursor).toBeNull();
  expect([...first.value.items, ...next.value.items].map((item: { language: string }) => item.language)).toEqual(
    languageKeys,
  );
  const exact = await f.native.call(
    'GET',
    `${base}/body?${query}&language=${languageKeys[24]}&targetPostId=${target.postId}&targetRevisionId=${target.revisionId}&targetSha256=${target.sha256}`,
    undefined,
    { anonymous: true },
  );
  expect(exact.value.selectedLanguage).toBe(languageKeys[24]);
  expect(exact.value.document.sha256).toBe(target.sha256);
  await f.native.command(`${stage}:cancel`, {}, 200);
  await cleanupStage(catalogueId, stageId);
  const afterCleanup = await f.native.call(
    'GET',
    `${base}/body?${query}&language=${languageKeys[24]}&targetPostId=${target.postId}&targetRevisionId=${target.revisionId}&targetSha256=${target.sha256}`,
    undefined,
    { anonymous: true },
  );
  expect(afterCleanup.value.document).toEqual(exact.value.document);
  expect(
    (await readHostedLanguageNamespaceBinding(f.native.pool, catalogueId, stageId, occurrenceId, languageKeys[24]!))
      ?.title,
  ).toBe(`Authored ${languageKeys[24]}`);
});

test('native account cleanup redacts private language facts without changing a published namespace snapshot', async () => {
  const owner = await hostedChaptersFixture();
  try {
    const book = await owner.native.thread('published');
    const source = await owner.native.thread('published', fromPlainText('An eligible public chapter.'));
    const later = await owner.native.thread('draft', fromPlainText('A never-selected private draft.'));
    const catalogueId = book.firstPost.id;
    const path = `/v1/hostedCatalogues/${catalogueId}`;
    const occurrenceId = owner.newOccurrenceIdFor(catalogueId);
    const target = owner.target(source);
    const created = await owner.native.command('/v1/hostedCatalogues', {
      postId: catalogueId,
      threadId: book.id,
      placements: [],
    });
    const inserted = await owner.native.command(
      `${path}:insertDraftPoint`,
      {
        expectedRevisionId: created.revisionId,
        occurrenceId,
        parentId: null,
        beforeOccurrenceId: null,
        title: 'Public chapter',
        placement: { kind: 'chapter', target },
      },
      200,
    );
    const bound = await owner.native.command(
      `${path}/occurrences/${occurrenceId}:bindLanguage`,
      {
        expectedRevisionId: inserted.revisionId,
        language: 'fr',
        title: 'Selected public title',
        target,
      },
      200,
    );
    const publication = await owner.native.command(
      `${path}:publish`,
      {
        expectedRevisionId: bound.revisionId,
        expectedPublicationId: null,
        occurrenceIds: [occurrenceId],
      },
      200,
    );
    const snapshot = await readHostedLanguageNamespaceBinding(
      owner.native.pool,
      catalogueId,
      publication.revisionId,
      occurrenceId,
      'fr',
    );
    expect(snapshot?.title).toBe('Selected public title');
    await owner.native.command(
      `${path}/occurrences/${occurrenceId}:bindLanguage`,
      {
        expectedRevisionId: bound.revisionId,
        language: 'fr',
        title: 'Never-public title',
        target: owner.target(later),
      },
      200,
    );
    const authorId = owner.native.author.actor.accountId;
    const deletion = accountDeletionRuntime(owner.native.system);
    await deletePersona(
      { version: 1, pool: owner.native.pool, auth: deletion.auth },
      { accountId: authorId, bearer: owner.native.author.bearer },
    );
    await drainEffects(owner.native.pool, partitionOf(routeOf(authorId)!));
    await eraseAccountAuthoredItem({ pool: owner.native.pool }, authorId, 'post', catalogueId);
    await eraseAccountAuthoredItem({ pool: owner.native.pool }, authorId, 'post', catalogueId);
    const drafts = await owner.native.pool.query<{ title: string | null; title_redacted: boolean; target: unknown }>(
      `SELECT title,title_redacted,target FROM content.hosted_chapter_language_binding WHERE route=$1 AND catalogue_id=$2`,
      [routeOf(catalogueId), catalogueId],
    );
    expect(drafts.rows).toHaveLength(2);
    expect(drafts.rows.every((row) => row.title === null && row.title_redacted && row.target !== null)).toBe(true);
    expect(
      await readHostedLanguageNamespaceBinding(
        owner.native.pool,
        catalogueId,
        publication.revisionId,
        occurrenceId,
        'fr',
      ),
    ).toEqual(snapshot);
  } finally {
    await owner.close();
  }
});
