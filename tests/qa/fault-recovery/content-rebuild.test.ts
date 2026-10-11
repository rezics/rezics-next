import { qaStartupTestTimeout, runQaAdmissionChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { saveAdmittedContentDraft } from '../../../services/main/src/modules/content-publication/draft.ts';
import { contentSearchEligibilityDigest, selectPublicContentSearch }
  from '../../../services/main/src/modules/content-publication/eligibility.ts';
import { contentPublicationDigest, publishPinnedContent, type PublishPinnedContentInput }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { clearQuarantinedContentUnits,
  quarantinePublicContentSearch, replayQuarantinedContentCut }
  from '../../../services/main/src/modules/content-publication/rebuild.ts';
import { contentRebuildDelivery, prepareContentRebuild, type ContentRebuildFrontier }
  from '../../../services/main/src/modules/content-publication/rebuild-preflight.ts';
import { activateMetadataWork, metadataWorkRequestDigest,
  DATASET, GRAPHS, RV, hash, initializeFreshGraph, iri, lit }
  from '../../../services/main/src/modules/work/activate.ts';
import { assertPublicTextReady } from '../../../services/main/src/modules/work/search-readiness.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';
import { migrateTracked } from '../../../scripts/ops/migrate.ts';
import { applyQaSqlMigrations } from '../../../scripts/qa/bootstrap.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';

const root = resolve(import.meta.dir, '../../..');

async function rootCommand(args: string[], timeout: number): Promise<void> {
  const result = await runQaAdmissionChildAsync(root, ...scriptCommand(args), timeout);
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-2000)}`);
  }
}

test('SEARCH20/OPS16: native quarantine survives restart and erased exact Content keeps search unavailable', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated fault/recovery QA tier');
  const runId = `${Bun.env.REZICS_QA_RUN_ID}-rb`;
  const options = { profile: 'qa' as const, runId };
  let started = false;
  try {
    started = true;
    await rootCommand(['stack:up', '--profile', 'qa', '--run-id', runId], 180_000);
    const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    await initializeFreshGraph(fuseki, lineage);
    const pool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 4 });
    const relayPool = new Pool({ connectionString: apps.MAIN_RELAY_DATABASE_URL, max: 2 });
    const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 4 });
    try {
      await migrateContent(pool);
      await migrateTracked(apps.MAIN_RELAY_DATABASE_URL!, root, 'services/main/migrations/relay');
      await applyQaSqlMigrations(apps.ACCESS_DATABASE_URL!, join(root, 'services/main/migrations/access'), schemaFiles(root, 'access'));
      const content = new ContentCore(pool);
      const env = { fuseki, lineage, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
      const id = randomUUID();
      const workAdmission = randomUUID();
      const title = `Rebuild recovery ${id}`;
      const created = await activateMetadataWork(env, { title, admission: {
        id: workAdmission, scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `rebuild-work-${id}`,
        requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      } });
      const resource = created.work;
      const variant = `urn:rezics:variant:${randomUUID()}`;
      const access = new AccessAdmissionRegistry(accessPool);
      const principal = { issuer: 'https://rebuild-recovery.test', subject: randomUUID() };
      const principalId = randomUUID();
      const actor = `https://rezics.com/id/${randomUUID()}`;
      await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
        [principalId, principal.issuer, principal.subject]);
      await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);
      const grant = async (scope: string, action: string) => grantFixtureAuthority(accessPool, {
        scope, requireDispatch: true, representations: [{ principalId, actor, action, lifetime: '8 hours' }],
        grant: { actor, action, lifetime: '8 hours' } });
      await grant(`content:draft:${resource}`, 'content.draft');
      const saved = await saveAdmittedContentDraft(env, content, { verify: async () => principal }, access,
        new Request('http://main.local/v1/content-drafts', { headers: { authorization: 'Bearer qa' } }), {
        resourceId: resource,
        variant: { id: variant, resourceId: resource,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
        expectedHead: null, body: 'erased source must stay hidden', actingSubject: actor,
        idempotencyKey: `draft-${id}` });
      if (!saved.revisionId) throw new Error('draft fixture has no revision');
      const exact = (await content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
      if (exact?.status !== 'available') throw new Error('draft fixture bytes are unavailable');
      const publicationInput: PublishPinnedContentInput = { preparationId: `prepare-${id}`,
        revisionId: saved.revisionId, expectedDigest: exact.reference.byteDigest,
        expectedContentEpoch: saved.position.dataEpoch, resourceId: resource,
        variantId: variant, expectedPublicationHead: null };
      const publicationAdmissionId = randomUUID();
      const admission: RegisteredAdmission = { id: publicationAdmissionId,
        principalId, actingSubject: actor,
        scope: `content:publish:${variant}`, action: 'content.publish',
        idempotencyKey: `rebuild-publish-${id}`,
        requestDigest: contentPublicationDigest(publicationInput), authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'registered', dispatchEligible: true, replayed: false };
      const published = await publishPinnedContent(env, content, admission, publicationInput);
      expect(published.status).toBe('active');
      expect(published.graphSequence).toBeTruthy();
      if (!published.decision) throw new Error('publication decision absent');
      const eligibilityInput = { resourceId: resource, variantId: variant,
        publicationDecision: published.decision, expectedEligibilityHead: null, actingSubject: actor,
        rightsBasis: 'original-contribution' as const, disclosure: 'public' as const };
      const eligibilityScope = `content:search-eligibility:${variant}`;
      await grant(eligibilityScope, 'content.search-eligibility');
      const eligibilityDigest = contentSearchEligibilityDigest(eligibilityInput);
      const registered = await access.register({ principal, actingSubject: actor, scope: eligibilityScope,
        action: 'content.search-eligibility', idempotencyKey: `eligibility-${id}`, requestDigest: eligibilityDigest });
      const claimed = await access.claim(registered.id, eligibilityDigest);
      expect((await selectPublicContentSearch(env, content, access, claimed, eligibilityInput)).outcome).toBe('succeeded');
      const delivery = contentRebuildDelivery(env, content, relayPool, apps.MAIN_RELAY_CONSUMER!);
      await delivery.relayPosition();
      while (await delivery.relayOnce() !== null) { /* retain the Public approval */ }
      const through = await delivery.relayPosition();
      while (await delivery.deliverOnce(through) !== null) { /* acknowledge committed Content ingestion */ }
      let frontier: ContentRebuildFrontier | undefined;
      const prepare = () => prepareContentRebuild({ env, content, delivery, frontier,
        remember: next => { frontier = next; }, assertWritersStopped: async () => undefined });
      const frozen = await prepare();
      expect(frozen.cut).toEqual(await content.ownerPosition());
      expect(await delivery.deliveryPosition()).toBe(frozen.mainSequence);
      const job = await quarantinePublicContentSearch(env, content, id, undefined, frozen.cut);
      expect(BigInt(job.cut.sequence)).toBeGreaterThan(3n);
      const replayedStart = await quarantinePublicContentSearch(env, content, id);
      expect(replayedStart).toEqual(job);
      expect(await clearQuarantinedContentUnits(env, job)).toBe(0);
      expect(await clearQuarantinedContentUnits(env, job)).toBe(0);
      expect(await prepare()).toEqual(frozen);

      // The native maintenance parser must reject unscoped Main-unit deletion.
      const mainUnit = `urn:rezics:main:match-unit:${randomUUID()}`;
      const maliciousReceipt = `urn:rezics:receipt:content-rebuild:clear:${hash(`malicious:${id}`)}`;
      const batch = `urn:rezics:outbox:${hash(`malicious:${id}`)}`;
      const event = `urn:rezics:event:${hash(`malicious:${id}`)}`;
      const attack = { receipt: maliciousReceipt,
        digest: hash('malicious-clear'), validations: [], deadlineMs: 10_000,
        update: `PREFIX rv: <${RV}> DELETE {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(mainUnit)} ?p ?o }
        } INSERT {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(maliciousReceipt)} a rv:OperationReceipt ;
            rv:requestDigest ${lit(hash('malicious-clear'))} ; rv:outcome rv:Succeeded ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence ?next ;
            rv:eventCount 1 ; rv:event ${iri(event)} .
            ${iri(event)} a rv:ContentRebuildEvent ; rv:ordinal 0 ; rv:receipt ${iri(maliciousReceipt)} . }
        } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)}
          rv:dataEpoch ${lit(lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(lineage.routingEpoch)} ; rv:sequence ?n . }
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(mainUnit)} ?p ?o }
          BIND(?n + 1 AS ?next) }` };
      const rejected = await fetch(new URL('command', apps.FUSEKI_URL), {
        method: 'POST', headers: { 'content-type': 'application/json',
          authorization: `Bearer ${apps.FUSEKI_MAINTENANCE_TOKEN}` },
        body: JSON.stringify(attack), signal: AbortSignal.timeout(12_000),
      });
      expect(rejected.status).toBe(400);
      expect((await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(maliciousReceipt)} a rv:OperationReceipt . } }`)).boolean).toBe(false);

      await pool.query(`UPDATE content.revision SET availability = 'erased',
        serialized_bytes = NULL, body = NULL WHERE id = $1`, [saved.revisionId]);
      expect((await content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0]?.status).toBe('erased');
      const restartedCursor = new ContentProjectionCursor(pool);
      await expect(replayQuarantinedContentCut(env, content, restartedCursor, job))
        .rejects.toThrow('terminal publication exact revision unavailable');
      expect((await restartedCursor.read(job.consumer)).sequence).toBe('2');
      await expect(replayQuarantinedContentCut(env, content, new ContentProjectionCursor(pool), job))
        .rejects.toThrow('terminal publication exact revision unavailable');
      await expect(assertPublicTextReady(fuseki, lineage)).rejects.toThrow();
    } finally { await Promise.all([pool.end(), relayPool.end(), accessPool.end()]); }
  } finally {
    if (started) await rootCommand(['stack:reset', '--profile', 'qa', '--run-id', runId], 120_000);
  }
}, qaStartupTestTimeout(240_000));
