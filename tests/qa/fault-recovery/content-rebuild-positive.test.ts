import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { saveAdmittedContentDraft } from '../../../services/main/src/modules/content-publication/draft.ts';
import { contentSearchEligibilityDigest, selectPublicContentSearch }
  from '../../../services/main/src/modules/content-publication/eligibility.ts';
import { contentPublicationDigest, publishPinnedContent }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { activateRebuiltPublicContentSearch, clearQuarantinedContentUnits,
  quarantinePublicContentSearch, replayQuarantinedContentCut }
  from '../../../services/main/src/modules/content-publication/rebuild.ts';
import { ContentProjectionUnavailable, relayContentProjectionOnce }
  from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import { RV, initializeFreshGraph, iri } from '../../../services/main/src/modules/work/activate.ts';
import { assertPublicTextReady, SearchIndexUnavailable }
  from '../../../services/main/src/modules/work/search-readiness.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { seedLoadCorpus } from '../load/corpus.ts';

const root = resolve(import.meta.dir, '../../..');

function rootCommand(args: string[], timeout: number): string {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 4_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-4000)}`);
  }
  return result.stdout;
}

async function migrateAccess(url: string): Promise<void> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const directory = join(root, 'services/main/migrations/access');
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
      await db.query(readFileSync(join(directory, file), 'utf8'));
    }
  } finally { await db.end(); }
}

test('SEARCH20/OPS16: lost RDF and erased old Content rebuild from the changed cut', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR) {
    throw new Error('Run through the isolated fault/recovery QA tier');
  }
  const runId = `${Bun.env.REZICS_QA_RUN_ID}-pr`;
  const options = { profile: 'qa' as const, runId, persistent: true, rawUpdate: true };
  const stackArgs = ['--profile', 'qa', '--run-id', runId, '--persistent', '--raw-update'];
  const startedAt = Date.now();
  let started = false;
  try {
    started = true;
    rootCommand(['stack:up', ...stackArgs], 180_000);
    const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    await initializeFreshGraph(fuseki, lineage);
    await migrateAccess(apps.ACCESS_DATABASE_URL!);
    const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 4 });
    const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 4 });
    try {
      await migrateContent(contentPool);
      const content = new ContentCore(contentPool);
      const cursor = new ContentProjectionCursor(contentPool);
      const consumer = apps.CONTENT_PROJECTION_CONSUMER ?? 'main-content-public-search-v1';
      const env = { fuseki, lineage, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
      const corpus = await seedLoadCorpus(env, contentPool, accessPool);
      const cut = await content.ownerPosition();
      await cursor.initialize(consumer);
      for (let i = 0; i < 10 && (await cursor.read(consumer)).sequence !== cut.sequence; i++) {
        const next = await relayContentProjectionOnce(env, content, cursor, consumer);
        if (!next) throw new Error('Content outbox stopped before source cut');
      }
      expect((await cursor.read(consumer)).sequence).toBe(cut.sequence);
      const input = { phrase: 'exact content beacon', language: 'en' };
      const before = await queryPublicContentPhrase(env, content, cursor, consumer, input);
      expect(before.complete).toBe(true);
      expect(before.total).toBe(1);
      expect(before.results[0]?.resource).toBe(corpus.works[0]);
      const exactRevision = before.results[0]!.revision.slice('urn:rezics:content:revision:'.length);
      const exact = (await content.readExactBatch([exactRevision], async ids => new Set(ids)))[0];
      expect(exact?.status).toBe('available');
      if (exact?.status !== 'available') throw new Error('fixture exact Content bytes are unavailable');
      expect(exact.body.body).toBe('exact content beacon');

      // A second author-admitted revision becomes the public head before the
      // maintenance cut. Its old revision remains retained but is not eligible.
      const access = new AccessAdmissionRegistry(accessPool);
      const replacementBody = 'replacement content lighthouse';
      const nextDraft = await saveAdmittedContentDraft(env, content,
        { verify: async () => corpus.content.principal }, access,
        new Request('http://main.local/v1/content-drafts', {
          method: 'POST', headers: { authorization: 'Bearer qa' } }),
        { resourceId: corpus.works[0]!, variant: { id: corpus.content.variantId,
          resourceId: corpus.works[0]!,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
        expectedHead: corpus.content.revisionId, body: replacementBody,
        actingSubject: corpus.content.actingSubject,
        idempotencyKey: `rebuild-replacement-${randomUUID()}` });
      expect(nextDraft.outcome).toBe('succeeded');
      if (!nextDraft.revisionId) throw new Error('replacement Content revision is absent');
      const nextExact = (await content.readExactBatch([nextDraft.revisionId],
        async ids => new Set(ids)))[0];
      if (nextExact?.status !== 'available') throw new Error('replacement Content bytes are unavailable');
      const publicationInput = { preparationId: `rebuild-replacement-${randomUUID()}`,
        revisionId: nextDraft.revisionId, expectedDigest: nextExact.reference.byteDigest,
        expectedContentEpoch: nextDraft.position.dataEpoch,
        resourceId: corpus.works[0]!, variantId: corpus.content.variantId,
        expectedPublicationHead: corpus.content.publicationDecision };
      const publicationDigest = contentPublicationDigest(publicationInput);
      const registeredPublication = await access.register({ principal: corpus.content.principal,
        actingSubject: corpus.content.actingSubject,
        scope: `content:publish:${corpus.content.variantId}`, action: 'content.publish',
        idempotencyKey: `rebuild-publish-${randomUUID()}`, requestDigest: publicationDigest });
      const claimedPublication = await access.claim(registeredPublication.id, publicationDigest);
      const nextPublication = await publishPinnedContent(env, content, claimedPublication, publicationInput);
      expect(nextPublication.status).toBe('active');
      if (!nextPublication.decision) throw new Error('replacement publication decision is absent');
      const eligibilityInput = { resourceId: corpus.works[0]!, variantId: corpus.content.variantId,
        publicationDecision: nextPublication.decision,
        expectedEligibilityHead: corpus.content.eligibilityDecision,
        actingSubject: corpus.content.actingSubject,
        rightsBasis: 'original-contribution' as const, disclosure: 'public' as const };
      const eligibilityDigest = contentSearchEligibilityDigest(eligibilityInput);
      const registeredEligibility = await access.register({ principal: corpus.content.principal,
        actingSubject: corpus.content.actingSubject,
        scope: `content:search-eligibility:${corpus.content.variantId}`,
        action: 'content.search-eligibility', idempotencyKey: `rebuild-eligibility-${randomUUID()}`,
        requestDigest: eligibilityDigest });
      const claimedEligibility = await access.claim(registeredEligibility.id, eligibilityDigest);
      const nextEligibility = await selectPublicContentSearch(env, content, access,
        claimedEligibility, eligibilityInput);
      expect(nextEligibility.outcome).toBe('succeeded');
      const draftBody = 'unpublished draft search shadow';
      const privateDraft = await content.saveDraft({ operationId: `private-draft-${randomUUID()}`,
        variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: corpus.works[0]!,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
        expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
        provenance: { fixture: 'search20-unpublished' },
        serializedJson: JSON.stringify({ body: draftBody }) });
      expect(privateDraft.outcome).toBe('succeeded');
      expect(privateDraft.revisionId).toBeTruthy();
      const changedCut = await content.ownerPosition();
      expect(BigInt(changedCut.sequence)).toBeGreaterThan(BigInt(cut.sequence));
      await expect(queryPublicContentPhrase(env, content, cursor, consumer,
        { phrase: replacementBody, language: 'en' })).rejects.toBeInstanceOf(ContentProjectionUnavailable);
      for (let i = 0; i < 10 && (await cursor.read(consumer)).sequence !== changedCut.sequence; i++) {
        const next = await relayContentProjectionOnce(env, content, cursor, consumer);
        if (!next) throw new Error('Content outbox stopped before changed source cut');
      }
      expect((await cursor.read(consumer)).sequence).toBe(changedCut.sequence);
      const currentInput = { phrase: replacementBody, language: 'en' };
      const changed = await queryPublicContentPhrase(env, content, cursor, consumer, currentInput);
      expect(changed.complete).toBe(true);
      expect(changed.total).toBe(1);
      expect(changed.results[0]?.revision).toBe(`urn:rezics:content:revision:${nextDraft.revisionId}`);
      expect((await queryPublicContentPhrase(env, content, cursor, consumer, input)).total).toBe(0);

      // The superseded public revision is erased after its replacement was
      // selected. A retained unpublished draft remains readable in Content.
      await contentPool.query(`UPDATE content.revision SET availability = 'erased',
        serialized_bytes = NULL, body = NULL WHERE id = $1`, [exactRevision]);
      expect((await content.readExactBatch([exactRevision], async ids => new Set(ids)))[0]?.status)
        .toBe('erased');
      expect((await content.readExactBatch([privateDraft.revisionId!],
        async ids => new Set(ids)))[0]?.status).toBe('available');

      const jobId = randomUUID();
      const job = await quarantinePublicContentSearch(env, content, jobId);
      expect(job.cut).toEqual(changedCut);
      await expect(assertPublicTextReady(fuseki, lineage)).rejects.toBeInstanceOf(SearchIndexUnavailable);
      await expect(queryPublicContentPhrase(env, content, cursor, consumer, currentInput))
        .rejects.toBeInstanceOf(SearchIndexUnavailable);
      // A digest alone cannot substitute for the native clear/replay receipt chain.
      await expect(activateRebuiltPublicContentSearch(env, content, cursor, job,
        consumer, 'a'.repeat(64))).rejects.toThrow('Content cleanup receipt is absent');
      const quarantined = await fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH <${PUBLIC_SEARCH_GRAPH}> {
          <urn:rezics:search:public:anchor> a rv:SearchGraphAnchor . } }`);
      expect(quarantined.boolean).toBe(false);

      // Lose the RDF body projection through the isolated bare-TDB2 fault alias.
      // This leaves a stale Lucene document until the offline replacement pass.
      const lostUnit = changed.results[0]!.matchUnit;
      const rawUrl = new URL('../raw-rezics/update', apps.FUSEKI_URL!);
      const dropped = await fetch(rawUrl, { method: 'POST',
        headers: { 'content-type': 'application/sparql-update' },
        body: `DELETE WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(lostUnit)} ?p ?o . } }`,
        signal: AbortSignal.timeout(10_000) });
      expect(dropped.ok).toBe(true);
      const lostRdf = await fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(lostUnit)} a rv:MatchUnit . } }`);
      expect(lostRdf.boolean).toBe(false);
      const staleIndex = await fuseki.query(`PREFIX rv: <${RV}>
        PREFIX text: <http://jena.apache.org/text#> SELECT ?unit WHERE {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody '"replacement content lighthouse"' 10) .
          FILTER(?unit = ${iri(lostUnit)}) } }`);
      expect(staleIndex.results?.bindings.length).toBe(1);
      rootCommand(['stack:down', ...stackArgs], 120_000);
      rootCommand(['stack:up', ...stackArgs], 180_000);
      expect(await quarantinePublicContentSearch(env, content, jobId)).toEqual(job);
      await expect(assertPublicTextReady(fuseki, lineage)).rejects.toBeInstanceOf(SearchIndexUnavailable);

      // Simulate interruption after the durable quarantine receipt. The root
      // operator command resumes this job and performs the actual offline pass.
      const operation = rootCommand(['search:rebuild', '--job', jobId, ...stackArgs], 420_000);
      const line = operation.trim().split(/\r?\n/).at(-1);
      const result = JSON.parse(line ?? '') as { job: string; removed: number;
        replayed: number; generation: string; logPath: string };
      expect(result.job).toBe(jobId);
      expect(result.removed).toBe(0);
      expect(result.replayed).toBeGreaterThan(0);
      expect(result.generation).not.toBe(changed.indexGeneration);
      expect(readFileSync(result.logPath, 'utf8')).toMatch(/textindexer\s+::\s+\d+ \(\d+ per second\) properties indexed/);
      const after = await queryPublicContentPhrase(env, content, cursor, consumer, currentInput);
      expect(after.complete).toBe(true);
      expect(after.population).toBe(1);
      expect(after.total).toBe(1);
      expect(after.results[0]).toMatchObject({ resource: changed.results[0]!.resource,
        variant: changed.results[0]!.variant, revision: changed.results[0]!.revision });
      expect(after.results[0]!.matchUnit).not.toBe(changed.results[0]!.matchUnit);
      expect(after.results[0]!.matchUnit).not.toBe(before.results[0]!.matchUnit);
      expect(after.contentPosition).toEqual(changedCut);
      expect(after.indexGeneration).toBe(result.generation);
      expect(BigInt(after.graphPosition.sequence)).toBeGreaterThan(BigInt(before.graphPosition.sequence));
      const old = await queryPublicContentPhrase(env, content, cursor, consumer, input);
      expect(old.complete).toBe(true);
      expect(old.total).toBe(0);
      const retainedOld = (await content.readExactBatch([exactRevision],
        async ids => new Set(ids)))[0];
      expect(retainedOld?.status).toBe('erased');
      const unpublished = await queryPublicContentPhrase(env, content, cursor, consumer,
        { phrase: draftBody, language: 'en' });
      expect(unpublished.complete).toBe(true);
      expect(unpublished.total).toBe(0);
      const staleUnits = await fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH <${PUBLIC_SEARCH_GRAPH}> { ?unit a rv:MatchUnit ;
          rv:revision <${before.results[0]!.revision}> . } }`);
      expect(staleUnits.boolean).toBe(false);
      const draftUnits = await fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ;
          rv:revision ${iri(`urn:rezics:content:revision:${privateDraft.revisionId}`)} . } }`);
      expect(draftUnits.boolean).toBe(false);

      // A second quarantined pass loses the *current* exact source body. It
      // must stop before index activation, even though the prior pass succeeded.
      const missingJob = await quarantinePublicContentSearch(env, content, randomUUID());
      await contentPool.query(`UPDATE content.revision SET availability = 'erased',
        serialized_bytes = NULL, body = NULL WHERE id = $1`, [nextDraft.revisionId]);
      expect((await content.readExactBatch([nextDraft.revisionId],
        async ids => new Set(ids)))[0]?.status).toBe('erased');
      expect(await clearQuarantinedContentUnits(env, missingJob)).toBe(1);
      await expect(replayQuarantinedContentCut(env, content, cursor, missingJob))
        .rejects.toThrow('terminal publication exact revision unavailable');
      await expect(queryPublicContentPhrase(env, content, cursor, consumer, currentInput))
        .rejects.toBeInstanceOf(SearchIndexUnavailable);
      await expect(activateRebuiltPublicContentSearch(env, content, cursor, missingJob,
        consumer, 'a'.repeat(64))).rejects.toThrow('Content replay does not cover exact owner cut');
      writeFileSync(join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'content-rebuild-positive.json'),
        JSON.stringify({ runId, job: jobId, oldGeneration: before.indexGeneration,
          newGeneration: after.indexGeneration, oldGraphSequence: before.graphPosition.sequence,
          newGraphSequence: after.graphPosition.sequence, initialContentCut: cut,
          contentCut: changedCut, oldRevision: before.results[0]!.revision,
          newRevision: after.results[0]!.revision, lostUnit, oldErased: retainedOld?.status,
          unpublishedDraftRevision: privateDraft.revisionId, missingJob: missingJob.id,
          missingCurrentRevision: nextDraft.revisionId, oldTotal: old.total,
          removed: result.removed, replayed: result.replayed, elapsedMs: Date.now() - startedAt,
          result: after.results[0] }, null, 2) + '\n');
    } finally {
      await Promise.all([contentPool.end(), accessPool.end()]);
    }
  } finally {
    if (started) rootCommand(['stack:reset', ...stackArgs], 120_000);
  }
}, 600_000);
