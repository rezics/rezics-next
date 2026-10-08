import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateContent } from '../../content/src/migrate.ts';
import { RV } from '../src/modules/work/activate.ts';
import { VerificationStore } from '../src/modules/verification/store.ts';
import { claimRoutes } from '../src/routes/claims.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const root = resolve(import.meta.dir, '../../..');
const canary = 'QUOTE-CANARY-ζ-evidence';
const digest = 'ab'.repeat(32);

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
  const state = join(root, '.temp', `evidence-source-erasure-api-${randomUUID()}`);
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
  return { pool, async stop() {
    await pool.end();
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
    finally { rmSync(state, { recursive: true, force: true }); }
  } };
}

function native(id: string = randomUUID()) { return `https://rezics.com/id/${id}`; }

const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });

async function revision(pool: Pool, text: string) {
  const id = randomUUID();
  const variant = `urn:rezics:variant:${randomUUID()}`;
  const bytes = Buffer.from(JSON.stringify({ text }));
  const byteDigest = createHash('sha256').update(bytes).digest('hex');
  await pool.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
    VALUES ($1, $2, 'zxx', 'none')`, [variant, `urn:rezics:work:${randomUUID()}`]);
  await pool.query(`INSERT INTO content.revision (id, variant_id, operation_id, format, model, provenance,
    byte_digest, byte_length, serialized_bytes, body)
    VALUES ($1, $2, $3, 'rezics-content-json-v1', 'fixture', '{}', $4, $5, $6, $7::jsonb)`,
  [id, variant, `op-${id}`, byteDigest, bytes.length, bytes, JSON.stringify({ text })]);
  return id;
}

async function observation(pool: Pool, principal: string) {
  const record = randomUUID();
  const id = randomUUID();
  await pool.query(`INSERT INTO source.record (id, provider, namespace, external_id)
    VALUES ($1, 'fixture', 'work', $2)`, [record, record]);
  await pool.query(`INSERT INTO source.observation (id, record_id, principal_id, media_type, retention,
    coverage, rights_evidence) VALUES ($1, $2, $3, 'application/json', 'not-retained', '{}', '{}')`,
  [id, record, principal]);
  return id;
}

function routes(pool: Pool, principal: string, claim: string, claimRevision: string, active: () => boolean) {
  const environment = { fuseki: { query: async (sparql: string) => {
    if (sparql.includes('rv:StatementRevision')) return { results: { bindings: [] } };
    return { results: { bindings: [{
      revision: uri(claimRevision), claim: uri(native(claim)), head: uri(claimRevision),
      referent: uri('urn:rezics:referent:evidence-source'),
      context: uri('urn:rezics:context:evidence-source'),
      predicate: uri('urn:rezics:predicate:evidence-source'),
      value: uri('urn:rezics:value:evidence-source'),
      precision: uri(`${RV}ExactValue`), status: uri(`${RV}Asserted`),
      statedBy: uri(native()), recordedAt: literal('2026-10-08T00:00:00Z'),
      epoch: literal('1'), sequence: literal('1'),
    }] } };
  } } };
  return claimRoutes({
    environment, verification: new VerificationStore(pool),
    account: { verify: async () => ({ issuer: 'https://account.example', subject: principal }) },
    access: { activePrincipalId: async () => active() ? principal : null },
  } as unknown as MainWorkDependencies);
}

async function postEvidence(app: ReturnType<typeof claimRoutes>, claim: string, key: string, body: unknown) {
  return app.handle(new Request(`http://localhost/v1/claims/${claim}/evidence`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  }));
}

