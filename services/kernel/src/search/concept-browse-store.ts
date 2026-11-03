import type { Pool, PoolClient } from 'pg';
import { withConnection } from '../database/pool.ts';
import {
  CONCEPT_BROWSE_LIMITS,
  type ConceptBrowseBinding,
  type ConceptBrowseFrontier,
  type ConceptBrowseLocator,
  type ConceptBrowseState,
  type ConceptBrowseStore,
  type ConceptDescendantSelection,
} from './concept-browse.ts';

export type ConceptBrowseStorageAllowance = Readonly<{ statements: number; rows: number; bytes: number }>;
type Options = Readonly<{
  /** The owning scope plan's original expiry. Retaining again never extends it. */
  expiresAt: number;
  /** Required for worker mutations; must be the lease obtained by scope_preparation.claim. */
  leaseUntil?: number;
  clock?: () => number;
  reserve?: (allowance: ConceptBrowseStorageAllowance) => void;
}>;
const encoder = new TextEncoder();
const validKey = (value: string) =>
  typeof value === 'string' && value.length > 0 && encoder.encode(value).byteLength <= CONCEPT_BROWSE_LIMITS.keyBytes;
const definition = (selection: ConceptDescendantSelection, binding: ConceptBrowseBinding) =>
  JSON.stringify({
    kind: 'concept',
    selection: {
      concept: selection.concept,
      property: selection.property,
      scheme: selection.scheme,
      includeChildren: true,
    },
    binding: {
      release: binding.release,
      graph: binding.graph,
      scheme: binding.scheme,
      membership: binding.membership,
      principal: binding.principal,
      request: binding.request,
    },
  });
const definitionOf = (state: ConceptBrowseState) => definition(state.selection, state.binding);
const locator = (id: string, revision: string): ConceptBrowseLocator => ({ id, revision });

