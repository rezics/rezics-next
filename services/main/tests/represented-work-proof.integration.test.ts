import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { AccessAdmissionRegistry, AdmissionConflict, AdmissionDenied,
  type AdmissionRequest } from '../src/modules/access/admission.ts';
import { accessStateCoverage } from '../src/modules/work/access-recovery-coverage.ts';

const root = resolve(import.meta.dir, '../../..');
const issuer = 'https://account.rezics.test';
const subject = 'represented-proof-fixture';
const scope = 'work:create:root';
const repOne = '00000000-0000-4000-8000-000000000001';
const repTwo = '00000000-0000-4000-8000-000000000002';
const repThree = '00000000-0000-4000-8000-000000000003';
const grantOne = '10000000-0000-4000-8000-000000000001';
const grantTwo = '10000000-0000-4000-8000-000000000002';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('IAM33 partial: represented Work proof binds mandate, grant, actor and generations', async () => {
  const state = join(root, '.temp', `represented-proof-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER,
    database: 'postgres', max: 4 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const migrations = join(root, 'services/main/migrations/access');
      for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort()) {
        await client.query(readFileSync(join(migrations, file), 'utf8'));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }

    const principalId = randomUUID();
    const actor = `https://rezics.com/id/${randomUUID()}`;
    const otherActor = `https://rezics.com/id/${randomUUID()}`;
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [principalId, issuer, subject]);
    await pool.query(`INSERT INTO access.authority_subject (id, kind)
      VALUES ($1, 'agent'), ($2, 'agent')`, [actor, otherActor]);
    await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '1 hour')`,
    [repOne, principalId, actor]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.create', now() + interval '1 hour')`,
    [grantOne, actor, scope]);
    const access = new AccessAdmissionRegistry(pool);
    let sequence = 0;
    const request = (actingSubject = actor): AdmissionRequest => ({
      principal: { issuer, subject }, actingSubject, authorityPath: 'represented-agent',
      scope, action: 'work.create', idempotencyKey: `represented-${++sequence}`,
      requestDigest: createHash('sha256').update('same Work intent').digest('hex'),
    });
    const denyClaim = async (id: string, digest: string) => {
      await expect(access.claim(id, digest)).rejects.toBeInstanceOf(AdmissionDenied);
    };

    const original = request();
    const first = await access.register(original);
    const saved = await pool.query<{
      represented_representation_id: string; represented_grant_id: string;
      represented_subject_generation: string; represented_principal_epoch: string;
    }>(`SELECT represented_representation_id, represented_grant_id,
      represented_subject_generation, represented_principal_epoch
      FROM access.admission WHERE id = $1`, [first.id]);
    expect(saved.rows[0]).toEqual({ represented_representation_id: repOne,
      represented_grant_id: grantOne, represented_subject_generation: '0',
      represented_principal_epoch: '0' });
    expect(await access.register(original)).toEqual({ ...first, replayed: true });
    expect((await access.claim(first.id, first.requestDigest)).state).toBe('claimed');
    expect((await access.claim(first.id, first.requestDigest)).replayed).toBe(true);

    // A mutation bumps the saved mandate generation even when still active.
    const staleMandate = await access.register(request());
    await pool.query(`UPDATE access.representation
      SET valid_until = valid_until + interval '1 hour' WHERE id = $1`, [repOne]);
    await denyClaim(staleMandate.id, staleMandate.requestDigest);
    await denyClaim(first.id, first.requestDigest);
    expect((await access.register({ ...original, idempotencyKey: original.idempotencyKey }))
      .dispatchEligible).toBe(false);
    const currentMandate = await access.register(request());
    expect((await access.claim(currentMandate.id, currentMandate.requestDigest)).state).toBe('claimed');

    // A second mandate cannot rescue a handle tied to the first.
    const oldMandate = await access.register(request());
    await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [repOne]);
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '1 hour')`,
    [repTwo, principalId, actor]);
    await denyClaim(oldMandate.id, oldMandate.requestDigest);
    expect((await access.register({ ...original, idempotencyKey: oldMandate.idempotencyKey }))
      .dispatchEligible).toBe(false);
    const currentWithOtherMandate = await access.register(request());
    expect((await access.claim(currentWithOtherMandate.id,
      currentWithOtherMandate.requestDigest)).state).toBe('claimed');

    // A newly valid grant is independent support for a new registration only.
    const oldGrant = await access.register(request());
    const beforeGrantChange = await accessStateCoverage(pool);
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [grantOne]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, 'work.create', now() + interval '1 hour')`,
    [grantTwo, actor, scope]);
    expect((await accessStateCoverage(pool)).digest).not.toBe(beforeGrantChange.digest);
    await denyClaim(oldGrant.id, oldGrant.requestDigest);
    const replay = await access.register({ ...original, idempotencyKey: oldGrant.idempotencyKey });
    expect(replay.id).toBe(oldGrant.id);
    expect(replay.replayed).toBe(true);
    expect(replay.dispatchEligible).toBe(false);
    expect((await pool.query<{ count: string }>(`SELECT count(*) AS count
      FROM access.admission_receipt WHERE principal_id = $1 AND idempotency_key = $2`,
    [principalId, oldGrant.idempotencyKey])).rows[0]?.count).toBe('1');
    const currentWithOtherGrant = await access.register(request());
    expect((await access.claim(currentWithOtherGrant.id,
      currentWithOtherGrant.requestDigest)).state).toBe('claimed');

    const expiring = await access.register(request());
    await pool.query(`UPDATE access.permission_grant
      SET valid_until = clock_timestamp() - interval '1 second' WHERE id = $1`, [grantTwo]);
    await denyClaim(expiring.id, expiring.requestDigest);
    await pool.query(`UPDATE access.permission_grant
      SET valid_until = clock_timestamp() + interval '1 hour' WHERE id = $1`, [grantTwo]);
    await denyClaim(expiring.id, expiring.requestDigest);
    expect((await access.claim((await access.register(request())).id,
      expiring.requestDigest)).state).toBe('claimed');

    const wrongAction = await access.register(request());
    await pool.query("UPDATE access.permission_grant SET action = 'work.edit' WHERE id = $1", [grantTwo]);
    await denyClaim(wrongAction.id, wrongAction.requestDigest);
    await pool.query("UPDATE access.permission_grant SET action = 'work.create' WHERE id = $1", [grantTwo]);
    await denyClaim(wrongAction.id, wrongAction.requestDigest);
    await pool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:other')");
    const wrongScope = await access.register(request());
    await pool.query("UPDATE access.permission_grant SET scope_id = 'work:create:other' WHERE id = $1",
      [grantTwo]);
    await denyClaim(wrongScope.id, wrongScope.requestDigest);
    await pool.query('UPDATE access.permission_grant SET scope_id = $2 WHERE id = $1', [grantTwo, scope]);
    await denyClaim(wrongScope.id, wrongScope.requestDigest);

    // Retargeting the mandate to another Agent and restoring the old Agent's
    // authority cannot silently switch the already selected actor.
    const actorSwitch = await access.register(request());
    await pool.query('UPDATE access.representation SET subject_id = $2 WHERE id = $1',
      [repTwo, otherActor]);
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '1 hour')`,
    [repThree, principalId, actor]);
    await denyClaim(actorSwitch.id, actorSwitch.requestDigest);
    await expect(access.register({ ...original, actingSubject: otherActor }))
      .rejects.toBeInstanceOf(AdmissionConflict);
    const restoredActor = await access.register(request());
    expect((await access.claim(restoredActor.id, restoredActor.requestDigest)).state).toBe('claimed');

    const oldSubject = await access.register(request());
    await pool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [actor]);
    await pool.query('UPDATE access.authority_subject SET active = true WHERE id = $1', [actor]);
    await denyClaim(oldSubject.id, oldSubject.requestDigest);
    const oldPrincipal = await access.register(request());
    await pool.query('UPDATE access.principal SET active = false WHERE id = $1', [principalId]);
    await pool.query('UPDATE access.principal SET active = true WHERE id = $1', [principalId]);
    await denyClaim(oldPrincipal.id, oldPrincipal.requestDigest);

    // The group-grant branch still binds its exact representation. A second
    // mandate cannot revive its otherwise unchanged group path.
    const groupId = randomUUID();
    await pool.query('INSERT INTO access.recipient_group (id, scope_id) VALUES ($1, $2)',
      [groupId, scope]);
    await pool.query(`INSERT INTO access.group_member (id, group_id, agent_subject)
      VALUES ($1, $2, $3)`, [randomUUID(), groupId, otherActor]);
    await pool.query(`INSERT INTO access.group_permission_grant
      (id, group_id, issuer_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $3, $4, 'work.create', now() + interval '1 hour')`,
    [randomUUID(), groupId, actor, scope]);
    const groupedRequest = request(otherActor);
    const grouped = await access.register(groupedRequest);
    expect((await pool.query<{ represented_representation_id: string;
      represented_grant_id: string | null; group_grant_id: string }>(`
      SELECT represented_representation_id, represented_grant_id, group_grant_id
      FROM access.admission WHERE id = $1`, [grouped.id])).rows[0]).toMatchObject({
      represented_representation_id: repTwo, represented_grant_id: null,
    });
    await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [repTwo]);
    await pool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, 'work.create', now() + interval '1 hour')`,
    [randomUUID(), principalId, otherActor]);
    await denyClaim(grouped.id, grouped.requestDigest);
    expect((await access.claim((await access.register(request(otherActor))).id,
      grouped.requestDigest)).state).toBe('claimed');
  } finally {
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
