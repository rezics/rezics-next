import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AccessAdmissionRegistry, AdmissionDenied, AdmissionUnavailable }
  from '../../../services/main/src/modules/access/admission.ts';

test('LIVE03/LIVE05: attachment authority locks serialize revocation and recheck expiry after waits', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.CONTENT_DATABASE_URL) {
    throw new Error('Run through isolated QA integration');
  }
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const sourcePool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const registry = new AccessAdmissionRegistry(accessPool);
  const principalId = randomUUID();
  const principal = { issuer: 'https://source-authority.test', subject: randomUUID() };
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const work = `https://rezics.com/id/${randomUUID()}`;
  const scope = `work:edit:${work}`;
  const representation = randomUUID();
  const grant = randomUUID();
  const probe = `source_authority_${randomUUID().replaceAll('-', '')}`;
  const owner = await sourcePool.connect();
  const revoker = await accessPool.connect();
  try {
    await sourcePool.query(`CREATE TABLE ${probe} (id uuid PRIMARY KEY, proof jsonb NOT NULL)`);
    await accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.edit',clock_timestamp() + interval '1 hour')`, [representation, principalId, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'work.edit',clock_timestamp() + interval '1 hour')`, [grant, actor, scope]);

    let unlock!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { unlock = resolve; });
    const writeId = randomUUID();
    const write = registry.withWorkEditAuthority(principal, actor, work, async proof => {
      expect(proof).toMatchObject({ principalId, actingSubject: actor, scope,
        representationId: representation, grantId: grant, principalEpoch: '0' });
      await owner.query('BEGIN');
      await owner.query("SET LOCAL transaction_timeout = '5s'");
      await owner.query(`INSERT INTO ${probe} VALUES ($1,$2)`, [writeId, JSON.stringify(proof)]);
      entered();
      await released;
      await owner.query('COMMIT');
      return proof;
    });
    await paused;
    const pid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const revoke = revoker.query('UPDATE access.permission_grant SET active = false, generation = generation + 1 WHERE id = $1', [grant]);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      blocked = (await accessPool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked;
      if (blocked) break;
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
    expect((await sourcePool.query(`SELECT * FROM ${probe} WHERE id = $1`, [writeId])).rowCount).toBe(0);
    unlock();
    await write;
    await revoke;
    expect((await sourcePool.query(`SELECT * FROM ${probe} WHERE id = $1`, [writeId])).rowCount).toBe(1);
    await expect(registry.withWorkEditAuthority(principal, actor, work, async () => {
      throw new Error('revoked callback must never run');
    })).rejects.toBeInstanceOf(AdmissionDenied);

    // A grant that expires while SELECT FOR SHARE waits is not accepted using
    // the statement's earlier eligibility check or transaction-start time.
    await accessPool.query(`UPDATE access.permission_grant SET active = true,
      valid_until = clock_timestamp() + interval '1 hour' WHERE id = $1`, [grant]);
    await revoker.query('BEGIN');
    await revoker.query(`UPDATE access.permission_grant SET active = true,
      valid_until = clock_timestamp() + interval '150 milliseconds' WHERE id = $1`, [grant]);
    const expired = registry.withWorkEditAuthority(principal, actor, work, async () => {
      throw new Error('expired callback must never run');
    });
    const expiredOutcome = expired.then(() => null, error => error);
    await Bun.sleep(250);
    await revoker.query('COMMIT');
    expect(await expiredOutcome).toBeInstanceOf(AdmissionDenied);
    await accessPool.query(`UPDATE access.permission_grant SET active = true,
      valid_until = clock_timestamp() + interval '1 hour' WHERE id = $1`, [grant]);
    await revoker.query('BEGIN');
    await revoker.query('SELECT id FROM access.permission_grant WHERE id = $1 FOR UPDATE', [grant]);
    await expect(registry.withWorkEditAuthority(principal, actor, work, async () => {
      throw new Error('timed-out callback must never run');
    })).rejects.toBeInstanceOf(AdmissionUnavailable);
    await revoker.query('ROLLBACK');
    await expect(registry.withWorkEditAuthority(principal, actor, work, async () => {
      await owner.query('BEGIN');
      await owner.query(`INSERT INTO ${probe} VALUES ($1,'{}')`, [randomUUID()]);
      await owner.query('ROLLBACK');
      throw new Error('source owner rolled back');
    })).rejects.toThrow('source owner rolled back');
    expect((await sourcePool.query(`SELECT * FROM ${probe}`)).rowCount).toBe(1);
    expect((await accessPool.query('SELECT id FROM access.admission WHERE principal_id = $1', [principalId])).rowCount).toBe(0);
  } finally {
    await owner.query('ROLLBACK').catch(() => {});
    await revoker.query('ROLLBACK').catch(() => {});
    owner.release(); revoker.release();
    await sourcePool.query(`DROP TABLE IF EXISTS ${probe}`);
    await Promise.all([accessPool.end(), sourcePool.end()]);
  }
}, 30_000);
