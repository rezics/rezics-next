import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { grantFixtureAuthority } from './fixture-authority.ts';

/** Isolated owner-test authority, including states a live grant may outlast. */
export async function fixtureAuthorityScenario(pool: Pool, input: {
  scope: string; action: string; mandate: string;
  mandateState?: 'expired' | 'revoked';
  membership?: 'joined' | 'left' | 'stale';
}) {
  const principalId = randomUUID(), actor = `https://rezics.com/id/${randomUUID()}`;
  const principal = { issuer: 'https://account.authority.test', subject: randomUUID() };
  await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1,$2,$3)`, [principalId, principal.issuer, principal.subject]);
  await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')`, [actor]);
  const authority = await grantFixtureAuthority(pool, {
    scope: input.scope, requireDispatch: true,
    representations: [{ principalId, actor, action: input.mandate,
      lifetime: input.mandate === 'agent.control' ? 'infinity' : '8 hours' }],
    grant: { actor, action: input.membership ? 'fixture.membership.setup' : input.action, lifetime: '8 hours' },
  });
  if (input.mandateState === 'expired') {
    await pool.query(`UPDATE access.representation
      SET valid_until = clock_timestamp() - interval '1 second' WHERE id = $1`,
    [authority.representationIds[0]]);
  } else if (input.mandateState === 'revoked') {
    await pool.query('UPDATE access.representation SET active = false WHERE id = $1',
      [authority.representationIds[0]]);
  }
  if (input.membership) {
    const membershipId = randomUUID();
    await pool.query(`INSERT INTO access.membership_policy (kind, owner_subject, revision, terms_revision)
      VALUES ('org',$1,1,'terms:1')`, [actor]);
    await pool.query(`INSERT INTO access.membership (id,kind,owner_subject,member_subject,state,
      generation,policy_revision,terms_revision,consent_reference)
      VALUES ($1,'org',$2,$2,'joined',1,1,'terms:1','fixture-consent')`, [membershipId, actor]);
    authority.grantId = randomUUID();
    await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,
      scope_id,action,valid_until,membership_id,membership_generation)
      VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '8 hours',$5,1)`,
    [authority.grantId, actor, input.scope, input.action, membershipId]);
    if (input.membership !== 'joined') {
      await pool.query(`UPDATE access.membership SET state = 'left', generation = 2 WHERE id = $1`,
        [membershipId]);
      if (input.membership === 'stale') {
        await pool.query(`UPDATE access.membership SET state = 'joined', generation = 3 WHERE id = $1`,
          [membershipId]);
      }
    }
  }
  return { principal, actor, ...authority };
}
