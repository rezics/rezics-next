import type { Exposure } from '../access/exposure.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';

/** One indexed VALUES read per 64 resolved resources, at most five type rows
 * per resource. No grant or resource inventory is traversed. */
export const SELECTED_SEMANTIC_CAPABILITY_COST = { resources: 64, types: 5, graphBytes: 65_536 } as const;

export function semanticTypeCapabilities(types: readonly string[]): Exposure[] {
  const selected: Exposure[] = [];
  if (types.some(type => type === 'https://schema.org/Event' || type === `${RV}Event`))
    selected.push('platform:events');
  if (types.some(type => type === 'https://schema.org/Offer' || type === 'https://schema.org/Product'
    || type === `${RV}RightsOffering`)) selected.push('platform:commerce');
  return selected.length ? selected : ['public'];
}

/** Retained server types also select exposure: deleting a closed type from the
 * proposed state cannot turn an edit of that resource into a public command. */
export async function resolvedSemanticCapabilities(env: WorkActivationEnvironment,
  resources: readonly string[], types: readonly string[] = []): Promise<Exposure[]> {
  const resolved = [...types];
  const unique = [...new Set(resources)];
  for (let offset = 0; offset < unique.length; offset += SELECTED_SEMANTIC_CAPABILITY_COST.resources) {
    const batch = unique.slice(offset, offset + SELECTED_SEMANTIC_CAPABILITY_COST.resources);
    const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?type WHERE {
      VALUES ?resource { ${batch.map(iri).join(' ')} }
      VALUES ?type { <https://schema.org/Event> rv:Event <https://schema.org/Offer>
        <https://schema.org/Product> rv:RightsOffering }
      GRAPH ${iri(GRAPHS.current)} { ?resource a ?type }
    } LIMIT ${batch.length * SELECTED_SEMANTIC_CAPABILITY_COST.types + 1}`,
    SELECTED_SEMANTIC_CAPABILITY_COST.graphBytes);
    const rows = result.results?.bindings ?? [];
    if (rows.length > batch.length * SELECTED_SEMANTIC_CAPABILITY_COST.types)
      throw new Error('selected resource type budget exceeded');
    resolved.push(...rows.flatMap(row => row.type ? [row.type.value] : []));
  }
  return semanticTypeCapabilities(resolved);
}
