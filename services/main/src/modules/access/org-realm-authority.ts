import type { PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';

export class OrgRealmDenied extends Error {}
export class OrgRealmConflict extends Error {}
export class OrgRealmStale extends Error {}
export class OrgRealmUnavailable extends Error {}

export const ORG_REALM_SCOPE = 'work:create:root';
export const ORG_REALM_ACTION = {
  admit: 'access.org-realm.admit',
  participate: 'access.org-realm.participate',
  suspend: 'access.org-realm.suspend',
} as const;
export type OrgRealmAuthorityAction = typeof ORG_REALM_ACTION[keyof typeof ORG_REALM_ACTION];
export interface OrgRealmProof {
  principalId: string;
  principalEpoch: string;
  subject: string;
  subjectGeneration: string;
  action: OrgRealmAuthorityAction;
  representationId: string;
  representationGeneration: string;
  grantId: string;
  grantGeneration: string;
  validUntil: string;
}

export const validOrgRealmId = (value: string) =>
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const validOrgRealmGeneration = (value: string) =>
  /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) < 9223372036854775807n;

export async function beginOrgRealm(client: PoolClient, write: boolean): Promise<string> {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  const recovery = await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (!recovery.rows[0]?.open) throw new OrgRealmUnavailable('Access recovery held');
  const gate = await client.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(
    `SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
    [ORG_REALM_SCOPE]);
  if (!gate.rows[0]) throw new OrgRealmUnavailable('Access scope missing');
  if (!gate.rows[0].open || !gate.rows[0].dispatch_open) throw new OrgRealmDenied('Access scope closed');
  return gate.rows[0].authority_epoch;
}

/** Select and lock one independent mandate and matching direct permission. */
export async function orgRealmAuthority(client: PoolClient, principal: VerifiedPrincipal,
  subject: string, action: OrgRealmAuthorityAction): Promise<OrgRealmProof> {
  const result = await client.query<{ principal_id: string; principal_epoch: string;
    subject_generation: string; representation_id: string; representation_generation: string;
    grant_id: string; grant_generation: string; valid_until: Date }>(`
    SELECT p.id AS principal_id, p.enforcement_epoch AS principal_epoch,
      s.generation AS subject_generation, r.id AS representation_id,
      r.generation AS representation_generation, g.id AS grant_id,
      g.generation AS grant_generation, LEAST(r.valid_until, g.valid_until) AS valid_until
    FROM access.principal p
    JOIN access.authority_subject s ON s.id = $3 AND s.active AND s.kind = 'agent'
    JOIN LATERAL (SELECT id, generation, valid_until FROM access.representation
      WHERE principal_id = p.id AND subject_id = s.id AND action = $4
        AND active AND valid_until > statement_timestamp() AND valid_until > clock_timestamp()
      ORDER BY valid_until, id LIMIT 1 FOR SHARE) r ON true
    JOIN LATERAL (SELECT id, generation, valid_until FROM access.permission_grant
      WHERE recipient_subject = s.id AND scope_id = $5 AND action = $4
        AND membership_id IS NULL AND active AND valid_until > statement_timestamp()
        AND valid_until > clock_timestamp()
      ORDER BY valid_until, id LIMIT 1 FOR SHARE) g ON true
    WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
    FOR SHARE OF p, s`, [principal.issuer, principal.subject, subject, action, ORG_REALM_SCOPE]);
  const row = result.rows[0];
  if (!row) throw new OrgRealmDenied('independent Org/Realm mandate or ceiling missing');
  return { principalId: row.principal_id, principalEpoch: row.principal_epoch,
    subject, subjectGeneration: row.subject_generation, action,
    representationId: row.representation_id, representationGeneration: row.representation_generation,
    grantId: row.grant_id, grantGeneration: row.grant_generation,
    validUntil: row.valid_until.toISOString() };
}

/** Revalidate exactly the saved branch; never substitute a replacement grant. */
export async function recheckOrgRealmAuthority(client: PoolClient, proof: OrgRealmProof): Promise<void> {
  const result = await client.query(`SELECT p.id FROM access.principal p
    JOIN access.authority_subject s ON s.id = $3 AND s.active AND s.kind = 'agent'
      AND s.generation = $4
    JOIN access.representation r ON r.id = $5 AND r.principal_id = p.id
      AND r.subject_id = s.id AND r.generation = $6 AND r.action = $7
      AND r.active AND r.valid_until > clock_timestamp()
    JOIN access.permission_grant g ON g.id = $8 AND g.recipient_subject = s.id
      AND g.generation = $9 AND g.action = $7 AND g.scope_id = $10
      AND g.membership_id IS NULL AND g.active AND g.valid_until > clock_timestamp()
    WHERE p.id = $1 AND p.enforcement_epoch = $2 AND p.active
      AND $11::timestamptz > clock_timestamp()
    FOR SHARE OF p, s, r, g`, [proof.principalId, proof.principalEpoch, proof.subject,
    proof.subjectGeneration, proof.representationId, proof.representationGeneration,
    proof.action, proof.grantId, proof.grantGeneration, ORG_REALM_SCOPE, proof.validUntil]);
  if (!result.rows[0]) throw new OrgRealmDenied('saved Org/Realm authority no longer valid');
}

export function normalizeOrgRealmError(error: unknown): Error {
  if (error && typeof error === 'object' && 'code' in error) {
    if (String(error.code) === '23505') return new OrgRealmConflict('Org/Realm key conflicts');
    if (['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
      return new OrgRealmUnavailable('Org/Realm owner timed out or conflicted');
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
