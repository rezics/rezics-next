import type { Pool } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, ID, iri } from '../work/activate.ts';
import { MergeUnavailable } from './contract.ts';

/** Offline class guard, not an interactive merge preview. A schema tells us a
 * column can hold a native reference, not whether that reference may move.
 * JSON/array payloads also need an explicit policy even when a fixture is empty.
 * Keep these conservative candidates; a human-reviewed exclusion supplies the
 * reason for immutable receipts, exact revisions and authority bindings. */
export async function discoverOwnerIdentityReferences(pool: Pool): Promise<string[]> {
  const rows = (await pool.query<{ namespace: string; relation: string; attribute: string }>(`
    SELECT n.nspname AS namespace,c.relname AS relation,a.attname AS attribute
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND t.typname IN ('text','varchar','json','jsonb','_text','_varchar')
      AND (t.typname IN ('json','jsonb')
        OR a.attname IN ('work','target','resource','target_release','source_work','target_work',
          'participant','subject','source','survivor','realization','release','occurrence','component')
        OR EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'c'
          AND a.attnum = ANY(k.conkey) AND pg_get_constraintdef(k.oid) LIKE '%rezics%'))
    ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",a.attname COLLATE "C"`)).rows;
  return rows.map(row => `table:${row.namespace}.${row.relation}.${row.attribute}`);
}

/** Discover current graph incidence rather than reusing a manually maintained
 * predicate list. The safety net intentionally includes identity heads, owner
 * topology and administrative predicates; exclude them explicitly with reasons.
 * This corpus scan establishes coverage only for the graph under test. */
export async function discoverGraphIdentityReferences(graph: Pick<FusekiClient, 'query'>): Promise<string[]> {
  const maximumPredicates = 4096;
  const rows = (await graph.query(`SELECT DISTINCT ?predicate WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?subject ?predicate ?object .
      FILTER(isIRI(?object) && STRSTARTS(STR(?object), ${JSON.stringify(ID)})) }
    } ORDER BY ?predicate LIMIT ${maximumPredicates + 1}`, 2_097_152)).results?.bindings ?? [];
  if (rows.length > maximumPredicates || rows.some(row => !row.predicate)) {
    throw new MergeUnavailable('Identity predicate inventory exceeds its guard bound');
  }
  return rows.map(row => `predicate:${row.predicate!.value}`);
}