test('the evidence API admits a content-bound selector and returns no source text after its journaled clear', async () => {
  const source = await cluster();
  try {
    await migrateContent(source.pool);
    const principal = randomUUID();
    const other = randomUUID();
    const claim = randomUUID();
    const claimRevision = native();
    const cited = await revision(source.pool, canary);
    const observed = await observation(source.pool, principal);
    let active = true;
    const app = routes(source.pool, principal, claim, claimRevision, () => active);
    const quote = { profile: 'claim-evidence-v1', claimRevision, expectedHead: null, items: [
      { stance: 'supports', contentRevision: cited, selector: { quote: canary, start: 4, digest },
        availability: 'available' }] };
    const key = `evidence-${randomUUID()}`;
    const created = await postEvidence(app, claim, key, quote);
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { replayed: boolean; evidence: { revision: string;
      manifestDigest: string; items: { selector: Record<string, unknown> }[] } };
    expect(createdBody.replayed).toBe(false);
    expect(JSON.stringify(createdBody)).toContain(canary);
    expect(createdBody.evidence.items[0]?.selector).toMatchObject({ quote: canary, start: 4, digest });
    const evidenceId = createdBody.evidence.revision.split('/').at(-1)!;
    const manifestBefore = createdBody.evidence.manifestDigest;
    const receiptBefore = (await source.pool.query<{ request_digest: string }>(
      `SELECT request_digest FROM verification.receipt WHERE result_id = $1 AND action = 'evidence.record'`,
      [evidenceId])).rows[0]!.request_digest;

    const rejected = await postEvidence(app, claim, `bad-${randomUUID()}`, { profile: 'claim-evidence-v1',
      claimRevision, expectedHead: evidenceId, items: [{ stance: 'supports', contentRevision: cited,
        selector: { kind: 'whole' }, availability: 'available' }] });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(rejected.status).not.toBe(201);

    active = false;
    const denied = await postEvidence(app, claim, `denied-${randomUUID()}`, { profile: 'claim-evidence-v1',
      claimRevision, expectedHead: evidenceId, items: [{ stance: 'uncertain', observation: observed,
        selector: { field: 'releaseDate' }, availability: 'available' }] });
    expect(denied.status).toBe(403);
    active = true;
    const observedEvidence = await postEvidence(app, claim, `observed-${randomUUID()}`, {
      profile: 'claim-evidence-v1', claimRevision, expectedHead: evidenceId, items: [
        { stance: 'uncertain', observation: observed, selector: { field: 'releaseDate' },
          availability: 'available' }] });
    expect(observedEvidence.status).toBe(201);
    expect(JSON.stringify(await observedEvidence.json())).toContain('releaseDate');

    const erasureId = randomUUID();
    const client = await source.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
        WHERE id = $1 AND availability = 'available'`, [cited]);
      await client.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 3)`, [cited, erasureId]);
      await client.query(`SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 3)`, [[cited], erasureId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }

    const read = await app.handle(new Request(`http://localhost/v1/claims/${claim}/evidence/${evidenceId}`));
    expect(read.status).toBe(200);
    const readBody = await read.json() as { manifestDigest: string; items: { selector: Record<string, unknown> }[] };
    expect(JSON.stringify(readBody)).not.toContain(canary);
    expect(readBody.items[0]?.selector).toEqual({ start: 4, digest });
    expect(readBody.manifestDigest).toBe(manifestBefore);
    const retried = await postEvidence(app, claim, key, quote);
    expect(retried.status).toBe(200);
    const retriedBody = await retried.json() as { replayed: boolean };
    expect(retriedBody.replayed).toBe(true);
    expect(JSON.stringify(retriedBody)).not.toContain(canary);
    expect((await source.pool.query<{ request_digest: string }>(
      `SELECT request_digest FROM verification.receipt WHERE result_id = $1`,
      [evidenceId])).rows[0]?.request_digest).toBe(receiptBefore);

    const hidden = claimRoutes({
      environment: { fuseki: { query: async () => ({ results: { bindings: [] } }) } },
      verification: new VerificationStore(source.pool),
      account: { verify: async () => ({ issuer: 'https://account.example', subject: other }) },
      access: { activePrincipalId: async () => other },
    } as unknown as MainWorkDependencies);
    const otherRead = await hidden.handle(new Request(
      `http://localhost/v1/claims/${claim}/evidence/${evidenceId}`));
    expect(otherRead.status).toBe(404);
  } finally { await source.stop(); }
}, 90_000);
