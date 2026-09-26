import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { beginOrgRealm, ORG_REALM_SCOPE, OrgRealmDenied, OrgRealmUnavailable } from './org-realm-authority.ts';

export class ManagedOrgDenied extends Error {}
export class ManagedOrgConflict extends Error {}
export class ManagedOrgStale extends Error {}
export class ManagedOrgUnavailable extends Error {}
export const MANAGED_ORG_ACTION = {
  grant: 'access.org.managed.grant',
  assign: 'access.org.managed.assign.roster-policy',
  roster: 'access.org.roster.policy',
} as const;
export interface ManagedRecipient { kind: 'realm' | 'parent'; id: string }
export interface ManagedSubject { subject: string; generation: string; admissionGeneration: string }
export interface ManagedRepresentation {
  principalId: string; principalEpoch: string;
  subject: string; subjectGeneration: string; action: string;
  representationId: string; representationGeneration: string; validUntil: string;
}
interface PermissionProof { id: string; generation: string; validUntil: string }
export interface ManagedIssuerProof extends ManagedRepresentation {
  management: PermissionProof;
  ceiling?: PermissionProof;
}

export async function managedTransaction<T>(pool: Pool, write: boolean,
  body: (client: PoolClient, epoch: string) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const epoch = await beginOrgRealm(client, write);
    const result = await body(client, epoch);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve cause */ }
    if (error instanceof OrgRealmDenied) throw new ManagedOrgDenied(error.message);
    if (error instanceof OrgRealmUnavailable) throw new ManagedOrgUnavailable(error.message);
    if (error && typeof error === 'object' && 'code' in error) {
      if (String(error.code) === '23505') throw new ManagedOrgConflict('managed organization key conflicts');
      if (['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new ManagedOrgUnavailable('managed organization owner timed out or conflicted');
      }
    }
    throw error;
  } finally { client.release(); }
}

export async function managedOrganization(client: PoolClient, subject: string): Promise<ManagedSubject> {
  const result = await client.query<{ generation: string; admission_generation: string }>(`
    SELECT s.generation, o.generation AS admission_generation
    FROM access.org_participation_subject o JOIN access.authority_subject s ON s.id = o.subject
    WHERE o.subject = $1 AND o.active AND s.active AND s.kind = 'agent' FOR SHARE OF o, s`, [subject]);
  const row = result.rows[0];
  if (!row) throw new ManagedOrgDenied('admitted organization required');
  return { subject, generation: row.generation, admissionGeneration: row.admission_generation };
}

export async function managedRecipient(client: PoolClient, recipient: ManagedRecipient): Promise<ManagedSubject> {
  if (recipient.kind === 'parent') return managedOrganization(client, recipient.id);
  const result = await client.query<{ subject: string; generation: string; admission_generation: string }>(`
    SELECT s.id AS subject, s.generation, p.revision AS admission_generation
    FROM access.org_realm_policy p JOIN access.authority_subject s ON s.id = p.manager_subject
    WHERE p.realm = $1 AND s.active AND s.kind = 'agent' FOR SHARE OF p, s`, [recipient.id]);
  const row = result.rows[0];
  if (!row) throw new ManagedOrgDenied('admitted Realm authority required');
  return { subject: row.subject, generation: row.generation, admissionGeneration: row.admission_generation };
}

/** Choose one current mandate; an explicit ID never falls back to another branch. */
export async function managedRepresentation(client: PoolClient, principal: VerifiedPrincipal,
  subject: string, action: string, exact?: { id: string; generation: string }): Promise<ManagedRepresentation> {
  const result = await client.query<{ principal_id: string; principal_epoch: string;
    subject_generation: string; representation_id: string; representation_generation: string;
    valid_until: Date }>(`SELECT p.id AS principal_id, p.enforcement_epoch AS principal_epoch,
      s.generation AS subject_generation, r.id AS representation_id,
      r.generation AS representation_generation, r.valid_until
    FROM access.principal p JOIN access.authority_subject s ON s.id = $3 AND s.active AND s.kind = 'agent'
    JOIN LATERAL (SELECT id, generation, valid_until FROM access.representation
      WHERE principal_id = p.id AND subject_id = s.id AND action = $4 AND active
        AND ($5::uuid IS NULL OR id = $5) AND valid_until > statement_timestamp()
        AND valid_until > clock_timestamp()
      ORDER BY valid_until, id LIMIT 1 FOR SHARE) r ON true
    WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active FOR SHARE OF p, s`,
  [principal.issuer, principal.subject, subject, action, exact?.id ?? null]);
  const row = result.rows[0];
  if (!row) throw new ManagedOrgDenied('current representation required');
  if (exact && row.representation_generation !== exact.generation) {
    throw new ManagedOrgStale('recipient representation changed');
  }
  return { principalId: row.principal_id, principalEpoch: row.principal_epoch,
    subject, subjectGeneration: row.subject_generation, action,
    representationId: row.representation_id, representationGeneration: row.representation_generation,
    validUntil: row.valid_until.toISOString() };
}

