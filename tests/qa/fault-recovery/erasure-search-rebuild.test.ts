import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
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
import { clearQuarantinedContentUnits, ContentRebuildUnavailable,
  quarantinePublicContentSearch, replayQuarantinedContentCut, verifyQuarantinedContentIndex }
  from '../../../services/main/src/modules/content-publication/rebuild.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import { ErasureService } from '../../../services/main/src/modules/erasure/request.ts';
import { activateMetadataWork, initializeFreshGraph, iri, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { SearchIndexUnavailable }
  from '../../../services/main/src/modules/work/search-readiness.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';

const root = resolve(import.meta.dir, '../../..');

function rootCommand(args: string[], timeout: number): string {
  const result = spawnSync(...scriptCommand(args), { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 4_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-4000)}`);
  }
  return result.stdout;
}

async function migrateOwner(url: string, owner: 'access' | 'relay'): Promise<void> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const directory = join(root, `services/main/migrations/${owner}`);
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
      await db.query(readFileSync(join(directory, file), 'utf8'));
    }
  } finally { await db.end(); }
}

test('SEARCH20/SEARCH08/WORK10/OPS10: erasure survives lost projection and offline rebuild', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault tier');
  const runId = `${Bun.env.REZICS_QA_RUN_ID}-er`;
  const options = { profile: 'qa' as const, runId, persistent: true, rawUpdate: true };
  const stackArgs = ['--profile', 'qa', '--run-id', runId, '--persistent', '--raw-update'];
  let started = false;
  let contentPool: Pool | undefined;
  let accessPool: Pool | undefined;
  let relayPool: Pool | undefined;
  try {
    started = true;
    rootCommand(['stack:up', ...stackArgs], 180_000);
    const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
    await migrateOwner(apps.ACCESS_DATABASE_URL!, 'access');
    await migrateOwner(apps.ACCOUNT_RELAY_DATABASE_URL!, 'relay');
    contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
    accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    relayPool = new Pool({ connectionString: apps.ACCOUNT_RELAY_DATABASE_URL });
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const env = { fuseki, objectDirectory: apps.MAIN_OBJECT_DIRECTORY!,
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! } };
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
    const consumer = apps.CONTENT_PROJECTION_CONSUMER ?? 'main-content-public-search-v1';
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
    const kept = await publish(oldBody, retained);
    await relayToHead();
    expect((await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: oldBody, language: 'en' })).total).toBe(2);
    const app = createMainApp(fuseki, { environment: env, account: { verify: async () => principal },
      access: registry, erasures: new ErasureService(relayPool, contentPool, accessPool),
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
    await expect(queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: oldBody, language: 'en' })).rejects.toBeInstanceOf(ContentProjectionUnavailable);
    expect((await page(pageBody.next)).status).toBe(503);
    const nextBody = `replacement${randomUUID().replaceAll('-', '')}`;
    const replacement = await publish(nextBody);
    const unpublishedBody = `unpublished${randomUUID().replaceAll('-', '')}`;
    const unpublished = await saveAdmittedContentDraft(env, content,
      { verify: async () => principal }, registry,
      new Request('http://main.local/v1/content-drafts', {
        method: 'POST', headers: { authorization: 'Bearer qa' } }), {
      resourceId: work.work,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work.work,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, body: unpublishedBody, actingSubject: actor,
      idempotencyKey: `unpublished-${randomUUID()}` });
    expect(unpublished.outcome).toBe('succeeded');
    await relayToHead();
    expect((await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: nextBody, language: 'en' })).results[0]?.revision)
      .toBe(`urn:rezics:content:revision:${replacement.revisionId}`);
    expect((await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: oldBody, language: 'en' })).results)
      .toMatchObject([{ revision: `urn:rezics:content:revision:${kept.revisionId}` }]);
    expect((await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: unpublishedBody, language: 'en' })).total).toBe(0);
    const restarted = await page(pageBody.next);
    expect(restarted.status).toBe(409);
    expect((await restarted.json() as { code: string }).code).toBe('search_restart_required');

    // A retained Content cut is replayed after the current RDF unit is lost.
    // The erased old active event must be acknowledged through its exact graph
    // suppression proof; only the replacement and unrelated retained variant
    // may be rebuilt into the new Lucene generation.
    const beforeRebuild = await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: nextBody, language: 'en' });
    const lostUnit = beforeRebuild.results[0]?.matchUnit;
    if (!lostUnit) throw new Error('replacement unit is missing before fault');
    const jobId = randomUUID();
    const job = await quarantinePublicContentSearch(env, content, jobId);
    expect(job.cut).toEqual(await content.ownerPosition());
    const rawUrl = new URL('../raw-rezics/update', apps.FUSEKI_URL!);
    const dropped = await fetch(rawUrl, { method: 'POST',
      headers: { 'content-type': 'application/sparql-update' },
      body: `DELETE WHERE { GRAPH <urn:rezics:search:public> {
        ${iri(lostUnit)} ?p ?o . } }`, signal: AbortSignal.timeout(10_000) });
    expect(dropped.ok).toBe(true);
    const resultText = rootCommand(['search:rebuild', '--job', jobId, ...stackArgs], 420_000);
    const rebuilt = JSON.parse(resultText.trim().split(/\r?\n/).at(-1) ?? '') as {
      job: string; replayed: number; generation: string };
    expect(rebuilt.job).toBe(jobId);
    expect(rebuilt.replayed).toBeGreaterThan(0);
    expect(rebuilt.generation).not.toBe(beforeRebuild.indexGeneration);
    const afterRebuild = await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: nextBody, language: 'en' });
    expect(afterRebuild.results[0]?.revision)
      .toBe(`urn:rezics:content:revision:${replacement.revisionId}`);
    expect(afterRebuild.results[0]?.matchUnit).not.toBe(lostUnit);
    expect((await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: oldBody, language: 'en' })).results)
      .toMatchObject([{ revision: `urn:rezics:content:revision:${kept.revisionId}` }]);
    expect((await queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: unpublishedBody, language: 'en' })).total).toBe(0);
    expect((await page(pageBody.next)).status).toBe(409);
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
    const second = await quarantinePublicContentSearch(env, content, randomUUID());
    const eraseCurrent = await app.handle(new Request('http://main.local/v1/erasures', {
      method: 'POST', headers: { authorization: 'Bearer qa', 'content-type': 'application/json',
        'idempotency-key': `erasure-${randomUUID()}` },
      body: JSON.stringify({ profile: 'content-revision-erasure-v1',
        actingSubject: actor, resourceId: work.work, revisionIds: [replacement.revisionId] }) }));
    expect(eraseCurrent.status).toBe(200);
    await clearQuarantinedContentUnits(env, second);
    await replayQuarantinedContentCut(env, content, cursor, second);
    await expect(verifyQuarantinedContentIndex(env, content, cursor, second))
      .rejects.toBeInstanceOf(ContentRebuildUnavailable);
    await expect(queryPublicContentPhrase(env, content, cursor, consumer,
      { phrase: nextBody, language: 'en' })).rejects.toBeInstanceOf(SearchIndexUnavailable);
  } finally {
    await Promise.allSettled([contentPool?.end(), accessPool?.end(), relayPool?.end()]);
    if (started) rootCommand(['stack:reset', ...stackArgs], 120_000);
  }
}, 600_000);
