import type { ReadingBoundary } from '../reading-position/boundary.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { MAX_FRAMES } from '../projection/schema.ts';
import { GRAPH_QUERY_COST, GRAPH_QUERY_LIMITS } from '../graph-query/schema.ts';

/** A candidate names its Statement, endpoints and applicability frames. Projection endpoints
 * also require every part to be revealed. One exact batch expands those parts;
 * the boundary charges revelation lookups per batch, never per claim. */
export async function revealedGraphRecords(boundary: ReadingBoundary, references: readonly string[]) {
  const records = [...new Set(references)];
  const maxRecords = GRAPH_QUERY_LIMITS.candidates * GRAPH_QUERY_COST.statementPage.recordsPerCandidate + 1;
  const rows = records.length ? await boundary.session.query(`SELECT ?projection ?part WHERE {
    VALUES ?projection { ${records.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?projection a rv:Projection ; (rv:projectionOf|rv:frame) ?part }
  } LIMIT ${maxRecords * (MAX_FRAMES + 1) + 1}`, maxRecords * (MAX_FRAMES + 1)) : [];
  const visible = await boundary.visible([...records, ...rows.map(row => row.part!.value)]);
  for (const row of rows) if (!visible.has(row.part!.value)) visible.delete(row.projection!.value);
  return visible;
}