async function permission(client: PoolClient, subject: string, action: string,
  until?: string): Promise<PermissionProof> {
  const result = await client.query<{ id: string; generation: string; valid_until: Date }>(`
    SELECT id, generation, valid_until FROM access.permission_grant
    WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
      AND membership_id IS NULL AND valid_until > statement_timestamp() AND valid_until > clock_timestamp()
      AND ($4::timestamptz IS NULL OR valid_until >= $4::timestamptz)
    ORDER BY valid_until, id LIMIT 1 FOR SHARE`, [subject, ORG_REALM_SCOPE, action, until ?? null]);
  const row = result.rows[0];
  if (!row) throw new ManagedOrgDenied('independent organization mandate or assignment ceiling missing');
  return { id: row.id, generation: row.generation, validUntil: row.valid_until.toISOString() };
}

export async function managedIssuer(client: PoolClient, principal: VerifiedPrincipal,
  subject: string, until?: string): Promise<ManagedIssuerProof> {
  const proof = await managedRepresentation(client, principal, subject, MANAGED_ORG_ACTION.grant);
  const management = await permission(client, subject, MANAGED_ORG_ACTION.grant, until);
  if (until && new Date(proof.validUntil) < new Date(until)) throw new ManagedOrgDenied('issuance outlives mandate');
  return { ...proof, management,
    ...(until ? { ceiling: await permission(client, subject, MANAGED_ORG_ACTION.assign, until) } : {}) };
}

export async function recheckManagedRepresentation(client: PoolClient, proof: ManagedRepresentation,
  until?: string): Promise<void> {
  const row = await client.query(`SELECT r.id FROM access.principal p
    JOIN access.authority_subject s ON s.id = $3 AND s.active AND s.kind = 'agent' AND s.generation = $4
    JOIN access.representation r ON r.id = $5 AND r.principal_id = p.id AND r.subject_id = s.id
      AND r.action = $6 AND r.generation = $7 AND r.active AND r.valid_until > clock_timestamp()
      AND ($8::timestamptz IS NULL OR r.valid_until >= $8::timestamptz)
    WHERE p.id = $1 AND p.enforcement_epoch = $2 AND p.active FOR SHARE OF p, s, r`,
  [proof.principalId, proof.principalEpoch, proof.subject, proof.subjectGeneration,
    proof.representationId, proof.action, proof.representationGeneration, until ?? null]);
  if (!row.rows[0]) throw new ManagedOrgDenied('saved representation is stale or expired');
}

export async function recheckManagedIssuer(client: PoolClient, proof: ManagedIssuerProof,
  until?: string): Promise<void> {
  await recheckManagedRepresentation(client, proof, until);
  for (const [saved, action] of [[proof.management, MANAGED_ORG_ACTION.grant],
    ...(until ? [[proof.ceiling, MANAGED_ORG_ACTION.assign] as const] : [])] as const) {
    if (!saved) throw new ManagedOrgDenied('saved issuer ceiling missing');
    const row = await client.query(`SELECT id FROM access.permission_grant
      WHERE id = $1 AND recipient_subject = $2 AND scope_id = $3 AND action = $4
        AND generation = $5 AND active AND membership_id IS NULL AND valid_until > clock_timestamp()
        AND ($6::timestamptz IS NULL OR valid_until >= $6::timestamptz) FOR SHARE`,
    [saved.id, proof.subject, ORG_REALM_SCOPE, action, saved.generation, until ?? null]);
    if (!row.rows[0]) throw new ManagedOrgDenied('saved issuer grant or ceiling no longer valid');
  }
}

/** Check the live clock after all dependent row-lock waits. */
export async function managedLive(client: PoolClient, from: string, until: string,
  actor: ManagedRepresentation): Promise<void> {
  const row = await client.query(`SELECT 1 WHERE $1::timestamptz <= clock_timestamp()
    AND LEAST($2::timestamptz, $3::timestamptz) > clock_timestamp()`, [from, until, actor.validUntil]);
  if (!row.rows[0]) throw new ManagedOrgDenied('managed authority outside validity interval');
}
