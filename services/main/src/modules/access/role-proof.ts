import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { iri } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { RoleUnavailable } from './roles.ts';
import { requireDisclosureGraph } from './semantic-disclosure.ts';

const MAX_BINDINGS_PER_AGENT = 16;

/** Catalogue edit roles cover only current publicly readable Works. One exact
 * 1 KiB ASK shares the public-read predicate; drafts and old selections fail. */
export async function publicCatalogueWork(graph: Pick<FusekiClient, 'query'> | undefined,
  work: string): Promise<boolean> {
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)) return false;
  return (await requireDisclosureGraph(graph).query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> ASK { ${publicWork(iri(work), '?catalogueMain')} }`, 1024)).boolean === true;
}

export interface RoleWorkProof {
  bindingId: string;
  bindingGeneration: string;
  familyId: string;
  roleRevision: string;
}
type RoleRow = { id: string; recipient_subject: string; generation: string;
  family_id: string; role_revision: string; permissions: string[] };

/** Select exactly one current role binding, preserving its pinned revision. */
export async function roleWorkProof(client: PoolClient,
  subject: string, permission: 'work.create' | 'work.edit'): Promise<RoleWorkProof | null> {
  if (permission === 'work.edit') {
    const gate = (await client.query<{ open: boolean; dispatch_open: boolean }>(`
      SELECT open, dispatch_open FROM access.scope_gate WHERE id = 'work:create:root' FOR SHARE`)).rows[0];
    if (!gate?.open || !gate.dispatch_open) return null;
  }
  const rows = await client.query<RoleRow>(`SELECT b.id, b.recipient_subject,
    b.generation, b.family_id, b.role_revision, r.permissions
    FROM (SELECT * FROM access.role_binding
      WHERE recipient_subject = $1 AND active AND valid_until > statement_timestamp()
      ORDER BY valid_until,id LIMIT $2 FOR SHARE) b JOIN access.role_revision r
      ON r.family_id = b.family_id AND r.revision = b.role_revision
    WHERE b.recipient_subject = $1 AND b.active
      AND b.valid_until > statement_timestamp()
      AND (b.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership dep
        WHERE dep.id = b.membership_id AND dep.member_subject = b.recipient_subject
          AND dep.state = 'joined' AND dep.generation = b.membership_generation))
    ORDER BY b.id LIMIT $2`,
  [subject, MAX_BINDINGS_PER_AGENT + 1]);
  if (rows.rows.length > MAX_BINDINGS_PER_AGENT) {
    throw new RoleUnavailable('Agent role bindings exceed supported profile');
  }
  const selected = rows.rows.find(row => row.permissions.includes(permission));
  return selected ? { bindingId: selected.id,
    bindingGeneration: selected.generation, familyId: selected.family_id,
    roleRevision: selected.role_revision } : null;
}

export async function roleWorkCreateProof(client: PoolClient, subject: string): Promise<RoleWorkProof | null> {
  return roleWorkProof(client, subject, 'work.create');
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
      AND (b.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership dep
        WHERE dep.id = b.membership_id AND dep.member_subject = b.recipient_subject
          AND dep.state = 'joined' AND dep.generation = b.membership_generation))
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
  proof: RoleWorkProof, permission: 'work.create' | 'work.edit' = 'work.create'): Promise<boolean> {
  if (permission === 'work.edit') {
    const gate = (await client.query<{ open: boolean; dispatch_open: boolean }>(`
      SELECT open, dispatch_open FROM access.scope_gate WHERE id = 'work:create:root' FOR SHARE`)).rows[0];
    if (!gate?.open || !gate.dispatch_open) return false;
  }
  const row = await client.query(`SELECT b.id FROM access.role_binding b
    JOIN access.role_revision r ON r.family_id = b.family_id
      AND r.revision = b.role_revision
    WHERE b.id = $1 AND b.recipient_subject = $2 AND b.generation = $3
      AND b.family_id = $4 AND b.role_revision = $5
      AND b.active AND b.valid_until > clock_timestamp()
      AND (b.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership dep
        WHERE dep.id = b.membership_id AND dep.member_subject = b.recipient_subject
          AND dep.state = 'joined' AND dep.generation = b.membership_generation))
      AND r.permissions @> ARRAY[$6]::text[] FOR SHARE OF b`,
  [proof.bindingId, subject, proof.bindingGeneration,
    proof.familyId, proof.roleRevision, permission]);
  return row.rowCount === 1;
}
