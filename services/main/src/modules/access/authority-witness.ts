import type { PoolClient } from 'pg';
import { AdmissionDenied, AdmissionUnavailable } from './admission.ts';
import { groupBounds } from './groups.ts';

const tables = {
  principal: { generation: 'enforcement_epoch', predicate: 'active' },
  authority_subject: { generation: 'generation', predicate: 'active' },
  membership: { generation: 'generation', predicate: "state = 'joined'" },
  private_membership: { generation: 'generation', predicate: "state = 'joined'" },
  representation: { generation: 'generation', predicate: 'active AND valid_until > clock_timestamp()' },
  representation_edge: { generation: 'generation', predicate: 'active AND valid_until > clock_timestamp()' },
  permission_grant: { generation: 'generation', predicate: 'active AND valid_until > clock_timestamp()' },
  principal_permission_grant: { generation: 'generation', predicate: 'active AND valid_until > clock_timestamp()' },
  principal_agent_attribution: { generation: 'generation', predicate: 'active AND valid_until > clock_timestamp()' },
  role_binding: { generation: 'generation', predicate: 'active AND valid_until > clock_timestamp()' },
  private_role_binding: { generation: 'generation', predicate: 'active AND valid_until > clock_timestamp()' },
  group_member: { generation: 'generation', predicate: 'active' },
  private_group_member: { generation: 'generation', predicate: 'active' },
  group_permission_grant: { generation: 'generation', predicate: 'active AND valid_until > clock_timestamp()' },
  recipient_group: { generation: 'generation', predicate: 'true' },
} as const;
export type AuthorityTable = keyof typeof tables;
export interface AuthorityWitness {
  table: AuthorityTable; id: string; generation: string;
  /** Exact selected row's deadline; older witnesses are still checked live. */
  validUntil?: string;
}
export interface AuthoritySource { table: AuthorityTable; id: string | null; generation?: string | null }

/** At most one selected authority path and its bounded group ancestry. Adding
 * unrelated authority never adds work: <=16 source rows plus at most
 * groupDepth + 1 ancestor rows from the active operational profile.
 * FOR SHARE keeps every selected generation stable through the owner commit.
 * https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS */
export const AUTHORITY_WITNESS_COST = { sourceRows: 16, ancestorRows: 'groupDepth + 1',
  captureStatements: 18, checkStatements: 16 } as const;
export async function captureAuthorityWitness(client: PoolClient,
  sources: readonly AuthoritySource[]): Promise<AuthorityWitness[]> {
  try { return await captureWitness(client, sources); }
  catch (error) {
    if (error instanceof AdmissionDenied) throw error;
    throw new AdmissionUnavailable('selected authority could not be read');
  }
}

