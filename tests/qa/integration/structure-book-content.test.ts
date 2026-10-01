import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

const revisionRef = (id: string) => `urn:rezics:content:revision:${id}`;

test('BOOK01/BOOK03/BOOK08: native Book follows published Post while a fixed release retains its revision', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `structure-book-content-${randomUUID()}`));
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  const content = new ContentCore(f.pool);
  const app = createMainApp(f.env.fuseki, { environment: f.env, catalogueIntake: f.catalogueIntake, structureObjects: objects,
    account: f.account.verifier, access: f.access, content, contentAuthoring: content });
  const call = (method: string, path: string, body?: object, key = randomUUID(),
    token = f.account.tokenA) => app.handle(new Request(`http://main.local${path}`,
      { method, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
  const json = async <T>(response: Response, status: number): Promise<T> => {
    if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  try {
    const book = await json<{ work: string; mainVersion: string }>(await call('POST', '/v1/works',
      await f.catalogueBody({ profile: 'metadata-only-v1', language: 'en', title: 'Native Book publication journey',
        semanticTypes: ['https://schema.org/Book'], actingSubject: f.actor })), 201);
    const post = await json<{ work: string }>(await call('POST', '/v1/works',
      await f.catalogueBody({ profile: 'metadata-only-v1', language: 'en', title: 'Native Post chapter',
        semanticTypes: ['https://schema.org/DigitalDocument'], actingSubject: f.actor })), 201);
    await f.grant(`work:edit:${book.work}`, 'work.edit');
    await f.grant(`work:read:${book.work}`, 'work.read');
    await f.grant(`work:read:${post.work}`, 'work.read');
    await f.grant(`content:draft:${post.work}`, 'content.draft');
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    await f.grant(`content:publish:${post.work}`, 'content.publish');
    await f.grant(`content:search-eligibility:${post.work}`, 'content.search-eligibility');
    const save = async (body: string, expectedHead: string | null) => json<{
      revisionId: string; sourcePosition: { dataEpoch: string } }>(await call('POST',
      '/v1/content-drafts', { profile: 'content-text-v1', resourceId: post.work, variantId,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
        expectedHead, body, actingSubject: f.actor }), 201);
    const publish = async (saved: Awaited<ReturnType<typeof save>>, head: string | null) => {
      const exact = (await content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
      if (exact?.status !== 'available') throw new Error('Content revision unavailable');
      return json<{ status: string; decision: string }>(await call('POST', '/v1/content-publications',
        { profile: 'content-publication-v1', preparationId: `book-${randomUUID()}`,
          revisionId: saved.revisionId, expectedDigest: exact.reference.byteDigest,
          expectedContentEpoch: saved.sourcePosition.dataEpoch, resourceId: post.work, variantId,
          expectedPublicationHead: head, actingSubject: f.actor }), 201);
    };
    const eligible = async (decision: string, head: string | null) => json<{ decision: string }>(
      await call('POST', '/v1/content-search-eligibility', {
        profile: 'content-search-eligibility-v1', resourceId: post.work, variantId,
        publicationDecision: decision, expectedEligibilityHead: head, actingSubject: f.actor,
        rightsBasis: 'original-contribution', disclosure: 'public' }), 201);
    const firstContent = await save('# Chapter One\nFirst published Post body', null);
    const firstPublication = await publish(firstContent, null);
    expect(firstPublication.status).toBe('active');
    const firstEligibility = await eligible(firstPublication.decision, null);
    const created = await json<{ structure: string; revision: string }>(await call('POST',
      '/v1/compositions', { profile: 'book-composition', work: book.work,
        mainVersion: book.mainVersion, actingSubject: f.actor }), 201);
    const path = `/v1/compositions/${shortId(created.structure)}`;
    const privatePost = await json<{ work: string }>(await call('POST', '/v1/works',
      await f.catalogueBody({ profile: 'metadata-only-v1', language: 'en', title: 'Undisclosed Post',
        semanticTypes: ['https://schema.org/DigitalDocument'], actingSubject: f.actor })), 201);
    const insert = (expectedHead: string, target: string, selection?: object) => ({
      profile: 'book-composition', expectedHead, actingSubject: f.actor,
      operations: [{ op: 'insert', parent: created.structure, position: 'last',
        role: 'chapter', target, ...(selection ? { selection } : {}) }],
    });
    expect((await call('POST', `${path}/changes`, insert(created.revision, privatePost.work))).status)
      .toBe(404);
    const follow = await json<{ revision: string; occurrences: string[] }>(await call('POST',
      `${path}/changes`, insert(created.revision, post.work)), 200);
    const fixed = await json<{ revision: string; occurrences: string[] }>(await call('POST',
      `${path}/changes`, insert(follow.revision, post.work,
        { mode: 'fixed-revision', revision: revisionRef(firstContent.revisionId) })), 200);
    const contents = await json<{ items: Array<{ label: { value: string } | null }> }>(await call('GET',
      `/v1/works/${shortId(book.work)}/contents?language=en&actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(contents.items.map(item => item.label?.value)).toEqual(['Chapter One', 'Chapter One']);
    const chapter = await json<{ label: { value: string } | null }>(await call('GET',
      `/v1/chapters/${shortId(follow.occurrences[0]!)}`
        + `?language=en&actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(chapter.label?.value).toBe('Chapter One');
    const readPath = `${path}?actingSubject=${encodeURIComponent(f.actor)}`;
    const chapterPage = await json<{ occurrences: Array<{ target: string;
      selection: { mode: string; revision?: string } }> }>(await call('GET', readPath), 200);
    expect(chapterPage.occurrences.map(row => row.target)).toEqual([post.work, post.work]);
    expect(chapterPage.occurrences.map(row => row.selection.mode)).toEqual([
      'follow-context', 'fixed-revision']);
    const seal = async () => json<{ seal: string }>(await call('POST', `${path}/seals`,
      { expectedHead: fixed.revision, actingSubject: f.actor }), 200);
    const readSeal = async (sealId: string) => json<{ coverage: string; pins: Array<{
      occurrence: string; target: string; variant?: string; revision: string }> }>(await call('GET',
      `${path}/seals/${shortId(sealId)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    const firstSeal = await seal();
    const before = await readSeal(firstSeal.seal);
    expect(before.coverage).toBe('complete');
    expect(before.pins.map(pin => pin.revision)).toEqual([
      revisionRef(firstContent.revisionId), revisionRef(firstContent.revisionId)]);
    const secondContent = await save('Revised published Post body', firstContent.revisionId);
    const secondPublication = await publish(secondContent, firstPublication.decision);
    await eligible(secondPublication.decision, firstEligibility.decision);
    const secondSeal = await seal();
    const after = await readSeal(secondSeal.seal);
    expect(after.pins.find(pin => pin.occurrence === follow.occurrences[0])?.revision)
      .toBe(revisionRef(secondContent.revisionId));
    expect(after.pins.find(pin => pin.occurrence === fixed.occurrences[0])?.revision)
      .toBe(revisionRef(firstContent.revisionId));
    expect((await readSeal(firstSeal.seal)).pins.map(pin => pin.revision))
      .toEqual(before.pins.map(pin => pin.revision));
    const removed = await json<{ revision: string }>(await call('POST', `${path}/changes`, {
      profile: 'book-composition', expectedHead: fixed.revision, actingSubject: f.actor,
      operations: [{ op: 'remove', occurrence: follow.occurrences[0] }] }), 200);
    const restored = await json<{ revision: string }>(await call('POST', `${path}/restorations`, {
      expectedHead: removed.revision, restoredFrom: fixed.revision, actingSubject: f.actor }), 200);
    expect(restored.revision).not.toBe(fixed.revision);
    expect((await json<{ occurrences: unknown[] }>(await call('GET', readPath), 200)).occurrences)
      .toHaveLength(2);
    const latest = await readSeal((await json<{ seal: string }>(await call('POST', `${path}/seals`,
      { expectedHead: restored.revision, actingSubject: f.actor }), 200)).seal);
    expect(latest.pins.find(pin => pin.occurrence === follow.occurrences[0])?.revision)
      .toBe(revisionRef(secondContent.revisionId));
  } finally { await f.close(); }
}, 180_000);
