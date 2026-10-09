import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentCore } from '../../content/src/core.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { assertContentRecoveryCoverage, captureContentRecoveryCoverage,
  ContentRecoveryConflict, graphContentReferences } from '../src/modules/work/content-recovery-coverage.ts';
import { RV } from '../src/modules/work/activate.ts';

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
