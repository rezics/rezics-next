import { admitFilter, FilterError, FILTER_LIMITS, type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { SearchFilterDocument } from './service-contract.ts';

export type CatalogueFacetPredicate =
  | Readonly<{ kind: 'predicate'; predicate: SearchFilterDocument }>
  | Readonly<{ kind: 'empty' }>;

/** The immutable release supplies the complete fallback universe; a user predicate is never replaced. */
export function catalogueFacetPredicate(
  release: FilterRelease,
  predicate: SearchFilterDocument | undefined,
): CatalogueFacetPredicate {
  if (predicate !== undefined) return { kind: 'predicate', predicate };
  const types = Object.keys(release.types).sort();
  if (types.length === 0) return { kind: 'empty' };
  if (types.length > FILTER_LIMITS.in * FILTER_LIMITS.leaves)
    throw new FilterError('unsupported_query', '/filter', 'out_of_range');
  let nodes: FilterDocument[] = [];
  for (let offset = 0; offset < types.length; offset += FILTER_LIMITS.in)
    nodes.push({ type: { in: types.slice(offset, offset + FILTER_LIMITS.in) } });
  while (nodes.length > 1) {
    const level: FilterDocument[] = [];
    for (let offset = 0; offset < nodes.length; offset += FILTER_LIMITS.or) {
      const children = nodes.slice(offset, offset + FILTER_LIMITS.or);
      level.push(children.length === 1 ? children[0]! : { or: children });
    }
    nodes = level;
  }
  return { kind: 'predicate', predicate: admitFilter(nodes[0]!, release) };
}