/** Indexed derived rows owned by one existing scope plan. No facts or permissions are retained. */
export function createConceptBrowseStore(pool: Pool, prefix: string, scopeId: string, options: Options) {
  if (!/^[0-9a-f]{64}$/.test(scopeId) || !validKey(prefix) || encoder.encode(prefix).byteLength > 128)
    throw new TypeError('Invalid concept scope locator');
  if (!Number.isSafeInteger(options.expiresAt)) throw new TypeError('Invalid concept scope expiry');
  // Copy before any asynchronous operation, including the worker lease and reservation callback.
  const { expiresAt, leaseUntil, reserve } = options;
  const now = options.clock ?? Date.now;
  const charge = (statements: number, rows: number, bytes: number) => reserve?.({ statements, rows, bytes });
  const matches = (state: ConceptBrowseState) => {
    if (state.version !== 2 || state.retained.id !== scopeId || !/^[1-9][0-9]*$/.test(state.retained.revision))
      throw new TypeError('Foreign concept scope locator');
    return [prefix, scopeId, state.retained.revision, definitionOf(state), now()];
  };
  const workerLease = () => {
    if (!Number.isSafeInteger(leaseUntil) || leaseUntil! <= now()) throw new Error('Concept worker lease expired');
    return leaseUntil!;
  };
  async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    return withConnection(pool, async (client) => {
      await client.query('BEGIN');
      try {
        const result = await run(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
  const store = {
    async create(selection: ConceptDescendantSelection, binding: ConceptBrowseBinding): Promise<ConceptBrowseLocator> {
      if (
        selection.includeChildren !== true ||
        ![selection.concept, selection.property, selection.scheme, ...Object.values(binding)].every(validKey) ||
        expiresAt <= now()
      )
        throw new TypeError('Invalid concept scope definition');
      const root = selection.concept;
      const retained = definition(selection, binding);
      // BEGIN, plan insert, two root inserts, existing-plan point read, COMMIT/ROLLBACK.
      charge(6, 4, 32768);
      return transaction(async (client) => {
        const inserted = await client.query<{ revision: string }>(
          `INSERT INTO search.scope_preparation
            (partition_no,prefix,scope_id,definition,frontier,due_at,expires_at)
          VALUES (0,$1,$2,$3,'{"kind":"concept"}',$4,$5)
          ON CONFLICT (partition_no,prefix,scope_id) DO NOTHING RETURNING revision::text`,
          [prefix, scopeId, retained, now(), expiresAt],
        );
        if (inserted.rowCount === 1) {
          await client.query(
            `INSERT INTO search.scope_preparation_concept_member (partition_no,prefix,scope_id,concept)
            VALUES (0,$1,$2,$3)`,
            [prefix, scopeId, root],
          );
          await client.query(
            `INSERT INTO search.scope_preparation_concept_frontier (partition_no,prefix,scope_id,parent)
            VALUES (0,$1,$2,$3)`,
            [prefix, scopeId, root],
          );
          return locator(scopeId, inserted.rows[0]!.revision);
        }
        const current = await client.query<{ revision: string }>(
          `SELECT revision::text FROM search.scope_preparation
          WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND definition=$3::jsonb
            AND expires_at>$4 AND state IN ('capture','ready')`,
          [prefix, scopeId, retained, now()],
        );
        if (!current.rows[0]) throw new Error('Concept scope definition changed or expired');
        return locator(scopeId, current.rows[0].revision);
      });
    },
    async read(state: ConceptBrowseState) {
      const values = matches(state);
      charge(1, 2, 32768);
      const result = await pool.query<{ state: 'capture' | 'ready'; parent: string | null; after_key: string | null }>(
        `SELECT p.state,f.parent,f.after_key FROM search.scope_preparation p
        LEFT JOIN LATERAL (
          SELECT parent,after_key FROM search.scope_preparation_concept_frontier
          WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 ORDER BY parent LIMIT 1
        ) f ON p.state='capture'
        WHERE p.partition_no=0 AND p.prefix=$1 AND p.scope_id=$2 AND p.revision=$3::bigint
          AND p.definition=$4::jsonb AND p.expires_at>$5 AND p.state IN ('capture','ready')`,
        values,
      );
      const row = result.rows[0];
      if (!row) return { status: 'retired' as const };
      if (row.state === 'ready') return { status: 'complete' as const };
      return { status: 'building' as const, next: row.parent ? { parent: row.parent, after: row.after_key } : null };
    },
    async advance(
      state: ConceptBrowseState,
      expected: ConceptBrowseFrontier,
      delta: Readonly<{ children: readonly string[]; after: string | null; exhausted: boolean }>,
    ) {
      const lease = workerLease();
      // Snapshot bounded caller data before the transaction acquires a connection.
      const parent = expected.parent,
        previous = expected.after,
        after = delta.after,
        exhausted = delta.exhausted;
      const children = [...new Set(delta.children)];
      if (
        delta.children.length > CONCEPT_BROWSE_LIMITS.pageSize ||
        !children.every(validKey) ||
        !validKey(parent) ||
        (previous !== null && !validKey(previous)) ||
        (after !== null && !validKey(after)) ||
        (!exhausted && (after === null || (previous !== null && after <= previous)))
      )
        throw new TypeError('Invalid concept frontier delta');
      const values = [...matches(state), lease, parent, previous];
      // BEGIN, owning-plan CAS, frontier change, inserted-members-to-frontier CTE, COMMIT.
      // Each admitted child can write one member and one frontier, including index entries.
      charge(6, 3 + 2 * children.length, 32768 + children.length * 8192);
      return transaction(async (client) => {
        const updated = await client.query<{ revision: string }>(
          `UPDATE search.scope_preparation p SET revision=revision+1
          WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND revision=$3::bigint
            AND definition=$4::jsonb AND expires_at>$5 AND state='capture'
            AND lease_until=$6 AND lease_until>$5
            AND EXISTS (SELECT 1 FROM search.scope_preparation_concept_frontier
              WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND parent=$7 AND after_key IS NOT DISTINCT FROM $8::text)
          RETURNING revision::text`,
          values,
        );
        if (!updated.rows[0]) return null;
        if (exhausted) {
          await client.query(
            `DELETE FROM search.scope_preparation_concept_frontier
            WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND parent=$3`,
            [prefix, scopeId, parent],
          );
        } else {
          await client.query(
            `UPDATE search.scope_preparation_concept_frontier SET after_key=$4
            WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND parent=$3`,
            [prefix, scopeId, parent, after],
          );
        }
        await client.query(
          `WITH added AS (
            INSERT INTO search.scope_preparation_concept_member (partition_no,prefix,scope_id,concept)
            SELECT 0,$1,$2,child FROM unnest($3::text[]) child
            ON CONFLICT (partition_no,prefix,scope_id,concept) DO NOTHING RETURNING concept
          ) INSERT INTO search.scope_preparation_concept_frontier (partition_no,prefix,scope_id,parent)
            SELECT 0,$1,$2,concept FROM added`,
          [prefix, scopeId, children],
        );
        return locator(scopeId, updated.rows[0].revision);
      });
    },
    async seal(state: ConceptBrowseState) {
      const lease = workerLease();
      charge(1, 2, 32768);
      const result = await pool.query<{ revision: string }>(
        `UPDATE search.scope_preparation SET state='ready',revision=revision+1,lease_until=0
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND revision=$3::bigint
          AND definition=$4::jsonb AND expires_at>$5 AND state='capture' AND lease_until=$6 AND lease_until>$5
          AND NOT EXISTS (SELECT 1 FROM search.scope_preparation_concept_frontier
            WHERE partition_no=0 AND prefix=$1 AND scope_id=$2)
        RETURNING revision::text`,
        [...matches(state), lease],
      );
      return result.rows[0] ? locator(scopeId, result.rows[0].revision) : null;
    },
    async retire(state: ConceptBrowseState) {
      charge(1, 1, 16384);
      await pool.query(
        `UPDATE search.scope_preparation SET state='retained',revision=revision+1,lease_until=0
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND revision=$3::bigint
          AND definition=$4::jsonb AND state IN ('capture','ready')`,
        matches(state).slice(0, 4),
      );
    },
    async contains(state: ConceptBrowseState, concept: string) {
      if (!validKey(concept)) return null;
      charge(1, 2, 32768);
      const result = await pool.query<{ member: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM search.scope_preparation_concept_member
          WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND concept=$6) AS member
        FROM search.scope_preparation WHERE partition_no=0 AND prefix=$1 AND scope_id=$2
          AND revision=$3::bigint AND definition=$4::jsonb AND expires_at>$5 AND state='ready'`,
        [...matches(state), concept],
      );
      return result.rows[0]?.member ?? null;
    },
    /** Release only this worker's current revision; replay cannot release a successor's lease. */
    async checkpoint(state: ConceptBrowseState, delay: number) {
      const lease = workerLease();
      if (!Number.isSafeInteger(delay) || delay < 0 || delay > 30000)
        throw new RangeError('Invalid concept retry delay');
      charge(1, 1, 16384);
      await pool.query(
        `UPDATE search.scope_preparation SET lease_until=0,due_at=$7,revision=revision+1
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND revision=$3::bigint
          AND definition=$4::jsonb AND expires_at>$5 AND state='capture' AND lease_until=$6 AND lease_until>$5`,
        [...matches(state), lease, now() + delay],
      );
    },
  } satisfies ConceptBrowseStore & { checkpoint(state: ConceptBrowseState, delay: number): Promise<void> };
  return store;
}

/** One existing maintenance tick: at most eight expired plans and eight retired cleanup prefixes.
 * Each prefix deletes at most 128 rows from each derived table. No cascade or population-sized delete.
 */
export async function cleanupConceptBrowses(pool: Pool, prefix: string, now = Date.now()) {
  await pool.query(
    `UPDATE search.scope_preparation SET state='retained',revision=revision+1,lease_until=0
    WHERE (partition_no,prefix,scope_id) IN (
      SELECT partition_no,prefix,scope_id FROM search.scope_preparation
      WHERE partition_no=0 AND prefix=$1 AND definition->>'kind'='concept'
        AND state IN ('capture','ready') AND expires_at<=$2
      ORDER BY expires_at,scope_id LIMIT 8 FOR UPDATE SKIP LOCKED
    )`,
    [prefix, now],
  );
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const retired = await client.query<{ scope_id: string }>(
        `SELECT scope_id FROM search.scope_preparation
        WHERE partition_no=0 AND prefix=$1 AND definition->>'kind'='concept' AND state='retained'
          AND frontier->>'cleaned' IS DISTINCT FROM 'true'
        ORDER BY scope_id LIMIT 8 FOR UPDATE SKIP LOCKED`,
        [prefix],
      );
      let removed = 0;
      for (const { scope_id } of retired.rows) {
        for (const [table, key] of [
          ['scope_preparation_concept_frontier', 'parent'],
          ['scope_preparation_concept_member', 'concept'],
        ] as const) {
          const keys = await client.query<{ key: string }>(
            `SELECT ${key} AS key FROM search.${table}
            WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 ORDER BY ${key} LIMIT 128 FOR UPDATE`,
            [prefix, scope_id],
          );
          // Full-key point deletes avoid an IN/ANY plan that could scan the whole closure
          // despite a bounded subquery. The returned working set is at most 128 keys.
          for (const row of keys.rows) {
            const result = await client.query(
              `DELETE FROM search.${table} WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND ${key}=$3`,
              [prefix, scope_id, row.key],
            );
            removed += result.rowCount ?? 0;
          }
        }
        await client.query(
          `UPDATE search.scope_preparation SET frontier='{"kind":"concept","cleaned":true}'
          WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND state='retained'
            AND NOT EXISTS (SELECT 1 FROM search.scope_preparation_concept_frontier WHERE partition_no=0 AND prefix=$1 AND scope_id=$2)
            AND NOT EXISTS (SELECT 1 FROM search.scope_preparation_concept_member WHERE partition_no=0 AND prefix=$1 AND scope_id=$2)`,
          [prefix, scope_id],
        );
      }
      await client.query('COMMIT');
      return removed;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
