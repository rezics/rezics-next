import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import {
  AccessAdmissionRegistry, AdmissionConflict, AdmissionDenied,
  type AdmissionRequest,
} from '../src/modules/access/admission.ts';

const root = resolve(import.meta.dir, '../../..');

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

test('IAM07 partial: PostgreSQL gate serializes admission and ordinary closure', async () => {
  const state = join(root, '.temp', `access-integration-${Bun.randomUUIDv7()}`);
  const data = join(state, 'pgdata');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 4 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(join(root, 'services/main/migrations/access/001_admission.sql'), 'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const principalId = Bun.randomUUIDv7();
    const actingSubject = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const scope = 'work:create:root';
    const action = 'work.create';
    const issuer = 'https://account.rezics.test';
    const accountSubject = 'fixture-user-1';
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [principalId, issuer, accountSubject]);
    await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [actingSubject]);
    await pool.query(`INSERT INTO access.scope_gate (id) VALUES ($1)`, [scope]);
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actingSubject, action]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), actingSubject, scope, action]);

    const registry = new AccessAdmissionRegistry(pool);
    const request: AdmissionRequest = {
      principal: { id: principalId, issuer, subject: accountSubject },
      actingSubject, scope, action, idempotencyKey: 'first',
      requestDigest: createHash('sha256').update('first intent').digest('hex'),
    };
    const registered = await registry.register(request);
    expect(registered.replayed).toBe(false);
    expect(registered.authorityEpoch).toBe('0');
    const replay = await registry.register(request);
    expect(replay).toEqual({ ...registered, replayed: true });
    await expect(registry.register({ ...request, requestDigest: 'a'.repeat(64) }))
      .rejects.toBeInstanceOf(AdmissionConflict);
    await expect(registry.register({ ...request, idempotencyKey: 'wrong-issuer',
      principal: { ...request.principal, issuer: 'https://attacker.invalid' } }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await expect(registry.register({ ...request, idempotencyKey: 'wrong-action', action: 'work.delete' }))
      .rejects.toBeInstanceOf(AdmissionDenied);

    const raceRequest = { ...request, idempotencyKey: 'same-key-race' };
    const pair = await Promise.all([registry.register(raceRequest), registry.register(raceRequest)]);
    expect(pair[0]?.id).toBe(pair[1]?.id);
    const receipts = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM access.admission_receipt');
    expect(receipts.rows[0]?.count).toBe('2');
    const firstOutbox = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM access.outbox');
    expect(firstOutbox.rows[0]?.count).toBe('2');

    const [competingRegistration, competingClosure] = await Promise.allSettled([
      registry.register({ ...request, idempotencyKey: 'closure-race' }),
      registry.closeScope(scope, '0'),
    ]);
    expect(competingClosure.status).toBe('fulfilled');
    if (competingClosure.status !== 'fulfilled') throw competingClosure.reason;
    const closed = competingClosure.value;
    expect(closed.authorityEpoch).toBe('1');
    if (competingRegistration.status === 'fulfilled') {
      expect(competingRegistration.value.authorityEpoch).toBe('0');
      expect(closed.pending).toBe(3);
    } else {
      expect(competingRegistration.reason).toBeInstanceOf(AdmissionDenied);
      expect(closed.pending).toBe(2);
    }
    await expect(registry.register({ ...request, idempotencyKey: 'after-close' }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    await expect(registry.closeScope(scope, '0')).rejects.toBeInstanceOf(AdmissionConflict);
    expect((await registry.register(request)).replayed).toBe(true);
    const finalOutbox = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM access.outbox');
    expect(finalOutbox.rows[0]?.count).toBe(competingRegistration.status === 'fulfilled' ? '4' : '3');
    await pool.query('UPDATE access.principal SET active = false, enforcement_epoch = enforcement_epoch + 1 WHERE id = $1', [principalId]);
    await expect(registry.register(request)).rejects.toBeInstanceOf(AdmissionDenied);
  } finally {
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state });
  }
}, 120_000);
