import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { AccessAdmissionRegistry, AdmissionConflict, AdmissionDenied, AdmissionExpired,
  AdmissionUnavailable, engageAccessRecoveryFence, releaseAccessRecoveryFence,
} from '../src/modules/access/admission.ts';

const root = resolve(import.meta.dir, '../../..');
const issuer = 'https://account.search.test';
const subject = 'reader';

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

test('SEARCH12 foundation: durable private read admission, fences and two Main registries', async () => {
  const state = join(root, '.temp', `search-read-lease-${Bun.randomUUIDv7()}`);
  const data = join(state, 'pgdata');
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
  const config = { host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 4 };
  const pool = new Pool(config);
  const secondPool = new Pool(config);
  try {
    for (const file of ['001_admission.sql', '002_claim_and_seal.sql',
      '003_recovery_fence.sql', '004_principal_fence.sql',
      '005_account_deletion_fence.sql', '006_account_deletion_journal_scan.sql',
      '009_search_read_lease.sql']) {
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    const principalId = Bun.randomUUIDv7();
    const actingSubject = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const principal = { issuer, subject };
    await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, issuer, subject]);
    await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actingSubject]);
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'contribution.read', now() + interval '1 hour')`,
    [Bun.randomUUIDv7(), principalId, actingSubject]);
    const contributions = Array.from({ length: 7 }, () => `https://rezics.com/id/${Bun.randomUUIDv7()}`);
    for (const contribution of contributions) {
      const scope = `contribution:read:${contribution}`;
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
      await pool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, 'contribution.read', now() + interval '1 hour')`,
      [Bun.randomUUIDv7(), actingSubject, scope]);
    }
    const [one, two, expiryTarget, expiredDeliveryTarget, proofTarget,
      recoveryTarget, principalTarget] = contributions as
      [string, string, string, string, string, string, string];
    const first = new AccessAdmissionRegistry(pool);
    const second = new AccessAdmissionRegistry(secondPool);

    await expect(first.admitContributionSearchRead({ issuer, subject: 'stranger' },
      actingSubject, one)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(first.admitContributionSearchRead(principal,
      `https://rezics.com/id/${Bun.randomUUIDv7()}`, one)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(first.admitContributionSearchRead(principal, actingSubject,
      `https://rezics.com/id/${Bun.randomUUIDv7()}`)).rejects.toBeInstanceOf(AdmissionDenied);

    const admitted = await first.admitContributionSearchRead(principal, actingSubject, one);
    expect(admitted.state).toBe('admitted');
    expect(admitted.authorityEpoch).toBe('0');
    expect(admitted.principalEpoch).toBe('0');
    await expect(second.beginContributionSearchDelivery(admitted.id,
      { issuer, subject: 'stranger' }, actingSubject, one)).rejects.toBeInstanceOf(AdmissionDenied);
    await expect(second.beginContributionSearchDelivery(admitted.id,
      principal, actingSubject, two)).rejects.toBeInstanceOf(AdmissionDenied);
    const delivering = await second.beginContributionSearchDelivery(admitted.id,
      principal, actingSubject, one);
    expect(delivering.state).toBe('delivering');
    await expect(second.beginContributionSearchDelivery(admitted.id,
      principal, actingSubject, one)).rejects.toBeInstanceOf(AdmissionDenied);
    const scopeClosure = await first.strongCloseScope(`contribution:read:${one}`, '0');
    expect(scopeClosure).toMatchObject({ authorityEpoch: '1', pending: 1, pendingReads: 1 });
    await expect(first.admitContributionSearchRead(principal,
      actingSubject, one)).rejects.toBeInstanceOf(AdmissionDenied);
    await second.finishContributionSearchRead(admitted.id, 'delivered');
    await second.finishContributionSearchRead(admitted.id, 'delivered');
    await expect(second.finishContributionSearchRead(admitted.id, 'aborted'))
      .rejects.toBeInstanceOf(AdmissionConflict);
    expect((await first.strongCloseScope(`contribution:read:${one}`, '1')).pending).toBe(0);

    // Gate locking gives either a registered delivery before closure, or a denial.
    const racing = await first.admitContributionSearchRead(principal, actingSubject, two);
    const [start, close] = await Promise.allSettled([
      second.beginContributionSearchDelivery(racing.id, principal, actingSubject, two),
      first.strongCloseScope(`contribution:read:${two}`, '0'),
    ]);
    expect(close.status).toBe('fulfilled');
    if (close.status !== 'fulfilled') throw close.reason;
    if (start.status === 'fulfilled') {
      expect(start.value.state).toBe('delivering');
      expect(close.value.pendingReads).toBe(1);
      await second.finishContributionSearchRead(racing.id, 'aborted');
    } else {
      expect(start.reason).toBeInstanceOf(AdmissionDenied);
      expect(close.value.pendingReads).toBe(0); // no delivery started
      await second.finishContributionSearchRead(racing.id, 'aborted');
    }
    expect((await first.strongCloseScope(`contribution:read:${two}`, '1')).pendingReads).toBe(0);

    const expiring = await first.admitContributionSearchRead(principal, actingSubject, expiryTarget);
    await pool.query(`UPDATE access.search_read_lease
      SET created_at = clock_timestamp() - interval '2 seconds',
          expires_at = clock_timestamp() - interval '1 second'
      WHERE id = $1`, [expiring.id]);
    await expect(second.beginContributionSearchDelivery(expiring.id,
      principal, actingSubject, expiryTarget)).rejects.toBeInstanceOf(AdmissionExpired);
    expect((await first.strongCloseScope(`contribution:read:${expiryTarget}`, '0')).pendingReads).toBe(0);
    expect((await pool.query<{ state: string }>(
      'SELECT state FROM access.search_read_lease WHERE id = $1', [expiring.id])).rows[0]?.state).toBe('expired');

    const expiredDelivery = await first.admitContributionSearchRead(
      principal, actingSubject, expiredDeliveryTarget);
    await second.beginContributionSearchDelivery(expiredDelivery.id,
      principal, actingSubject, expiredDeliveryTarget);
    await pool.query(`UPDATE access.search_read_lease
      SET created_at = clock_timestamp() - interval '2 seconds',
          expires_at = clock_timestamp() - interval '1 second'
      WHERE id = $1`, [expiredDelivery.id]);
    expect((await first.strongCloseScope(`contribution:read:${expiredDeliveryTarget}`, '0'))
      .pendingReads).toBe(1);
    await expect(second.finishContributionSearchRead(expiredDelivery.id, 'delivered'))
      .rejects.toBeInstanceOf(AdmissionConflict);
    await second.finishContributionSearchRead(expiredDelivery.id, 'aborted');
    expect((await first.strongCloseScope(`contribution:read:${expiredDeliveryTarget}`, '1'))
      .pendingReads).toBe(0);

    const staleProof = await first.admitContributionSearchRead(principal, actingSubject, proofTarget);
    await pool.query(`UPDATE access.permission_grant SET generation = generation + 1
      WHERE scope_id = $1 AND action = 'contribution.read'`, [`contribution:read:${proofTarget}`]);
    await expect(second.beginContributionSearchDelivery(staleProof.id,
      principal, actingSubject, proofTarget)).rejects.toBeInstanceOf(AdmissionDenied);
    await second.finishContributionSearchRead(staleProof.id, 'aborted');

    const bounded = [];
    for (let index = 0; index < 16; index++) {
      bounded.push(await first.admitContributionSearchRead(principal, actingSubject, recoveryTarget));
    }
    await expect(first.admitContributionSearchRead(principal,
      actingSubject, recoveryTarget)).rejects.toBeInstanceOf(AdmissionUnavailable);
    for (const lease of bounded) await first.finishContributionSearchRead(lease.id, 'aborted');

    const recoveryLease = await first.admitContributionSearchRead(principal, actingSubject, recoveryTarget);
    const recoveryDelivery = await second.admitContributionSearchRead(principal, actingSubject, recoveryTarget);
    await second.beginContributionSearchDelivery(recoveryDelivery.id,
      principal, actingSubject, recoveryTarget);
    const generation = await engageAccessRecoveryFence(pool);
    await expect(first.admitContributionSearchRead(principal,
      actingSubject, principalTarget)).rejects.toBeInstanceOf(AdmissionUnavailable);
    await expect(second.beginContributionSearchDelivery(recoveryLease.id,
      principal, actingSubject, recoveryTarget)).rejects.toBeInstanceOf(AdmissionUnavailable);
    await expect(releaseAccessRecoveryFence(pool, generation)).rejects.toBeInstanceOf(AdmissionUnavailable);
    await second.finishContributionSearchRead(recoveryDelivery.id, 'aborted');
    await releaseAccessRecoveryFence(pool, generation);
    await expect(second.beginContributionSearchDelivery(recoveryLease.id,
      principal, actingSubject, recoveryTarget)).rejects.toBeInstanceOf(AdmissionDenied);
    await second.finishContributionSearchRead(recoveryLease.id, 'aborted');

    const principalLease = await first.admitContributionSearchRead(principal, actingSubject, principalTarget);
    const [principalStart, principalClose] = await Promise.allSettled([
      second.beginContributionSearchDelivery(principalLease.id, principal, actingSubject, principalTarget),
      first.strongDeactivatePrincipal(principalId, '0'),
    ]);
    expect(principalClose.status).toBe('fulfilled');
    if (principalClose.status !== 'fulfilled') throw principalClose.reason;
    const deactivated = principalClose.value;
    if (principalStart.status === 'fulfilled') {
      expect(principalStart.value.state).toBe('delivering');
      expect(deactivated.pendingReads).toBe(1);
      expect(deactivated.pending).toBe(1);
    } else {
      expect(principalStart.reason).toBeInstanceOf(AdmissionDenied);
      expect(deactivated.pendingReads).toBe(0);
    }
    await expect(first.admitContributionSearchRead(principal,
      actingSubject, principalTarget)).rejects.toBeInstanceOf(AdmissionDenied);
    await second.finishContributionSearchRead(principalLease.id, 'aborted');
    expect((await first.strongDeactivatePrincipal(principalId, '1')).pending).toBe(0);
  } finally {
    await secondPool.end();
    await pool.end();
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state }); }
    finally { rmSync(state, { recursive: true, force: true }); }
  }
}, 120_000);
