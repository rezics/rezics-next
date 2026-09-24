import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { contentPublicationDigest, publishPinnedContent, type PublishPinnedContentInput }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { clearQuarantinedContentUnits,
  quarantinePublicContentSearch, replayQuarantinedContentCut }
  from '../../../services/main/src/modules/content-publication/rebuild.ts';
import { activateMetadataWork, metadataWorkRequestDigest,
  DATASET, GRAPHS, RV, hash, initializeFreshGraph, iri, lit }
  from '../../../services/main/src/modules/work/activate.ts';
import { assertPublicTextReady } from '../../../services/main/src/modules/work/search-readiness.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';

const root = resolve(import.meta.dir, '../../..');

function rootCommand(args: string[], timeout: number): void {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 2_000_000 });
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
    rootCommand(['stack:up', '--profile', 'qa', '--run-id', runId], 180_000);
    const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    await initializeFreshGraph(fuseki, lineage);
    const pool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 4 });
    try {
      await migrateContent(pool);
      const content = new ContentCore(pool);
      const cursor = new ContentProjectionCursor(pool);
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
      const saved = await content.saveDraft({ operationId: `draft-${id}`,
        variant: { id: variant, resourceId: resource,
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
        expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
        provenance: { fixture: 'erasure-rebuild' }, serializedJson: '{"body":"erased source must stay hidden"}' });
      if (!saved.revisionId) throw new Error('draft fixture has no revision');
      const exact = (await content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
      if (exact?.status !== 'available') throw new Error('draft fixture bytes are unavailable');
      const publicationInput: PublishPinnedContentInput = { preparationId: `prepare-${id}`,
        revisionId: saved.revisionId, expectedDigest: exact.reference.byteDigest,
        expectedContentEpoch: saved.position.dataEpoch, resourceId: resource,
        variantId: variant, expectedPublicationHead: null };
      const publicationAdmissionId = randomUUID();
      const admission: RegisteredAdmission = { id: publicationAdmissionId,
        principalId: randomUUID(), actingSubject: `https://rezics.com/id/${randomUUID()}`,
        scope: `content:publish:${variant}`, action: 'content.publish',
        idempotencyKey: `rebuild-publish-${id}`,
        requestDigest: contentPublicationDigest(publicationInput), authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'registered', dispatchEligible: true, replayed: false };
      const published = await publishPinnedContent(env, content, admission, publicationInput);
      expect(published.status).toBe('active');
      expect(published.graphSequence).toBeTruthy();
      const job = await quarantinePublicContentSearch(env, content, id);
      expect(job.cut.sequence).toBe('3');
      const replayedStart = await quarantinePublicContentSearch(env, content, id);
      expect(replayedStart).toEqual(job);
      expect(await clearQuarantinedContentUnits(env, job)).toBe(0);
      expect(await clearQuarantinedContentUnits(env, job)).toBe(0);

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
    } finally { await pool.end(); }
  } finally {
    if (started) rootCommand(['stack:reset', '--profile', 'qa', '--run-id', runId], 120_000);
  }
}, 240_000);
