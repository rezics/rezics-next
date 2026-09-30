import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { activateMetadataWork, GRAPHS, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { textContributionEditDigest } from '../../../services/main/src/modules/contribution/edit.ts';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

test('G-526: empty Content and Contribution revisions persist, replay and reject publication without admission', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const directory = resolve('.temp', `g-526-${randomUUID()}`);
  const f = await authorCreditFixture(Bun.env as Record<string, string>, directory);
  try {
    const title = `Empty draft ${randomUUID()}`;
    const workId = randomUUID();
    const work = (await activateMetadataWork(f.env, { title, admission: {
      id: workId, scope: 'work:create:root', action: 'work.create', authorityEpoch: '0',
      idempotencyKey: workId, requestDigest: metadataWorkRequestDigest(title),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } })).work;
    const content = new ContentCore(f.pool);
    const app = () => createMainApp(f.env.fuseki, { environment: f.env,
      account: f.account.verifier, access: f.access,
      content: new ContentCore(f.pool), contentAuthoring: new ContentCore(f.pool) });
    const main = app();
    const call = (path: string, body?: object, key = randomUUID(), token = f.account.tokenA,
      target = main) => target.handle(new Request(`http://main.local${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`,
        'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const invalidBodyStatuses: number[] = [];
    const freshToken = await f.account.tokenFor(f.account.a);
    const fresh = app();
    const admissionsFor = async (key: string) => (await f.accessPool.query(
      'SELECT id FROM access.admission WHERE idempotency_key = $1', [key])).rows;
    await f.grant(`work:read:${work}`, 'work.read');
    const contentGrant = await f.grant(`content:draft:${work}`, 'content.draft');
    await f.grant(`content:publish:${work}`, 'content.publish');
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = { profile: 'content-text-v1', resourceId: work, variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead: null as string | null, body: 'Earlier chapter', actingSubject: f.actor };
    const first = await f.json<{ revisionId: string; byteDigest: string;
      sourcePosition: { dataEpoch: string } }>(await call('/v1/content-drafts', draft), 201);
    const publication = { profile: 'content-publication-v1', preparationId: randomUUID(),
      resourceId: work, variantId, revisionId: first.revisionId, expectedDigest: first.byteDigest,
      expectedContentEpoch: first.sourcePosition.dataEpoch, expectedPublicationHead: null,
      actingSubject: f.actor };
    const published = await f.json<{ decision: string }>(await call('/v1/content-publications', publication), 201);
    const cleared = { ...draft, expectedHead: first.revisionId, body: '' };
    const clearKey = randomUUID();
    const empty = await f.json<{ revisionId: string; byteDigest: string }>(
      await call('/v1/content-drafts', cleared, clearKey), 201);
    expect(empty.revisionId).not.toBe(first.revisionId);
    expect(empty.byteDigest).toBe(digest('{"body":""}'));
    const readPath = `/v1/content-revisions/${empty.revisionId}?actingSubject=${encodeURIComponent(f.actor)}`;
    expect(await f.json(await call(readPath, undefined, randomUUID(), freshToken, fresh), 200))
      .toMatchObject({ body: { body: '' }, serializedJson: '{"body":""}',
        reference: { revisionId: empty.revisionId, byteDigest: empty.byteDigest } });
    expect(await f.json(await call('/v1/content-drafts', cleared, clearKey), 200))
      .toMatchObject({ revisionId: empty.revisionId, byteDigest: empty.byteDigest, replayed: true });
    expect((await f.pool.query('SELECT id FROM content.revision WHERE variant_id = $1', [variantId])).rows).toHaveLength(2);
    const admission = (await admissionsFor(clearKey))[0]!;
    expect(await content.readDraftReceipt(`content-draft:${admission.id}`))
      .toMatchObject({ outcome: 'succeeded', revisionId: empty.revisionId });
    expect(await f.json(await call('/v1/content-drafts', { ...cleared, body: draft.body }), 409))
      .toMatchObject({ code: 'stale_head', currentHead: empty.revisionId });
    for (const body of [undefined, null, 7, {}, []]) {
      invalidBodyStatuses.push((await call('/v1/content-drafts', { ...cleared, body })).status);
    }
    const emptyPublishKey = randomUUID();
    const emptyPublication = { ...publication, preparationId: randomUUID(), revisionId: empty.revisionId,
      expectedDigest: empty.byteDigest, expectedPublicationHead: published.decision };
    expect(await f.json(await call('/v1/content-publications', emptyPublication, emptyPublishKey), 422))
      .toMatchObject({ code: 'empty_body' });
    expect(await admissionsFor(emptyPublishKey)).toEqual([]);
    expect(await content.readPublicationPreparation(emptyPublication.preparationId)).toBeNull();
    expect((await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH <${GRAPHS.current}> { <${variantId}> rv:contentPublicationHead <${published.decision}> } }`)).boolean).toBe(true);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false, generation = generation + 1 WHERE id = $1', [contentGrant]);
    expect((await call('/v1/content-drafts', { ...cleared, expectedHead: empty.revisionId }, randomUUID())).status).toBe(403);

    await f.grant(`contribution:create:${work}`, 'contribution.create');
    const create = { profile: 'text-contribution-v1', work, language: 'en', body: 'Earlier text', actingSubject: f.actor };
    const text = await f.json<{ contribution: string; draftRevision: string }>(await call('/v1/contributions', create), 201);
    await f.grant(`contribution:read:${text.contribution}`, 'contribution.read');
    const editGrant = await f.grant(`contribution:edit:${text.contribution}`, 'contribution.edit');
    await f.grant(`contribution:publish:${text.contribution}`, 'contribution.publish');
    const textPublication = { profile: 'text-publication-v1', contribution: text.contribution,
      expectedDraftHead: text.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: f.actor };
    const textPublished = await f.json<{ publicationDecision: string }>(
      await call('/v1/contribution-publications', textPublication), 201);
    const edit = { profile: 'text-contribution-v1', contribution: text.contribution,
      expectedHead: text.draftRevision, body: '', actingSubject: f.actor };
    const editKey = randomUUID();
    const textEmpty = await f.json<{ draftRevision: string }>(await call('/v1/contribution-edits', edit, editKey), 200);
    expect(textEmpty.draftRevision).not.toBe(text.draftRevision);
    const textPath = `/v1/contributions/${shortId(text.contribution)}/drafts/${shortId(textEmpty.draftRevision)}?actingSubject=${encodeURIComponent(f.actor)}`;
    expect(await f.json(await call(textPath, undefined, randomUUID(), freshToken, fresh), 200))
      .toMatchObject({ body: '', revision: textEmpty.draftRevision, predecessor: text.draftRevision });
    expect(await f.json(await call('/v1/contribution-edits', edit, editKey), 200))
      .toMatchObject({ draftRevision: textEmpty.draftRevision, replayed: true });
    const textReceipt = await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?revision ?digest ?manifest WHERE {
      GRAPH <${GRAPHS.receipts}> { ?receipt rv:admissionId ${JSON.stringify((await admissionsFor(editKey))[0]!.id)} ;
        rv:draftRevision ?revision ; rv:requestDigest ?digest . }
      GRAPH <${GRAPHS.revisions}> { ?revision rv:manifest ?manifest . } }`);
    expect(textReceipt.results?.bindings).toHaveLength(1);
    expect(textReceipt.results?.bindings?.[0]?.revision?.value).toBe(textEmpty.draftRevision);
    expect(textReceipt.results?.bindings?.[0]?.digest?.value).toBe(textContributionEditDigest(edit));
    expect(textReceipt.results?.bindings?.[0]?.manifest?.value).toMatch(/^urn:rezics:sha256:[0-9a-f]{64}$/);
    expect((await f.env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?revision WHERE {
      GRAPH <${GRAPHS.revisions}> { ?revision a rv:RevisionAnchor ; rv:component <${text.contribution}> ;
        rv:modelRevision <https://rezics.com/definition/text-contribution-v1> . } }`)).results?.bindings).toHaveLength(2);
    expect(await f.json(await call('/v1/contribution-edits', { ...edit, body: create.body }), 409))
      .toMatchObject({ code: 'stale_head', currentHead: textEmpty.draftRevision });
    for (const body of [undefined, null, 7, {}, []]) {
      invalidBodyStatuses.push((await call('/v1/contribution-edits', { ...edit, body })).status);
      invalidBodyStatuses.push((await call('/v1/contributions', { ...create, body })).status);
    }
    const emptyTextPublishKey = randomUUID();
    expect(await f.json(await call('/v1/contribution-publications', { ...textPublication,
      expectedDraftHead: textEmpty.draftRevision, expectedPublicationHead: textPublished.publicationDecision }, emptyTextPublishKey), 422))
      .toMatchObject({ code: 'empty_body' });
    expect(await admissionsFor(emptyTextPublishKey)).toEqual([]);
    const headPath = `/v1/contributions/${shortId(text.contribution)}?actingSubject=${encodeURIComponent(f.actor)}`;
    expect(await f.json(await call(headPath), 200)).toMatchObject({ draftHead: textEmpty.draftRevision,
      publicationHead: textPublished.publicationDecision });
    const emptyCreated = await f.json<{ contribution: string; draftRevision: string }>(
      await call('/v1/contributions', { ...create, body: '' }), 201);
    expect(emptyCreated.draftRevision).toBeString();
    await f.accessPool.query('UPDATE access.permission_grant SET active = false, generation = generation + 1 WHERE id = $1', [editGrant]);
    expect((await call('/v1/contribution-edits', { ...edit, expectedHead: textEmpty.draftRevision })).status).toBe(403);
    expect(invalidBodyStatuses).toEqual(Array.from({ length: 15 }, () => 422));
  } finally {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
