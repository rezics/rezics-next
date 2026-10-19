import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { schemaFiles } from '../../../../scripts/qa/schema-files.ts';
import { startPostgresCluster } from '../../../../tests/qa/support/postgres-cluster.ts';
import { migrateContent } from '../../../content/src/index.ts';
import { boundedPool } from '../../src/infrastructure/pg-pool.ts';
import type { ImmutableObjects } from '../../src/infrastructure/immutable-objects.ts';

export const evidenceDigest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Isolated owner-test persistence. This is not a stack or delivery fixture. */
export async function retainedEvidenceFixture(database: string) {
  const cluster = await startPostgresCluster();
  const admin = boundedPool(cluster.connection);
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = boundedPool({ ...cluster.connection, database, max: 8 });
  try {
    await migrateContent(pool);
    const root = resolve(import.meta.dir, '../../../..');
    for (const file of schemaFiles(root, 'access')) {
      try { await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8')); }
      catch (cause) { throw new Error(`Access owner fixture migration failed: ${file}`, { cause }); }
    }
  } catch (error) {
    await pool.end(); await admin.end(); cluster.remove(); throw error;
  }
  // Rights prepares its Content transaction before Access fences the commit.
  // Keep the owners' checkouts separate, as in deployed composition.
  const accessPool = boundedPool({ ...cluster.connection, database, max: 4 });
  const bodies = new Map<string, Uint8Array>();
  let puts = 0;
  const objects = (namespace: string): ImmutableObjects => ({
    async put(bytes) {
      puts++;
      const digest = evidenceDigest(bytes);
      bodies.set(`${namespace}${digest}`, Uint8Array.from(bytes));
      return digest;
    },
    async get(digest, maxBytes) {
      const bytes = bodies.get(`${namespace}${digest}`);
      if (!bytes || maxBytes !== undefined && bytes.length > maxBytes) throw new Error('object unavailable');
      return Uint8Array.from(bytes);
    },
  });
  return { pool, accessPool, bodies, objects, get puts() { return puts; }, async close() {
    await pool.end(); await accessPool.end(); await admin.end(); cluster.remove();
  } };
}
