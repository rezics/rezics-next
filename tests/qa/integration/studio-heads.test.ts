import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Elysia } from 'elysia';
import { StudioAccess } from '../../../services/main/src/modules/studio/access.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';
import { hash } from '../../../services/main/src/modules/work/activate.ts';
import { studioRoutes } from '../../../services/main/src/routes/studio.ts';
import { contentRoutes } from '../../../services/main/src/routes/content.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

test('STUDIO draft heads and Work title language survive edits and stale retries', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `studio-heads-${randomUUID()}`));
  try {
    const created = await f.json<{ work: string; mainVersion: string; workRevision: string }>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: '日本語の作品', language: 'ja',
      semanticTypes: ['https://schema.org/Book'],
      localizedTitle: { value: 'A Japanese work', language: 'en' },
      description: { value: '作品の説明', language: 'ja' }, actingSubject: f.actor,
    }), 201);
    await f.grant(`work:read:${created.work}`, 'work.read');
    const studio = new Elysia().use(studioRoutes({ environment: f.env,
      account: f.account.verifier, access: f.access, studioAccess: new StudioAccess(f.accessPool) }));
    const studioPath = `/v1/me/agents/${shortId(f.actor)}/works`;
    const studioCall = (token = f.account.tokenA) => studio.handle(new Request(`http://main.local${studioPath}`,
      { headers: { authorization: `Bearer ${token}` } }));
    expect((await studioCall()).status).toBe(403);
    await f.accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'agent.control','infinity'::timestamptz)`, [randomUUID(), f.principalId, f.actor]);
    expect((await studioCall(f.account.tokenB)).status).toBe(403);
    const listed = await f.json<{ items: Array<{ id: string; state: string; texts: unknown[] }> }>(
      await studioCall(), 200);
    expect(listed.items).toContainEqual(expect.objectContaining({ id: created.work,
      state: 'empty', texts: [] }));
    const exact = await f.json<{ title: string; language: string }>(await f.call('GET',
      `/v1/revisions/${shortId(created.workRevision)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(exact).toMatchObject({ title: '日本語の作品', language: 'ja',
      localizedTitle: { value: 'A Japanese work', language: 'en' },
      description: { value: '作品の説明', language: 'ja' } });

    await f.grant(`contribution:create:${created.work}`, 'contribution.create');
    const contribution = await f.json<{ contribution: string; draftRevision: string }>(await f.call('POST',
      '/v1/contributions', { profile: 'text-contribution-v1', work: created.work,
        language: 'ja', body: '最初の本文', actingSubject: f.actor }), 201);
    await f.grant(`contribution:read:${contribution.contribution}`, 'contribution.read');
    await f.grant(`contribution:edit:${contribution.contribution}`, 'contribution.edit');
    const headPath = `/v1/contributions/${shortId(contribution.contribution)}?actingSubject=${encodeURIComponent(f.actor)}`;
    expect((await f.call('GET', headPath, undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
    const first = await f.json<{ work: string; language: string; author: string;
      draftHead: string; publicationHead: string | null }>(await f.call('GET', headPath), 200);
    expect(first).toMatchObject({ work: created.work, language: 'ja', author: f.actor,
      draftHead: contribution.draftRevision, publicationHead: null });

    const edited = await f.json<{ draftRevision: string }>(await f.call('POST', '/v1/contribution-edits', {
      profile: 'text-contribution-v1', contribution: contribution.contribution,
      expectedHead: contribution.draftRevision, body: '二番目の本文', actingSubject: f.actor,
    }), 200);
    expect(edited.draftRevision).not.toBe(first.draftHead);
    const stale = await f.call('POST', '/v1/contribution-edits', {
      profile: 'text-contribution-v1', contribution: contribution.contribution,
      expectedHead: contribution.draftRevision, body: '古い本文', actingSubject: f.actor,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'stale_head', currentHead: edited.draftRevision });
    expect(await f.json<{ draftHead: string }>(await f.call('GET', headPath), 200))
      .toMatchObject({ draftHead: edited.draftRevision });

    const content = new ContentCore(f.pool);
    const contentApp = new Elysia().use(contentRoutes(f.env.fuseki, {
      environment: f.env, account: f.account.verifier, access: f.access,
      contentAuthoring: content,
    })).use(studioRoutes({ environment: f.env, account: f.account.verifier,
      access: f.access, contentAuthoring: content, studioAccess: new StudioAccess(f.accessPool) }));
    const contentCall = (method: string, path: string, body?: object) => contentApp.handle(new Request(
      `http://main.local${path}`, { method, headers: { authorization: `Bearer ${f.account.tokenA}`,
        'idempotency-key': randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const variantsPath = `/v1/works/${shortId(created.work)}/content-variants?actingSubject=${encodeURIComponent(f.actor)}`;
    expect((await contentCall('GET', variantsPath)).status).toBe(404);
    await f.grant(`content:variants:${created.work}`, 'content.variants.read');
    expect(await f.json<{ items: unknown[] }>(await contentCall('GET', variantsPath), 200))
      .toMatchObject({ items: [] });
    await f.grant(`work:edit:${created.work}`, 'work.edit');
    await f.grant(`content:draft:${created.work}`, 'content.draft');
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draftBody = '章の本文';
    const saved = await f.json<{ revisionId: string; byteDigest: string }>(await contentCall('POST',
      '/v1/content-drafts', { profile: 'content-text-v1', resourceId: created.work,
        variantId, language: { kind: 'tag', tag: 'ja', originalTag: 'ja' }, direction: 'ltr',
        expectedHead: null, body: draftBody, actingSubject: f.actor }), 201);
    expect(saved.byteDigest).toBe(createHash('sha256').update(JSON.stringify({ body: draftBody })).digest('hex'));
    expect(await f.json<{ items: unknown[] }>(await contentCall('GET', variantsPath), 200))
      .toMatchObject({ items: [{ variantId, draftHead: saved.revisionId,
        publicationHead: null, eligibilityHead: null }] });
    const newer = await f.json<{ revisionId: string }>(await contentCall('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: created.work, variantId,
      language: { kind: 'tag', tag: 'ja', originalTag: 'ja' }, direction: 'ltr',
      expectedHead: saved.revisionId, body: '改訂後の本文', actingSubject: f.actor,
    }), 201);
    const staleContent = await contentCall('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: created.work, variantId,
      language: { kind: 'tag', tag: 'ja', originalTag: 'ja' }, direction: 'ltr',
      expectedHead: saved.revisionId, body: '古い改訂', actingSubject: f.actor,
    });
    expect(staleContent.status).toBe(409);
    expect(await staleContent.json()).toMatchObject({ code: 'stale_head', currentHead: newer.revisionId });

    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
    const composition = await f.json<{ structure: string; revision: string }>(await f.call('POST',
      '/v1/compositions', { profile: 'book-composition', work: created.work,
        mainVersion: created.mainVersion, actingSubject: f.actor }), 201);
    const chapterBody = { profile: 'book-chapter-create-v1', title: '第一章', language: 'ja',
      direction: 'ltr', parent: composition.structure, position: 'last',
      expectedCompositionHead: composition.revision, actingSubject: f.actor };
    const chapterKey = randomUUID();
    const chapterCall = (payload: object = chapterBody) => studio.handle(new Request(
      `http://main.local/v1/works/${shortId(created.work)}/chapters`, { method: 'POST',
        headers: { authorization: `Bearer ${f.account.tokenA}`, 'content-type': 'application/json',
          'idempotency-key': chapterKey }, body: JSON.stringify(payload) }));
    const chapter = await f.json<{ work: string; workRevision: string; occurrence: string; compositionRevision: string;
      variantId: string; replayed: boolean }>(await chapterCall(), 200);
    expect(chapter).toMatchObject({ replayed: false, variantId: expect.stringMatching(/^urn:rezics:variant:/) });
    expect((await f.json<typeof chapter>(await chapterCall(), 200))).toMatchObject({
      work: chapter.work, occurrence: chapter.occurrence,
      compositionRevision: chapter.compositionRevision, replayed: true });
    expect((await chapterCall({ ...chapterBody, title: '改題' })).status).toBe(409);
    expect((await chapterCall({ ...chapterBody, direction: 'rtl' })).status).toBe(409);
    const chapterResult = chapter as typeof chapter & { receipt: string;
      sourcePosition: { dataEpoch: string; sequence: string } };
    const eventIds = ['structure', 'chapter'].map(suffix =>
      `urn:rezics:event:${hash(`${chapterResult.receipt}\0${suffix}`)}`);
    const batch = { batchId: `urn:rezics:outbox:${hash(chapterResult.receipt)}`,
      dataEpoch: chapterResult.sourcePosition.dataEpoch,
      sequence: chapterResult.sourcePosition.sequence,
      routingEpoch: f.env.lineage.routingEpoch, eventIds };
    const commandEvent = await readMainOutboxEnvelope(f.env.fuseki, batch, eventIds[0]!);
    expect(commandEvent.data.receipt).toMatchObject({ chapterWork: chapter.work });
    const chapterEvent = await readMainOutboxEnvelope(f.env.fuseki, batch, eventIds[1]!);
    expect(chapterEvent.data.receipt).toMatchObject({ chapter: { work: chapter.work,
      compositionRevision: chapter.compositionRevision } });
    const chapterInventory = await f.json<{ items: Array<{ id: string }> }>(await studioCall(), 200);
    expect(chapterInventory.items.map(item => item.id)).toContain(chapter.work);
    await f.grant(`work:read:${chapter.work}`, 'work.read');
    const chapterHead = await f.json<{ title: string; language: string }>(await f.call('GET',
      `/v1/revisions/${shortId(chapter.workRevision)}?actingSubject=${encodeURIComponent(f.actor)}`), 200);
    expect(chapterHead).toMatchObject({ title: '第一章', language: 'ja' });
  } finally { await f.close(); }
}, 20_000);
