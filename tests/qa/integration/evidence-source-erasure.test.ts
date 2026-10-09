import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster } from '../support/postgres-cluster.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { VerificationStore } from '../../../services/main/src/modules/verification/store.ts';
import { assertContentRecoveryCoverage, captureContentRecoveryCoverage,
  graphContentReferences } from '../../../services/main/src/modules/work/content-recovery-coverage.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

// A pre-erasure dump is an ordinary backup, not a destroyed original. Restoring
// it and replaying the same journal entry is what removes the source text.
const root = resolve(import.meta.dir, '../../..');
const canary = 'QUOTE-CANARY-ζ-evidence';
const digest = 'cd'.repeat(32);

async function cluster() {
  const state = join(root, '.temp', `evidence-source-erasure-backup-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const started = await startPostgresCluster();
  const pool = new Pool({ ...started.connection, max: 4 });
  return { pool, connection: started.connection, port: started.port, user: started.user, state, async stop() {
    await pool.end();
    try { started.remove(); }
    finally { rmSync(state, { recursive: true, force: true }); }
  } };
}

function native(id = randomUUID()) { return `https://rezics.com/id/${id}`; }

test('an original backup keeps source text until the same journal entry is replayed', async () => {
  const source = await cluster();
  let restored: Pool | undefined;
  try {
    await migrateContent(source.pool);
    const principal = randomUUID();
    const store = new VerificationStore(source.pool);
    const claim = native();
    const claimRevision = native();
    const cited = randomUUID();
    const variant = `urn:rezics:variant:${randomUUID()}`;
    const bytes = Buffer.from(JSON.stringify({ text: canary }));
    const byteDigest = createHash('sha256').update(bytes).digest('hex');
    await source.pool.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
      VALUES ($1, $2, 'zxx', 'none')`, [variant, `urn:rezics:work:${randomUUID()}`]);
    await source.pool.query(`INSERT INTO content.revision (id, variant_id, operation_id, format, model, provenance,
      byte_digest, byte_length, serialized_bytes, body)
      VALUES ($1, $2, $3, 'rezics-content-json-v1', 'fixture', '{}', $4, $5, $6, $7::jsonb)`,
    [cited, variant, `op-${cited}`, byteDigest, bytes.length, bytes, JSON.stringify({ text: canary })]);
    const recorded = await store.recordEvidence(principal, `evidence-${randomUUID()}`, claim, {
      claimRevision, expectedHead: null, items: [{ stance: 'supports', contentRevision: cited,
        selector: { exact: canary, start: 1, digest }, availability: 'available' }] });
    const evidenceId = recorded.evidence.revision.split('/').at(-1)!;
    const receiptBefore = (await source.pool.query<{ request_digest: string }>(
      `SELECT request_digest FROM verification.receipt WHERE result_id = $1`, [evidenceId])).rows[0]!.request_digest;
    const before = join(source.state, 'before.sql');
    execFileSync('pg_dump', ['-h', '127.0.0.1', '-p', String(source.port), '-U', source.user,
      '-d', 'postgres', '--no-owner', '--no-privileges', '-f', before]);
    const backup = readFileSync(before, 'utf8');
    expect(backup).toContain(canary);
    expect(backup).toContain(receiptBefore);

    const database = `evidence_src_${randomUUID().replaceAll('-', '')}`;
    await source.pool.query(`CREATE DATABASE ${database}`);
    execFileSync('psql', ['-h', '127.0.0.1', '-p', String(source.port), '-U', source.user,
      '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', before], { cwd: source.state, stdio: 'pipe' });
    restored = new Pool({ ...source.connection, database, max: 4 });
    const erasureId = randomUUID();
    const client = await restored.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
        WHERE id = $1 AND availability = 'available'`, [cited]);
      await client.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 9)`, [cited, erasureId]);
      await client.query(`SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 9)`, [[cited], erasureId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }

    const read = await new VerificationStore(restored).readEvidence(evidenceId);
    expect(JSON.stringify(read)).not.toContain(canary);
    expect(read?.items[0]?.selector).toEqual({ start: 1, digest });
    expect(read?.manifestDigest).toBe(recorded.evidence.manifestDigest);
    expect((await restored.query<{ request_digest: string }>(
      `SELECT request_digest FROM verification.receipt WHERE result_id = $1`,
      [evidenceId])).rows[0]?.request_digest).toBe(receiptBefore);
    const after = join(source.state, 'after.sql');
    execFileSync('pg_dump', ['-h', '127.0.0.1', '-p', String(source.port), '-U', source.user,
      '-d', database, '--no-owner', '--no-privileges', '-f', after]);
    expect(readFileSync(after, 'utf8')).not.toContain(canary);
    expect(readFileSync(after, 'utf8')).toContain(receiptBefore);

    const runId = Bun.env.REZICS_QA_RUN_ID;
    const fusekiUrl = Bun.env.FUSEKI_URL;
    if (!runId || !fusekiUrl) throw new Error('signed catalog comparison requires the qualified native stack');
    const databases = await cloneQaOwnerDatabases(runId, ['content']);
    const contentPool = new Pool({ connectionString: databases.urls.content, max: 2 });
    let snapshot: Pool | undefined;
    try {
      await migrateContent(contentPool);
      const fuseki = new FusekiClient(fusekiUrl);
      const references = await graphContentReferences(fuseki);
      const signedRevision = randomUUID();
      const signedVariant = `urn:rezics:variant:${randomUUID()}`;
      const signedBytes = Buffer.from(JSON.stringify({ text: canary }));
      const signedDigest = createHash('sha256').update(signedBytes).digest('hex');
      await contentPool.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
        VALUES ($1, $2, 'zxx', 'none')`, [signedVariant, `urn:rezics:work:${randomUUID()}`]);
      await contentPool.query(`INSERT INTO content.revision (id, variant_id, operation_id, format, model, provenance,
        byte_digest, byte_length, serialized_bytes, body)
        VALUES ($1, $2, $3, 'rezics-content-json-v1', 'fixture', '{}', $4, $5, $6, $7::jsonb)`,
      [signedRevision, signedVariant, `op-${signedRevision}`, signedDigest, signedBytes.length, signedBytes,
        JSON.stringify({ text: canary })]);
      const signedEvidence = await new VerificationStore(contentPool).recordEvidence(randomUUID(),
        `signed-${randomUUID()}`, native(), { claimRevision: native(), expectedHead: null, items: [
          { stance: 'supports', contentRevision: signedRevision,
            selector: { exact: canary, start: 1, digest }, availability: 'available' }] });
      const signedId = signedEvidence.evidence.revision.split('/').at(-1)!;
      const signedCut = await captureContentRecoveryCoverage(contentPool, references);
      const snapshotUrl = await databases.snapshot('content', () => contentPool.end());
      snapshot = new Pool({ connectionString: snapshotUrl, max: 2 });
      await assertContentRecoveryCoverage(snapshot, fuseki, signedCut);
      const signedErasure = randomUUID();
      const signedClient = await snapshot.connect();
      try {
        await signedClient.query('BEGIN');
        await signedClient.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
          WHERE id = $1 AND availability = 'available'`, [signedRevision]);
        await signedClient.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
          VALUES ($1, $2, 9)`, [signedRevision, signedErasure]);
        await signedClient.query(`SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 9)`,
          [[signedRevision], signedErasure]);
        await signedClient.query('COMMIT');
      } catch (error) {
        await signedClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { signedClient.release(); }
      const signedRead = await new VerificationStore(snapshot).readEvidence(signedId);
      expect(JSON.stringify(signedRead)).not.toContain(canary);
      expect(signedRead?.manifestDigest).toBe(signedEvidence.evidence.manifestDigest);
      await expect(assertContentRecoveryCoverage(snapshot, fuseki, signedCut))
        .rejects.toThrow('restored Content owner differs from captured cut');
    } finally {
      await snapshot?.end();
      await contentPool.end().catch(() => undefined);
      await databases.close();
    }
  } finally {
    await restored?.end();
    await source.stop();
  }
}, 90_000);