async function captureWitness(client: PoolClient,
  sources: readonly AuthoritySource[]): Promise<AuthorityWitness[]> {
  const queue = sources.filter(source => source.id !== null);
  const bounds = queue.some(source => ['group_member', 'private_group_member'].includes(source.table))
    ? await groupBounds(client) : null;
  const rowLimit = AUTHORITY_WITNESS_COST.sourceRows + (bounds ? bounds.groupDepth + 1 : 0);
  const witness = new Map<string, AuthorityWitness>();
  let expandedGroup = false;
  for (let at = 0; at < queue.length; at++) {
    const source = queue[at]!;
    const key = `${source.table}:${source.id}`;
    const prior = witness.get(key);
    if (prior) {
      if (source.generation != null && source.generation !== prior.generation) throw new AdmissionDenied('authority episode changed');
      continue;
    }
    if (witness.size >= rowLimit) throw new AdmissionDenied('authority proof exceeds its bound');
    const config = tables[source.table];
    const row = (await client.query<{ id: string; generation: string; membership_id?: string;
      membership_generation?: string; private_membership_id?: string; private_membership_generation?: string;
      group_id?: string; subject_id?: string; valid_until?: Date | number }>(`SELECT *, ${config.generation}::text AS generation
      FROM access.${source.table} WHERE id = $1 AND ${config.predicate} FOR SHARE`, [source.id])).rows[0];
    if (!row || source.generation != null && row.generation !== source.generation) throw new AdmissionDenied('selected authority changed');
    witness.set(key, { table: source.table, id: row.id, generation: row.generation,
      ...(row.valid_until instanceof Date ? { validUntil: row.valid_until.toISOString() } : {}) });
    if (source.table === 'representation' && row.subject_id) queue.push({ table: 'authority_subject', id: row.subject_id });
    if (row.membership_id) queue.push({ table: 'membership', id: row.membership_id, generation: row.membership_generation });
    if (row.private_membership_id) queue.push({ table: 'private_membership', id: row.private_membership_id,
      generation: row.private_membership_generation });
    if (!expandedGroup && row.group_id && ['group_member', 'private_group_member'].includes(source.table)) {
      expandedGroup = true;
      const groupDepth = bounds!.groupDepth;
      const path = (await client.query<{ id: string; generation: string; grant_group: string; depth: number }>(`
        WITH RECURSIVE path(id,parent_id,depth,visited) AS (
          SELECT id,parent_id,0,ARRAY[id] FROM access.recipient_group WHERE id = $1
          UNION ALL SELECT g.id,g.parent_id,p.depth + 1,p.visited || g.id
          FROM path p JOIN access.recipient_group g ON g.id = p.parent_id
          WHERE p.depth < $2 AND NOT g.id = ANY(p.visited)
            AND p.id <> (SELECT group_id FROM access.group_permission_grant WHERE id = $3)
        ) SELECT g.id,g.generation::text,gr.group_id AS grant_group,p.depth FROM path p
          JOIN access.recipient_group g ON g.id = p.id
          JOIN access.group_permission_grant gr ON gr.id = $3
          ORDER BY p.depth FOR SHARE OF g,gr`, [row.group_id, groupDepth,
        sources.find(candidate => candidate.table === 'group_permission_grant' && candidate.id)?.id])).rows;
      if (!path.length || path.at(-1)!.id !== path.at(-1)!.grant_group) throw new AdmissionDenied('selected group ancestry changed');
      for (const group of path) {
        if (witness.size >= rowLimit) throw new AdmissionDenied('authority proof exceeds its bound');
        witness.set(`recipient_group:${group.id}`, { table: 'recipient_group', id: group.id, generation: group.generation });
      }
    }
  }
  return [...witness.values()].sort((a,b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
}

/** Exact saved rows only: another valid grant cannot repair this proof. */
export async function authorityWitnessCurrent(client: PoolClient,
  witness: readonly AuthorityWitness[]): Promise<boolean> {
  try { return await witnessCurrent(client, witness); }
  catch { throw new AdmissionUnavailable('selected authority could not be read'); }
}

async function witnessCurrent(client: PoolClient,
  witness: readonly AuthorityWitness[]): Promise<boolean> {
  const ancestors = witness.filter(row => row.table === 'recipient_group').length;
  if (!witness.length || witness.length - ancestors > AUTHORITY_WITNESS_COST.sourceRows
    || ancestors && ancestors > (await groupBounds(client)).groupDepth + 1) return false;
  for (const table of Object.keys(tables) as AuthorityTable[]) {
    const selected = witness.filter(row => row.table === table);
    if (!selected.length) continue;
    const config = tables[table];
    const rows = (await client.query<{ id: string; generation: string }>(`
      SELECT id,${config.generation}::text AS generation FROM access.${table}
      WHERE id = ANY($1::${table === 'authority_subject' ? 'text' : 'uuid'}[]) AND ${config.predicate}
      ORDER BY id FOR SHARE`, [selected.map(row => row.id)])).rows;
    if (rows.length !== selected.length || rows.some(row => selected.find(saved => saved.id === row.id)?.generation !== row.generation)) return false;
  }
  return witness.every(row => Object.hasOwn(tables, row.table));
}

/** No extra reads: capture already locked every selected row through commit. */
export function authorityWitnessDeadline(witness: readonly AuthorityWitness[]): string | null {
  const deadlines = witness.flatMap(row => row.validUntil ? [row.validUntil] : []);
  return deadlines.length ? new Date(Math.min(...deadlines.map(Date.parse))).toISOString() : null;
}
