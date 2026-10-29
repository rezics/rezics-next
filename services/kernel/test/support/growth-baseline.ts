import type { GrowthDatabase, Population } from './growth.ts';
import { seed } from './growth.ts';

/** Unrelated production-shaped histories keep the anchor's 64/512/4096 matching degrees unchanged. */
export const RELATION_HISTORY_BASE = 4_096;
export const RELATION_HISTORY_PER_NEIGHBOUR = 4;

/** Seed a fixed history baseline before the first measured scale, then grow it with relation degree. */
export async function growRelationHistory(
  database: GrowthDatabase,
  population: Population,
  scale: number,
  previous: number,
): Promise<void> {
  const from = previous === 0 ? 0 : RELATION_HISTORY_BASE + RELATION_HISTORY_PER_NEIGHBOUR * previous;
  const to = RELATION_HISTORY_BASE + RELATION_HISTORY_PER_NEIGHBOUR * scale;
  await seed(database, population, { from, to });
}

/** Read actual table and partial-index source cardinalities outside the measured operation. */
export async function readRelationGrowthCardinalities(database: GrowthDatabase): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const table of [
    'semantic.subject',
    'semantic.fact',
    'semantic.revision',
    'semantic.outbound_link',
    'semantic.outbound_link_count',
    'core.receipt',
    'core.outbox',
    'editorial.write_basis',
  ]) {
    const result = await database.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    sizes[table] = Number(result.rows[0]!.n);
  }
  const partial = await database.admin.query<{ terms: string; labels: string }>(
    `SELECT count(*) FILTER (WHERE kind <> 'statement')::text AS terms,
      count(*) FILTER (WHERE kind = 'label' AND operation = 'assert')::text AS labels FROM semantic.fact`,
  );
  sizes['semantic.fact_terms'] = Number(partial.rows[0]!.terms);
  sizes['semantic.fact_label'] = Number(partial.rows[0]!.labels);
  return sizes;
}
