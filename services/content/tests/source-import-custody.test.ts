import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateContent } from '../src/migrate.ts';
import { SourceIntakeStore } from '../../main/src/modules/source/intake.ts';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const root = resolve(import.meta.dir, '../../..');
async function revision(pool: Pool, resource: string, observation?: { observation: string; byteDigest: string | null }) {
  const id = randomUUID(), variant = `urn:rezics:variant:${randomUUID()}`;
  const bytes = Buffer.from('{"text":"private import"}');
  await pool.query(`INSERT INTO content.variant (id,resource_id,language_kind,direction) VALUES ($1,$2,'zxx','none')`, [variant,resource]);
  await pool.query(`INSERT INTO content.revision
    (id,variant_id,operation_id,format,model,source_revision,provenance,byte_digest,byte_length,serialized_bytes,body)
    VALUES ($1,$2,$3,'rezics-content-json-v1','fixture',$4,$5,$6,$7,$8,$9)`,
  [id,variant,randomUUID(),observation?.observation ?? null,JSON.stringify(observation ? {
    kind: 'admitted-private-import-v1', sourceObservation: observation.observation, sourceDigest: observation.byteDigest,
  } : {}),createHash('sha256').update(bytes).digest('hex'),bytes.length,bytes,bytes.toString()]);
  return id;
}
async function source(store: SourceIntakeStore, principal: string) {
  return (await store.submit(principal, randomUUID(), { provider: 'second-consumer', namespace: 'private-file',
    externalId: randomUUID(), sourceRevision: 'exact-external-version', mediaType: 'application/json',
    retention: 'retained', rawBytesBase64: Buffer.from('{"secret":"retained source"}').toString('base64'),
    coverage: { scope: 'private-file', complete: true, omittedFields: [] },
    rightsEvidence: { basis: 'unknown', note: 'Import grants no publication rights.' },
  })).observation;
}
async function erase(pool: Pool, revisionId: string, erasureId: string, epoch: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL WHERE id = $1`, [revisionId]);
    await client.query(`INSERT INTO content.revision_erasure (revision_id,erasure_id,erasure_epoch)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [revisionId,erasureId,epoch]);
    await client.query('SELECT verification.erase_evidence_sources($1::uuid[],$2::uuid,$3::bigint)', [[revisionId],erasureId,epoch]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

test('custody validates the exact owner revision, retains independent evidence and repairs interrupted binding', async () => {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 2 });
  try {
    await migrateContent(pool);
    const store = new SourceIntakeStore(pool), principal = randomUUID(), resource = native();
    const imported = await source(store, principal), independent = await source(store, principal);
    const importedId = imported.observation.slice(-36);
    const importedRevision = await revision(pool, resource, imported);
    const unrelatedRevision = await revision(pool, resource);
    const binding = { resourceId: resource, revisionId: importedRevision, contentRevisionId: importedRevision };
    await expect(store.bindImportCustody(randomUUID(), imported.observation, binding)).rejects.toThrow('admitted import');
    await expect(store.bindImportCustody(principal, imported.observation, { ...binding, resourceId: native() }))
      .rejects.toMatchObject({ code: '23514' });
    await expect(store.bindImportCustody(principal, independent.observation, binding))
      .rejects.toMatchObject({ code: '23514' });
    await store.bindImportCustody(principal, imported.observation, binding);
    await store.bindImportCustody(principal, imported.observation, binding);
    const imageRevision = await revision(pool, resource, imported);
    await store.bindImportCustody(principal, imported.observation, {
      resourceId: resource, revisionId: imageRevision, contentRevisionId: imageRevision,
    });
    expect((await pool.query('SELECT revision_id FROM source.import_custody WHERE observation_id = $1', [importedId])).rows)
      .toHaveLength(2);
    await expect(pool.query('UPDATE source.import_custody SET resource_id = $2 WHERE observation_id = $1', [importedId,native()]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('DELETE FROM source.import_custody WHERE observation_id = $1', [importedId]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE source.observation SET retention = 'not-retained',raw_bytes = NULL,byte_digest = NULL,
      source_erasure_id = $2,source_erasure_epoch = 1 WHERE id = $1`, [importedId,randomUUID()]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('SELECT verification.open_evidence_source_revisions($1::uuid[])', [Array.from({ length: 257 }, () => importedRevision)]))
      .rejects.toMatchObject({ code: '23514' });
    await erase(pool, unrelatedRevision, randomUUID(), '1');
    expect((await store.read(principal, importedId))?.rawBytesBase64).toBe(imported.rawBytesBase64);
    const erasure = randomUUID();
    await erase(pool, importedRevision, erasure, '2');
    expect((await store.read(principal, importedId))?.retention).toBe('not-retained');
    expect((await store.read(principal, independent.observation.slice(-36)))?.rawBytesBase64).toBe(independent.rawBytesBase64);
    await store.bindImportCustody(principal, imported.observation, binding);
    await expect(store.bindImportCustody(principal, imported.observation, { ...binding, resourceId: native() }))
      .rejects.toThrow('changed intent');

    // Import's Content commit survived, but custody registration did not. The
    // winning erasure's identity must be reused when the import resumes.
    const interrupted = await source(store, principal);
    const interruptedRevision = await revision(pool, native(), interrupted);
    const interruptedResource = (await pool.query(`SELECT resource_id FROM content.variant v JOIN content.revision r ON r.variant_id = v.id WHERE r.id = $1`, [interruptedRevision])).rows[0]!.resource_id;
    const interruptedErasure = randomUUID();
    await erase(pool, interruptedRevision, interruptedErasure, '3');
    await store.bindImportCustody(principal, interrupted.observation, { resourceId: interruptedResource,
      revisionId: interruptedRevision, contentRevisionId: interruptedRevision });
    expect((await pool.query(`SELECT retention,source_erasure_id::text,source_erasure_epoch::text
      FROM source.observation WHERE id = $1`, [interrupted.observation.slice(-36)])).rows[0]).toEqual({
      retention: 'not-retained', source_erasure_id: interruptedErasure, source_erasure_epoch: '3' });
  } finally { await pool.end(); cluster.remove(); }
});

test('the migration backfills established file custody and owner-proved collection custody', async () => {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 2 });
  const directory = resolve('.temp', `source-custody-migrations-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  try {
    const migrations = join(root, 'services/content/migrations');
    for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql') && file !== '2601_source_import_custody.sql')) {
      symlinkSync(join(migrations, file), join(directory, file));
    }
    await migrateContent(pool, directory);
    const store = new SourceIntakeStore(pool), principal = randomUUID();
    const work = native(), fileRevision = await revision(pool, work);
    const file = (await store.submit(principal, randomUUID(), { provider: 'rezics',namespace: 'recipe-file',externalId: work,
      sourceRevision: native(), mediaType: 'application/json',retention: 'retained',rawBytesBase64: Buffer.from('{}').toString('base64'),
      coverage: { scope: 'file',complete: true,omittedFields: [] },rightsEvidence: { basis: 'unknown',note: 'Private file.' },
    })).observation;
    const collection = await source(store, principal), collectionResource = native();
    const collectionRevision = await revision(pool, collectionResource, collection);
    const shared = await source(store, principal);
    await revision(pool, native(), shared);
    await revision(pool, native(), shared);
    await migrateContent(pool);
    expect((await pool.query('SELECT 1 FROM source.import_custody WHERE observation_id = $1', [shared.observation.slice(-36)])).rows).toEqual([]);
    expect((await store.read(principal, shared.observation.slice(-36)))?.rawBytesBase64).toBe(shared.rawBytesBase64);
    const rows = (await pool.query(`SELECT observation_id::text,resource_id,revision_id,content_revision_id::text
      FROM source.import_custody WHERE observation_id = ANY($1::uuid[]) ORDER BY resource_id`,
    [[file.observation.slice(-36),collection.observation.slice(-36)]])).rows;
    expect(rows).toContainEqual({ observation_id: file.observation.slice(-36),resource_id: work,
      revision_id: file.sourceRevision,content_revision_id: null });
    expect(rows).toContainEqual({ observation_id: collection.observation.slice(-36),resource_id: collectionResource,
      revision_id: collectionRevision,content_revision_id: collectionRevision });
    await erase(pool, fileRevision, randomUUID(), '1');
    await erase(pool, collectionRevision, randomUUID(), '2');
    expect((await store.read(principal, file.observation.slice(-36)))?.retention).toBe('not-retained');
    expect((await store.read(principal, collection.observation.slice(-36)))?.retention).toBe('not-retained');
  } finally { await pool.end(); cluster.remove(); rmSync(directory, { recursive: true, force: true }); }
});
