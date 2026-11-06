import { admitFilter, parseFilter, type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { OpenSearch, SearchRequestWork } from './opensearch.ts';
import { compileFilter } from './filter.ts';
import { searchSubjectHits } from './query.ts';
import { routeOf } from '../route/route.ts';

export type CataloguePublicationPage = Readonly<{
  subjects: readonly string[];
  exhausted: boolean;
}>;

/** Public catalogue membership for whole-query publication. Library facts never enter this population. */
export async function readCataloguePublicationPage(input: {
  client: OpenSearch;
  prefix: string;
  filter: FilterDocument;
  release: FilterRelease;
  after: string | null;
  limit: number;
  work?: SearchRequestWork;
}): Promise<CataloguePublicationPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new RangeError('Catalogue publication page exceeds its bound');
  if (input.after !== null && routeOf(input.after) === null)
    throw new TypeError('Catalogue publication continuation is not a canonical identity');
  const filter = admitFilter(parseFilter(input.filter), input.release);
  const compiled = compileFilter(filter, { prefix: 'c' });
  const result = await searchSubjectHits(input.client, input.prefix, {
    sort: 'id',
    filter: compiled.query,
    size: input.limit + 1,
    ...(input.after === null ? {} : { after: [input.after] }),
    overflowProperties: [...new Set(compiled.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : [])))],
    ...(input.work ? { work: input.work } : {}),
  });
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const hit of result.hits.slice(0, input.limit)) {
    if (seen.has(hit.id) || routeOf(hit.id) === null) continue;
    if (unique.length && hit.id <= unique.at(-1)!) throw new TypeError('Catalogue publication order is not canonical');
    seen.add(hit.id);
    unique.push(hit.id);
  }
  return { subjects: unique, exhausted: result.hits.length <= input.limit };
}
