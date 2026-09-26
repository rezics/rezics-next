import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ORG_REALM_ACTION } from '../../../services/main/src/modules/access/org-realm-authority.ts';

/** Bulk owner fixture; the public APIs under test do not provision control. */
export async function seedOrgRealm(pool: Pool, issuer: string, accounts: { realm: string; org: string }) {
  const org = `https://rezics.com/id/${randomUUID()}`;
  const realm = `https://rezics.com/id/${randomUUID()}`;
  const otherRealm = `https://rezics.com/id/${randomUUID()}`;
  const realmManager = `https://rezics.com/id/${randomUUID()}`;
  const orgPrincipalId = randomUUID(), realmPrincipalId = randomUUID();
  await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1,$2,$3),($4,$2,$5)`, [orgPrincipalId, issuer, accounts.org, realmPrincipalId, accounts.realm]);
  await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent'),($2,'agent')`,
    [org, realmManager]);
  await pool.query(`INSERT INTO access.org_participation_subject (subject) VALUES ($1)`, [org]);
  await pool.query(`INSERT INTO access.org_realm_policy (realm, manager_subject, revision, terms_revision)
    VALUES ($1,$3,1,'terms-1'),($2,$3,1,'terms-1')`, [realm, otherRealm, realmManager]);
  await pool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
  const authority = new Map<string, { representationId: string; grantId: string }>();
  for (const [subject, principalId, action] of [
    [realmManager, realmPrincipalId, ORG_REALM_ACTION.admit],
    [realmManager, realmPrincipalId, ORG_REALM_ACTION.suspend],
    [org, orgPrincipalId, ORG_REALM_ACTION.participate],
  ]) {
    const representationId = randomUUID(), grantId = randomUUID();
    await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [representationId, principalId, subject, action]);
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root',$3,now() + interval '1 hour')`, [grantId, subject, action]);
    authority.set(action!, { representationId, grantId });
  }
  return { org, realm, otherRealm, realmManager, orgPrincipalId, realmPrincipalId, authority,
    orgPrincipal: { issuer, subject: accounts.org }, realmPrincipal: { issuer, subject: accounts.realm } };
}
