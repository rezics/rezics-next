import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { contentPublicationDigest, publishPinnedContent, type PublishPinnedContentInput }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { saveAdmittedContentDraft } from
  '../../../services/main/src/modules/content-publication/draft.ts';
import { contentSearchEligibilityDigest, selectPublicContentSearch,
  type ContentSearchEligibilityInput } from '../../../services/main/src/modules/content-publication/eligibility.ts';
import { ContentProjectionUnavailable, relayContentProjectionOnce }
  from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import { projectPrivateContentDraft, ContentPrivateProjectionUnavailable } from
  '../../../services/main/src/modules/content-publication/search-private-projection.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { activateMetadataWork, initializeFreshGraph, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { PRIVATE_SEARCH_GRAPH } from '../../../services/main/src/modules/contribution/private-projection.ts';

const root = resolve(import.meta.dir, '../../..');

test('WORK10/SEARCH20/SEARCH08/OPS10: published erasure fences replay and replacement search', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated integration tier');
  }
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const env = { fuseki, objectDirectory: join(root, '.temp', `erasure-search-${randomUUID()}`),
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH } };
    await initializeFreshGraph(fuseki, env.lineage);
    const title = `Erasure search ${randomUUID()}`;
    const workId = randomUUID();
    const work = await activateMetadataWork(env, { title, admission: {
      id: workId, scope: 'work:create:root', action: 'work.create',
      idempotencyKey: `erasure-work-${workId}`,
      requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } });
    const principal = { issuer: 'https://qa-erasure-search.test', subject: randomUUID() };
    const principalId = randomUUID();
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const variantId = `urn:rezics:variant:${workId}`;
    const retainedVariantId = `urn:rezics:variant:${randomUUID()}`;
    const registry = new AccessAdmissionRegistry(accessPool);
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [principalId, principal.issuer, principal.subject]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind)
      VALUES ($1, 'agent')`, [actor]);
    for (const [scope, action] of [
      [`erasure:${work.work}`, 'erasure.request'],
      [`content:draft:${work.work}`, 'content.draft'],
      [`content:search-eligibility:${variantId}`, 'content.search-eligibility'],
      [`content:search-eligibility:${retainedVariantId}`, 'content.search-eligibility'],
    ]) {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
      await accessPool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), principalId, actor, action]);
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), actor, scope, action]);
    }
    const cursor = new ContentProjectionCursor(contentPool);
    const consumer = `erasure-search-${randomUUID()}`;
    await cursor.initialize(consumer);
    const primary = { variantId, draftHead: null as string | null,
      publicationHead: null as string | null, eligibilityHead: null as string | null };
    const retained = { variantId: retainedVariantId, draftHead: null as string | null,
      publicationHead: null as string | null, eligibilityHead: null as string | null };
    const publish = async (body: string, state = primary) => {
      const saved = await saveAdmittedContentDraft(env, content,
        { verify: async () => principal }, registry,
        new Request('http://main.local/v1/content-drafts', {
          method: 'POST', headers: { authorization: 'Bearer qa' } }), {
        resourceId: work.work,
        variant: { id: state.variantId, resourceId: work.work,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
        expectedHead: state.draftHead, body, actingSubject: actor,
        idempotencyKey: `erasure-draft-${randomUUID()}` });
      if (saved.outcome !== 'succeeded' || !saved.revisionId) throw new Error('draft save failed');
      state.draftHead = saved.revisionId;
      const exact = (await content.readExactBatch([saved.revisionId],
        async ids => new Set(ids)))[0];
      if (exact?.status !== 'available') throw new Error('exact Content source unavailable');
      const input: PublishPinnedContentInput = { preparationId: `erasure-publish-${randomUUID()}`,
        revisionId: saved.revisionId, expectedDigest: exact.reference.byteDigest,
        expectedContentEpoch: saved.position.dataEpoch, resourceId: work.work,
        variantId: state.variantId, expectedPublicationHead: state.publicationHead };
      const admissionId = randomUUID();
      const admission: RegisteredAdmission = { id: admissionId, principalId,
        actingSubject: actor, scope: `content:publish:${state.variantId}`, action: 'content.publish',
        idempotencyKey: `publish-${admissionId}`, requestDigest: contentPublicationDigest(input),
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'registered', dispatchEligible: true, replayed: false };
      const publication = await publishPinnedContent(env, content, admission, input);
      if (publication.status !== 'active' || !publication.decision) throw new Error('publication failed');
      state.publicationHead = publication.decision;
      const eligibilityInput: ContentSearchEligibilityInput = {
        resourceId: work.work, variantId: state.variantId, publicationDecision: publication.decision,
        expectedEligibilityHead: state.eligibilityHead, actingSubject: actor,
        rightsBasis: 'original-contribution', disclosure: 'public' };
      const digest = contentSearchEligibilityDigest(eligibilityInput);
      const registered = await registry.register({ principal, actingSubject: actor,
        scope: `content:search-eligibility:${state.variantId}`, action: 'content.search-eligibility',
        idempotencyKey: `eligibility-${randomUUID()}`, requestDigest: digest });
      const claimed = await registry.claim(registered.id, digest);
      const eligibility = await selectPublicContentSearch(env, content, registry,
        claimed, eligibilityInput);
      if (eligibility.outcome !== 'succeeded' || !eligibility.decision) {
        throw new Error('public eligibility failed');
      }
      state.eligibilityHead = eligibility.decision;
      return { revisionId: saved.revisionId, preparationId: input.preparationId };
    };
    const relayToHead = async () => {
      const high = await content.ownerPosition();
      for (let i = 0; i < 12 && (await cursor.read(consumer)).sequence !== high.sequence; i++) {
        if (!await relayContentProjectionOnce(env, content, cursor, consumer)) {
          throw new Error('projection replay ended before owner cut');
        }
      }
      expect((await cursor.read(consumer)).sequence).toBe(high.sequence);
    };
    const oldBody = `erasebody${randomUUID().replaceAll('-', '')}`;
    const old = await publish(oldBody);
    const privateUnit = await projectPrivateContentDraft(env, content, work.work, variantId,
      old.revisionId, (await content.ownerPosition()).dataEpoch);
    const privateBytes = async () => (await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?body WHERE { GRAPH <${PRIVATE_SEARCH_GRAPH}> {
        <${privateUnit.unit}> rv:revision <urn:rezics:content:revision:${old.revisionId}> ;
          rv:privateSearchBody ?body . } }`, 65_536)).results?.bindings ?? [];
    expect((await privateBytes()).map(row => row.body?.value)).toEqual([oldBody]);
    const kept = await publish(oldBody, retained);
    await relayToHead();
    expect((await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: oldBody, language: 'en' })).total).toBe(2);
    const app = createMainApp(fuseki, { environment: env, account: { verify: async () => principal },
      access: registry, erasures: new ErasureService(relayPool, contentPool),
      contentProjection: { content, cursor, consumer } });
    const page = (continuation?: object) => app.handle(new Request(
      'http://main.local/v1/queries/page', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'public-content-phrase-page-v1',
          phrase: oldBody, language: 'en', pageSize: 1,
          ...(continuation ? { continuation } : {}) }) }));
    const firstPage = await page();
    expect(firstPage.status).toBe(200);
    const pageBody = await firstPage.json() as { next: object | null; total: number };
    expect(pageBody.total).toBe(2);
    if (!pageBody.next) throw new Error('two-result Content page has no continuation');
    const erasure = await app.handle(new Request('http://main.local/v1/erasures', {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': `erasure-${randomUUID()}` },
      body: JSON.stringify({ profile: 'content-revision-erasure-v1',
        actingSubject: actor, resourceId: work.work, revisionIds: [old.revisionId] }) }));
    expect({ status: erasure.status, body: await erasure.json() }).toMatchObject({ status: 200,
      body: { suppression: 'suppressed' } });
    expect((await content.readExactBatch([old.revisionId], async ids => new Set(ids)))[0]?.status)
      .toBe('erased');
    expect(await privateBytes()).toHaveLength(0);
    await expect(projectPrivateContentDraft(env, content, work.work, variantId,
      old.revisionId, (await content.ownerPosition()).dataEpoch))
      .rejects.toBeInstanceOf(ContentPrivateProjectionUnavailable);
    await expect(queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: oldBody, language: 'en' })).rejects.toBeInstanceOf(ContentProjectionUnavailable);
    expect((await page(pageBody.next)).status).toBe(503);
    const nextBody = `replacement${randomUUID().replaceAll('-', '')}`;
    const replacement = await publish(nextBody);
    await relayToHead();
    expect((await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: nextBody, language: 'en' })).results[0]?.revision)
      .toBe(`urn:rezics:content:revision:${replacement.revisionId}`);
    expect((await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: oldBody, language: 'en' })).results)
      .toMatchObject([{ revision: `urn:rezics:content:revision:${kept.revisionId}` }]);
    const restarted = await page(pageBody.next);
    expect(restarted.status).toBe(409);
    expect((await restarted.json() as { code: string }).code).toBe('search_restart_required');
    const replay = `erasure-search-replay-${randomUUID()}`;
    await cursor.initialize(replay);
    const dispositions: string[] = [];
    while (BigInt((await cursor.read(replay)).sequence)
      < BigInt((await content.ownerPosition()).sequence)) {
      const step = await relayContentProjectionOnce(env, content, cursor, replay);
      if (!step) throw new Error('replay stopped before Content owner cut');
      dispositions.push(step.disposition);
    }
    expect(dispositions).toContain('superseded');
    expect(dispositions).toContain('projected');
  } finally {
    await Promise.allSettled([contentPool.end(), accessPool.end(), relayPool.end()]);
  }
}, 180_000);
