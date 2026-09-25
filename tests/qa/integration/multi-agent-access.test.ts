import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { AccessAdmissionRegistry }
  from '../../../services/main/src/modules/access/admission.ts';

test('IAM03/IAM04 partial: several principals and Agents retain separate complete read proofs', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 4 });
  try {
    const issuer = 'https://qa-multi-agent.test';
    const principals = [
      { id: randomUUID(), issuer, subject: randomUUID() },
      { id: randomUUID(), issuer, subject: randomUUID() },
    ];
    const actors = Array.from({ length: 3 }, () => `https://rezics.com/id/${randomUUID()}`);
    const works = Array.from({ length: 2 }, () => `https://rezics.com/id/${randomUUID()}`);
    for (const principal of principals) {
      await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1, $2, $3)`, [principal.id, principal.issuer, principal.subject]);
    }
    for (const actor of actors) {
      await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    }
    for (const work of works) {
      await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`work:read:${work}`]);
    }
    for (const [principal, actor] of [
      [principals[0]!, actors[0]!], [principals[0]!, actors[1]!],
      [principals[1]!, actors[0]!],
    ] as const) {
      await pool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, 'work.read', now() + interval '1 hour')`,
      [randomUUID(), principal.id, actor]);
    }
    for (const [actor, work] of [[actors[0]!, works[0]!],
      [actors[1]!, works[1]!], [actors[2]!, works[0]!]] as const) {
      await pool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, 'work.read', now() + interval '1 hour')`,
      [randomUUID(), actor, `work:read:${work}`]);
    }
    const registry = new AccessAdmissionRegistry(pool);
    const canRead = (index: 0 | 1, actor: string, work: string) =>
      registry.canReadWork({ issuer, subject: principals[index]!.subject }, actor, work);
    expect(await canRead(0, actors[0]!, works[0]!)).toBe(true);
    expect(await canRead(1, actors[0]!, works[0]!)).toBe(true);
    expect(await canRead(0, actors[1]!, works[1]!)).toBe(true);
    expect(await canRead(1, actors[1]!, works[1]!)).toBe(false);
    expect(await canRead(0, actors[0]!, works[1]!)).toBe(false);
    expect(await canRead(0, actors[1]!, works[0]!)).toBe(false);
    expect(await canRead(0, actors[2]!, works[0]!)).toBe(false);
    expect(await registry.canReadWork({ issuer: 'https://wrong-issuer.test',
      subject: principals[0]!.subject }, actors[0]!, works[0]!)).toBe(false);
  } finally { await pool.end(); }
});
