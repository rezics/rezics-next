import type { PoolClient } from 'pg';
import { RoleUnavailable } from './roles.ts';

const MAX_BINDINGS_PER_AGENT = 16;

export interface RoleWorkProof {
  bindingId: string;
  bindingGeneration: string;
  familyId: string;
  roleRevision: string;
}
type RoleRow = { id: string; recipient_subject: string; generation: string;
  family_id: string; role_revision: string; permissions: string[] };

/** Select exactly one current role binding, preserving its pinned revision. */
export async function roleWorkCreateProof(client: PoolClient,
  subject: string): Promise<RoleWorkProof | null> {
  const rows = await client.query<RoleRow>(`SELECT b.id, b.recipient_subject,
    b.generation, b.family_id, b.role_revision, r.permissions
    FROM access.role_binding b JOIN access.role_revision r
      ON r.family_id = b.family_id AND r.revision = b.role_revision
    WHERE b.recipient_subject = $1 AND b.active
      AND b.valid_until > clock_timestamp()
    ORDER BY b.id LIMIT $2 FOR SHARE OF b`,
  [subject, MAX_BINDINGS_PER_AGENT + 1]);
  if (rows.rows.length > MAX_BINDINGS_PER_AGENT) {
    throw new RoleUnavailable('Agent role bindings exceed supported profile');
  }
  const selected = rows.rows.find(row => row.permissions.includes('work.create'));
  return selected ? { bindingId: selected.id,
    bindingGeneration: selected.generation, familyId: selected.family_id,
    roleRevision: selected.role_revision } : null;
}

/** Set-based discovery evaluates at most 16 bindings per represented Agent. */
export async function roleWorkCreateSubjects(client: PoolClient,
  subjects: readonly string[]): Promise<Set<string>> {
  if (subjects.length === 0) return new Set();
  const rows = await client.query<RoleRow>(`SELECT b.id, b.recipient_subject,
    b.generation, b.family_id, b.role_revision, r.permissions
    FROM access.role_binding b JOIN access.role_revision r
      ON r.family_id = b.family_id AND r.revision = b.role_revision
    WHERE b.recipient_subject = ANY($1::text[]) AND b.active
      AND b.valid_until > clock_timestamp()
    ORDER BY b.recipient_subject, b.id LIMIT $2 FOR SHARE OF b`,
  [subjects, subjects.length * MAX_BINDINGS_PER_AGENT + 1]);
  const counts = new Map<string, number>();
  for (const row of rows.rows) {
    const count = (counts.get(row.recipient_subject) ?? 0) + 1;
    if (count > MAX_BINDINGS_PER_AGENT) {
      throw new RoleUnavailable('Agent role bindings exceed supported profile');
    }
    counts.set(row.recipient_subject, count);
  }
  if (rows.rows.length > subjects.length * MAX_BINDINGS_PER_AGENT) {
    throw new RoleUnavailable('role discovery exceeds supported profile');
  }
  return new Set(rows.rows.filter(row => row.permissions.includes('work.create'))
    .map(row => row.recipient_subject));
}

/** Claim checks only the saved binding and exact immutable role revision. */
export async function selectedRoleWorkProof(client: PoolClient, subject: string,
  proof: RoleWorkProof): Promise<boolean> {
  await roleWorkCreateProof(client, subject); // enforce the same per-Agent work ceiling
  const row = await client.query(`SELECT b.id FROM access.role_binding b
    JOIN access.role_revision r ON r.family_id = b.family_id
      AND r.revision = b.role_revision
    WHERE b.id = $1 AND b.recipient_subject = $2 AND b.generation = $3
      AND b.family_id = $4 AND b.role_revision = $5
      AND b.active AND b.valid_until > clock_timestamp()
      AND r.permissions @> ARRAY['work.create']::text[] FOR SHARE OF b`,
  [proof.bindingId, subject, proof.bindingGeneration,
    proof.familyId, proof.roleRevision]);
  return row.rowCount === 1;
}
