import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrateAccess, qaStack, rootCommand } from '../../../tests/qa/fault-recovery/search-ops-support.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { ContentCore } from '../../content/src/core.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { assertContentRecoveryCoverage, captureContentRecoveryCoverage,
  ContentRecoveryConflict, graphContentReferences } from '../src/modules/work/content-recovery-coverage.ts';
import { GRAPHS, RV, activateMetadataWork, hash, initializeFreshGraph, metadataWorkRequestDigest } from '../src/modules/work/activate.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { S3ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody } from '../src/modules/outbox/receipt-custody.ts';
import { proofRetirementSender } from '../src/modules/graph/slim-command.ts';
import { ensureModelGeneration } from '../src/modules/semantic/command.ts';
import { contentPublicationDigest, publishPinnedContent } from '../src/modules/content-publication/publish.ts';
import { journalErasure, markErasureSuppressed } from '../src/modules/erasure/journal.ts';
import { readGraphErasureProof, suppressGraphContentRevisions } from '../src/modules/erasure/graph.ts';
import { applyContentErasure } from '../src/modules/erasure/content.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../src/modules/outbox/relay.ts';

const recoveryStack = qaStack(`content-recovery-${randomUUID().slice(0, 12)}`);
beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through admitted QA integration');
  await rootCommand(['stack:up', ...recoveryStack.args], 180_000);
}, 600_000);
afterAll(async () => {
  await rootCommand(['stack:reset', ...recoveryStack.args], 120_000);
}, 180_000);

