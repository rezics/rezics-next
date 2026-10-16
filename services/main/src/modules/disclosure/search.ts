import type { SearchPlacement } from '../structure/searchable-placements.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { currentDisclosureViewer } from './viewer.ts';
import { discloseInventory, hasDisclosure, DisclosureUnavailable, type DisclosureTarget } from './read.ts';
import { publicWork } from '../work/public-patterns.ts';

export interface SearchDisclosureMatch {
  work: string;
  contribution?: string;
  revision?: string;
  matchedField?: string;
  /** A credited name belongs to its participant, independently of the Work. */
  nameOwner?: string;
  matchedPlacements?: SearchPlacement[];
  matchedChapter?: { post: string; book: string };
}
/** Gate the complete candidate relation before ranking, pagination, counts or facets.
 * At most 512 candidates, one head batch and at most 32 owner batches. */
export async function discloseSearchMatches<T extends SearchDisclosureMatch>(env: WorkActivationEnvironment,
  matches: readonly T[], channel: 'search' | 'typeahead' = 'search'): Promise<T[]> {
  if (matches.length > 512) throw new DisclosureUnavailable('Search disclosure exceeds its bound');
  if (!hasDisclosure(env)) return [...matches];
  const sourceOf = (match: SearchDisclosureMatch) => match.matchedPlacements?.[0]?.resource ?? match.matchedChapter?.post;
  const hasPlacements = matches.some(match => sourceOf(match) !== undefined);
  const resources = [...new Set(matches.flatMap(match => [match.work, ...(sourceOf(match) ? [sourceOf(match)!] : [])]))];
  if (!resources.length) return [];
  // Content eligibility exposes an exact body, not its Work's publication.
  // Reuse the Work reader's candidate predicate for placed Work targets, while
  // independently published resources keep their existing disclosure checks.
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    SELECT ?work ?head${hasPlacements ? `
      ((!EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork } }
        || EXISTS { ${publicWork('?work', '?sourceMain')} }) AS ?sourceVisible)` : ''} WHERE {
    VALUES ?work { ${resources.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head }
  } LIMIT ${resources.length + 1}`, 131_072)).results?.bindings ?? [];
  const heads = new Map(rows.flatMap(row => row.work && row.head ? [[row.work.value, row.head.value] as const] : []));
  if (rows.length !== resources.length || heads.size !== resources.length) {
    throw new DisclosureUnavailable('Search disclosure heads are incomplete');
  }
  const visibleSources = new Set(rows.flatMap(row => row.work && row.sourceVisible?.value === 'true'
    ? [row.work.value] : []));
  const targets: DisclosureTarget[] = [], ranges: number[][] = [];
  for (const match of matches) {
    const selected: DisclosureTarget[] = [{ owner: 'graph', resource: match.work,
      component: 'name', revision: heads.get(match.work), nameOwner: match.nameOwner }];
    const source = sourceOf(match);
    if (source) selected.push({ owner: 'graph', resource: source,
      component: 'name', revision: heads.get(source) });
    if (!match.matchedField || match.matchedField === 'body') {
      selected.push({ owner: 'content', resource: source ?? match.work, component: 'body',
        revision: match.revision?.replace(/^urn:rezics:content:revision:/, '') ?? null,
        work: match.work, workRevision: heads.get(match.work) });
      if (match.contribution && !source) selected.push({ owner: 'graph', resource: match.contribution,
        component: 'body', revision: match.revision, work: match.work, workRevision: heads.get(match.work) });
    }
    ranges.push(selected.map((_, index) => targets.length + index));
    targets.push(...selected);
  }
  const decisions = await discloseInventory(env, targets, currentDisclosureViewer(), channel);
  return matches.filter((match, index) => (!sourceOf(match) || visibleSources.has(sourceOf(match)!))
    && ranges[index]!.every(ordinal => decisions[ordinal] === 'visible'));
}
