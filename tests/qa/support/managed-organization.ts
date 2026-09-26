import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { MANAGED_ORG_ACTION } from '../../../services/main/src/modules/access/managed-org-authority.ts';
import type { seedOrgRealm } from './org-realm.ts';

/** Owner-provisioned independent mandates; public management cannot create these. */
export async function seedManagedOrganization(pool: Pool, fixture: Awaited<ReturnType<typeof seedOrgRealm>>) {
  const issuerRepresentation = randomUUID(), managementGrant = randomUUID(), ceilingGrant = randomUUID();
  const recipientRepresentation = randomUUID(), parentRepresentation = randomUUID();
  const parent = `https://rezics.com/id/${randomUUID()}`;
  await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')`, [parent]);
  await pool.query(`INSERT INTO access.org_participation_subject (subject) VALUES ($1)`, [parent]);
  await pool.query(`INSERT INTO access.membership_policy (kind, owner_subject, revision, terms_revision)
    VALUES ('org',$1,1,'roster-terms'),('org',$2,1,'parent-terms'),('realm',$3,1,'realm-terms')`,
  [fixture.org, parent, fixture.realmManager]);
  await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,$4,now() + interval '1 hour'),($5,$6,$7,$8,now() + interval '1 hour'),
      ($9,$6,$10,$8,now() + interval '1 hour')`,
  [issuerRepresentation, fixture.orgPrincipalId, fixture.org, MANAGED_ORG_ACTION.grant,
    recipientRepresentation, fixture.realmPrincipalId, fixture.realmManager, MANAGED_ORG_ACTION.roster,
    parentRepresentation, parent]);
  await pool.query(`INSERT INTO access.permission_grant
    (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '1 hour'),
      ($4,$2,$2,'work:create:root',$5,now() + interval '1 hour')`,
  [managementGrant, fixture.org, MANAGED_ORG_ACTION.grant, ceilingGrant, MANAGED_ORG_ACTION.assign]);
  return { issuerRepresentation, managementGrant, ceilingGrant, recipientRepresentation,
    parentRepresentation, parent };
}