test('OPS03: Content recovery binds exact graph revision, preparation, receipt, outbox and bytes', async () => {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection });
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const variant = { id: 'urn:rezics:variant:recovery', resourceId: 'urn:rezics:work:recovery',
      language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const };
    const first = await content.saveDraft({ operationId: 'recovery-first', variant,
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: '{"body":"first exact body"}' });
    const exact = (await content.readExactBatch([first.revisionId!], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('test Content body unavailable');
    const preparation = await content.preparePublication('recovery-prepare', first.revisionId!,
      exact.reference.byteDigest);
    const graph = { graph: 'urn:rezics:graph:receipts', subject: 'urn:rezics:receipt:publication',
      revisionId: first.revisionId!, byteDigest: exact.reference.byteDigest,
      preparationId: preparation.operationId, ownerEpoch: preparation.position.dataEpoch,
      ownerSequence: preparation.position.sequence };
    const fuseki = { query: async () => ({ results: { bindings: [{
      graph: { type: 'uri', value: graph.graph }, subject: { type: 'uri', value: graph.subject },
      predicate: { type: 'uri', value: `${RV}contentRevision` },
      object: { type: 'uri', value: `urn:rezics:content:revision:${graph.revisionId}` },
      digest: { type: 'literal', value: graph.byteDigest },
      preparation: { type: 'literal', value: graph.preparationId },
      epoch: { type: 'literal', value: graph.ownerEpoch },
      sequence: { type: 'literal', value: graph.ownerSequence },
    }] } }) } as unknown as FusekiClient;
    const references = await graphContentReferences(fuseki);
    const captured = await captureContentRecoveryCoverage(pool, references);
    expect(captured.graphReferencesCount).toBe('1');
    expect(captured.tables['content.publication_preparation']?.count).toBe('1');
    expect(captured.tables['content.receipt']?.count).toBe('2');
    expect(captured.tables['content.outbox']?.count).toBe('2');
    await expect(assertContentRecoveryCoverage(pool, fuseki, captured)).resolves.toBeUndefined();
    const originalDigest = graph.byteDigest;
    graph.byteDigest = '0'.repeat(64);
    await expect(assertContentRecoveryCoverage(pool, fuseki, captured))
      .rejects.toThrow('restored graph Content references differ from captured cut');
    graph.byteDigest = originalDigest;
    const unavailableRevision = crypto.randomUUID();
    await expect(captureContentRecoveryCoverage(pool, [{ ...references[0]!,
      object: `urn:rezics:content:revision:${unavailableRevision}` }]))
      .rejects.toThrow(`exact Content revision is unavailable: ${unavailableRevision}`);

    await pool.query('ALTER TABLE content.outbox DISABLE TRIGGER outbox_immutable');
    const missingEvent = (await pool.query(
      'DELETE FROM content.outbox WHERE operation_id = $1 RETURNING *, created_at::text AS created_at_exact',
      [preparation.operationId])).rows[0];
    await expect(assertContentRecoveryCoverage(pool, fuseki, captured))
      .rejects.toThrow(`Content preparation, receipt or outbox is unavailable: ${preparation.operationId}`);
    await pool.query(`INSERT INTO content.outbox
      (id, data_epoch, sequence, operation_id, event_type, recipe, revision_id, payload, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [missingEvent.id, missingEvent.data_epoch, missingEvent.sequence,
      missingEvent.operation_id, missingEvent.event_type, missingEvent.recipe,
      missingEvent.revision_id, missingEvent.payload, missingEvent.created_at_exact]);
    await expect(assertContentRecoveryCoverage(pool, fuseki, captured)).resolves.toBeUndefined();

    // The captured graph refers to the original revision; a different Content cut is held.
    await content.saveDraft({ operationId: 'recovery-after-cut', variant,
      expectedHead: first.revisionId!, model: 'content-shape-v1', sourceRevision: null,
      provenance: {}, serializedJson: '{"body":"newer unused body"}' });
    await expect(assertContentRecoveryCoverage(pool, fuseki, captured))
      .rejects.toThrow('restored Content owner differs from captured cut');
    const newerCut = await captureContentRecoveryCoverage(pool, references);
    await expect(assertContentRecoveryCoverage(pool, fuseki, newerCut)).resolves.toBeUndefined();

    // A package receipt added after the signed Content cut must keep restore held.
    await pool.query(`INSERT INTO pkg.cargo_resolution
      (id, principal_id, idempotency_key, request_digest, request, outcome)
      VALUES ($1,$2,$3,$4,$5,$6)`,
    [crypto.randomUUID(), crypto.randomUUID(), 'recovery-cargo', 'a'.repeat(64),
      JSON.stringify({ profile: 'fixture' }), JSON.stringify({ status: 'solved' })]);
    await expect(assertContentRecoveryCoverage(pool, fuseki, newerCut))
      .rejects.toThrow('restored Content owner differs from captured cut');
    const packageCut = await captureContentRecoveryCoverage(pool, references);
    expect(packageCut.version).toBe(5);
    expect(packageCut.tables['pkg.cargo_resolution']?.count).toBe('1');
    await expect(assertContentRecoveryCoverage(pool, fuseki, packageCut)).resolves.toBeUndefined();

    // A restored revision anchor without its exact bytes never qualifies for release.
    await pool.query('ALTER TABLE content.revision DISABLE TRIGGER revision_immutable');
    await pool.query(`UPDATE content.revision SET availability = 'unavailable',
      serialized_bytes = NULL, body = NULL WHERE id = $1`, [first.revisionId]);
    await expect(assertContentRecoveryCoverage(pool, fuseki, packageCut))
      .rejects.toBeInstanceOf(ContentRecoveryConflict);
  } finally {
    await pool.end();
    cluster.remove();
  }
}, 30_000);

test('OPS12: retained erased publication pins refuse all-null digests while native outbox nulls recover', async () => {
  const started = performance.now();
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through admitted QA integration');
  const stack = recoveryStack;
  const root = resolve(import.meta.dir, '../../..');
  let accessPool: Pool | undefined, contentPool: Pool | undefined, relay: Pool | undefined;
  let phase = 'Access migrations';
  try {
    const apps = stack.apps, fuseki = stack.fuseki;
    await migrateAccess(apps.ACCESS_DATABASE_URL!);
    accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
    relay = new Pool({ connectionString: apps.MAIN_RELAY_DATABASE_URL });
    phase = 'Content migrations';
    await migrateContent(contentPool);
    phase = 'relay migrations';
    for (const file of schemaFiles(root, 'relay'))
      await relay.query(readFileSync(resolve(root, 'services/main/migrations/relay', file), 'utf8'));
    const objects = new S3ImmutableObjects({ endpoint: apps.MAIN_S3_ENDPOINT!, bucket: apps.MAIN_S3_BUCKET!,
      region: apps.MAIN_S3_REGION, accessKeyId: apps.MAIN_S3_ACCESS_KEY!, secretAccessKey: apps.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/work/' });
    phase = 'object storage readiness';
    await objects.initialize();
    const access = new AccessAdmissionRegistry(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY);
    access.configureBaseline(fuseki);
    const custody = new ReceiptCustody(new PostgresReceiptCustodyStore(accessPool), objects, fuseki,
      apps.FUSEKI_TITLE_ADMISSION_KEY!, proofRetirementSender(apps.FUSEKI_URL!, apps.FUSEKI_COMMAND_TOKEN!));
    const env = { fuseki, receiptCustody: custody, workObjects: objects, objectDirectory: apps.MAIN_OBJECT_DIRECTORY!,
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! } };
    phase = 'fresh graph initialization';
    await initializeFreshGraph(fuseki, env.lineage);
    phase = 'model generation';
    await ensureModelGeneration(env);
    const content = new ContentCore(contentPool);
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const title = 'Retained erased publication';
    const createAdmission: RegisteredAdmission = { id: randomUUID(), principalId: randomUUID(), actingSubject: actor,
      scope: 'work:create:root', action: 'work.create', idempotencyKey: randomUUID(),
      requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 600_000).toISOString(), state: 'claimed', dispatchEligible: true, replayed: false };
    phase = 'metadata Work activation';
    const work = await activateMetadataWork(env, { title, admission: createAdmission });
    const variant = { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work.work!,
      language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const };
    const saved = await content.saveDraft({ operationId: `recovery-draft:${randomUUID()}`, variant,
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: '{"body":"erased publication bytes"}' });
    const revisionId = saved.revisionId!;
    const exact = (await content.readExactBatch([revisionId], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('Publication bytes unavailable');
    const input = { preparationId: `recovery-publish:${randomUUID()}`, revisionId,
      expectedDigest: exact.reference.byteDigest, expectedContentEpoch: saved.position.dataEpoch,
      resourceId: work.work!, variantId: variant.id, expectedPublicationHead: null };
    const admission: RegisteredAdmission = { ...createAdmission, id: randomUUID(), idempotencyKey: randomUUID(),
      scope: `content:publish:${variant.id}`, action: 'content.publish', requestDigest: contentPublicationDigest(input) };
    phase = 'Content publication';
    const publication = await publishPinnedContent(env, content, admission, input);
    expect(publication.status).toBe('active');
    const second = await content.preparePublication(`recovery-second:${randomUUID()}`, revisionId, input.expectedDigest);
    await content.settlePublication(`recovery-second-settle:${randomUUID()}`, second.operationId,
      { outcome: 'active', revisionId, receipt: publication.receipt,
        dataEpoch: publication.graphDataEpoch!, sequence: publication.graphSequence! });
    const other = await content.saveDraft({ operationId: `recovery-other:${randomUUID()}`,
      variant: { ...variant, id: `urn:rezics:variant:${randomUUID()}` }, expectedHead: null,
      model: 'content-shape-v1', sourceRevision: null, provenance: {}, serializedJson: '{"body":"other revision"}' });
    const otherExact = (await content.readExactBatch([other.revisionId!], async ids => new Set(ids)))[0];
    if (otherExact?.status !== 'available') throw new Error('Other revision bytes unavailable');
    const foreign = await content.preparePublication(`recovery-other-prepare:${randomUUID()}`,
      other.revisionId!, otherExact.reference.byteDigest);
    phase = 'publication custody retention';
    const consumer = `recovery-erased:${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, env.lineage.dataEpoch);
    while (await relayMainOutboxOnce(fuseki, relay, consumer)) { /* retain native custody */ }
    const entry = await journalErasure(relay, { operationId: `recovery-erase:${randomUUID()}`,
      requestDigest: hash(revisionId), kind: 'revision',
      principalId: admission.principalId, admissionId: randomUUID(), authorityEpoch: '0',
      targets: [{ kind: 'content_revision', ref: revisionId }] });
    phase = 'graph and native Content erasure';
    await suppressGraphContentRevisions(fuseki, env.lineage, entry.erasureId, entry.erasureEpoch, [revisionId]);
    const originalProof = await readGraphErasureProof(fuseki, env.lineage, entry.erasureId, entry.erasureEpoch, [revisionId]);
    expect((await relayMainOutboxOnce(fuseki, relay, consumer))?.eventIds).toHaveLength(1);
    expect(await applyContentErasure(contentPool, { preservationAccess: accessPool,
      erasureId: entry.erasureId, erasureEpoch: entry.erasureEpoch, resourceId: work.work!,
      revisionIds: [revisionId], graphProof: originalProof })).toEqual({ applied: 1 });
    await markErasureSuppressed(relay, entry.erasureId);
    expect((await contentPool.query('SELECT availability,serialized_bytes,body,byte_digest FROM content.revision WHERE id=$1',
      [revisionId])).rows).toEqual([{ availability: 'erased', serialized_bytes: null, body: null,
      byte_digest: input.expectedDigest }]);
    expect((performance.now() - started) / 1000).toBeLessThan(600);
    phase = 'capture and restore qualification';
    const references = await graphContentReferences(fuseki);
    const pins = references.filter(pin => pin.predicate === `${RV}contentRevision`
      && pin.object === `urn:rezics:content:revision:${revisionId}`);
    expect(pins.filter(pin => pin.graph === GRAPHS.receipts && pin.byteDigest === input.expectedDigest).length).toBeGreaterThan(0);
    expect(pins.filter(pin => pin.graph === GRAPHS.revisions && pin.byteDigest === input.expectedDigest).length).toBeGreaterThan(0);
    const nativePin = pins.find(pin => pin.graph === GRAPHS.outbox && pin.byteDigest === null)!;
    expect(nativePin).toBeDefined();
    expect(pins.filter(pin => pin.byteDigest === null).every(pin => pin.graph === GRAPHS.outbox)).toBe(true);
    const relayClient = await relay.connect(), contentClient = await contentPool.connect();
    try {
      await relayClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await relayClient.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch',0))");
      await contentClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const context = { fuseki, relayClient, contentClient };
      const captured = await captureContentRecoveryCoverage(contentPool, references, context);
      await expect(assertContentRecoveryCoverage(contentPool, fuseki, captured, context)).resolves.toBeUndefined();
      // Keep the exact independently owned stimulus: every retained pin loses its digest.
      const probes = [{ stimulus: 'all-null', references: pins.map(pin => ({ ...pin, byteDigest: null })) },
        ...[GRAPHS.receipts, GRAPHS.revisions].map(graph => ({ stimulus: graph,
          references: pins.map(pin => pin.graph === graph ? { ...pin, byteDigest: null } : pin) }))];
      const outcomes: { stimulus: string; accepted: boolean; evidence: unknown }[] = [];
      for (const probe of probes) {
        try {
          outcomes.push({ stimulus: probe.stimulus, accepted: true,
            evidence: await captureContentRecoveryCoverage(contentPool, probe.references, context) });
        } catch (evidence) { outcomes.push({ stimulus: probe.stimulus, accepted: false, evidence }); }
      }
      console.info('Erased Content missing digest evidence:', JSON.stringify({ pins, originalProof,
        dataEpoch: captured.dataEpoch, sequence: captured.sequence,
        graphReferencesCount: captured.graphReferencesCount, graphReferencesDigest: captured.graphReferencesDigest,
        outcomes: outcomes.map(outcome => ({ stimulus: outcome.stimulus, accepted: outcome.accepted,
          evidence: outcome.evidence instanceof Error
            ? { type: outcome.evidence.constructor.name, message: outcome.evidence.message } : outcome.evidence })) }));
      for (const outcome of outcomes) {
        expect(outcome.accepted, outcome.stimulus).toBe(false);
        expect(outcome.evidence, outcome.stimulus).toBeInstanceOf(ContentRecoveryConflict);
      }
      const historicalPin = { ...nativePin, preparationId: second.operationId,
        ownerEpoch: second.position.dataEpoch, ownerSequence: second.position.sequence };
      await expect(captureContentRecoveryCoverage(contentPool, pins.map(pin => pin === nativePin ? historicalPin : pin), context))
        .resolves.toBeDefined();
      const conflicts = [{ ...nativePin, preparationId: foreign.operationId },
        { ...nativePin, ownerEpoch: randomUUID(), ownerSequence: second.position.sequence },
        { ...nativePin, ownerEpoch: second.position.dataEpoch, ownerSequence: (BigInt(captured.sequence) + 1n).toString() }];
      for (const conflict of conflicts) {
        await expect(captureContentRecoveryCoverage(contentPool, pins.map(pin => pin === nativePin ? conflict : pin), context))
          .rejects.toBeInstanceOf(ContentRecoveryConflict);
      }
      expect(await captureContentRecoveryCoverage(contentPool, references, context)).toEqual(captured);
      console.info('Erased Content recovery controls:', JSON.stringify({
        historicalPin, conflicts, preparationSeconds: (performance.now() - started) / 1000 }));
    } finally {
      await contentClient.query('ROLLBACK'); contentClient.release();
      await relayClient.query('ROLLBACK'); relayClient.release();
    }
  } catch (error) {
    throw new Error(`Erased Content recovery failed during ${phase}`, { cause: error });
  } finally {
    await Promise.allSettled([accessPool?.end(), contentPool?.end(), relay?.end()]);
  }
}, 120_000);
