import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { VerificationStore } from '../../../services/main/src/modules/verification/store.ts';

// A pre-erasure dump is an ordinary backup, not a destroyed original. Restoring
// it and replaying the same journal entry is what removes the source text.
const root = resolve(import.meta.dir, '../../..');
const canary = 'QUOTE-CANARY-ζ-evidence';
const digest = 'cd'.repeat(32);

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function cluster() {
  const state = join(root, '.temp', `evidence-source-erasure-backup-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  const port = await freePort();
  const user = process.env.USER ?? execFileSync('whoami', { encoding: 'utf8' }).trim();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user, database: 'postgres', max: 4 });
  return { pool, port, user, state, async stop() {
    await pool.end();
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
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
    restored = new Pool({ host: '127.0.0.1', port: source.port, user: source.user, database, max: 4 });
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
  } finally {
    await restored?.end();
    await source.stop();
  }
}, 90_000);
