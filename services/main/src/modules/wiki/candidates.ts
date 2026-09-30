import { Value } from 'typebox/value';
import { admittedTypes } from '../types/registry.ts';
import { canonicalLanguage } from '../display-language/tag.ts';
import { readWorkComponentState } from '../work/history.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { PROFILES, semanticTypeOutcome } from '../semantic/schema.ts';
import { CANONICAL_TYPES } from '../semantic/change.ts';
import { resolveTargets, targetSummaries } from '../target/resolve.ts';
import { WikiCandidatesSchema, type WikiCandidates, WIKI_EXTRACTION_LIMITS } from './protocol.ts';
import { WikiRejected } from './errors.ts';
import { wikiMembers, wikiScope, WIKI_READ_COST, type WikiRead } from './read.ts';

export const WIKI_CANDIDATES_COST = { names: 64, candidatesPerName: 16,
  nameRecordsPerEntity: 64, normalizedLabels: 512 * 64, comparisons: 64 * 512, ...WIKI_READ_COST } as const;
export const wikiTypes: ReadonlySet<string> = new Set(admittedTypes.filter(entry => entry.base === 'resource'
  && !entry.default && semanticTypeOutcome(entry.type) === 'admitted'
  && !CANONICAL_TYPES.has(entry.type)).map(entry => entry.type));
export const wikiLabel = (value: string) => value.normalize('NFKC').trim().toLowerCase();

/** A complete match set must fit the wire bound; never silently truncate it.
 * One restricted match makes the entire name unavailable, with no hidden count. */
export function candidateItems(matches: readonly ReadonlySet<string>[], availability: ReadonlyMap<string, boolean>) {
  if (matches.length > WIKI_EXTRACTION_LIMITS.namesPerLookup) throw new WikiRejected('invalid_wiki_candidates', 400);
  return matches.map((match, index) => {
    if ([...match].some(target => !availability.get(target))) return { index, status: 'unavailable' as const, candidates: [] };
    if (match.size > WIKI_EXTRACTION_LIMITS.candidatesPerName) throw new WikiRejected('wiki_query_budget');
    return { index, status: match.size === 0 ? 'new' as const : match.size === 1 ? 'matched' as const : 'ambiguous' as const,
      candidates: [...match].sort() };
  });
}

/** Exact normalized label/alias equality, never inferred equivalence. */
export async function wikiCandidates(read: WikiRead, input: WikiCandidates) {
  if (!Value.Check(WikiCandidatesSchema, input)) throw new WikiRejected('invalid_wiki_candidates', 400);
  const names = input.names.map(name => {
    const language = canonicalLanguage(name.language);
    if (!language) throw new WikiRejected('invalid_language', 400);
    if (!wikiLabel(name.value)) throw new WikiRejected('invalid_wiki_candidates', 400);
    if (name.type && !wikiTypes.has(name.type)) throw new WikiRejected('wiki_entity_type');
    return { ...name, language, normalized: wikiLabel(name.value) };
  });
  const scope = await wikiScope(read, input.target, input.zone);
  const members = await wikiMembers(read, scope.collections);
  const rows = members.length ? await read.session.query(`SELECT ?resource ?manifest WHERE {
    VALUES ?resource { ${members.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?resource rv:semanticHead ?head }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:SemanticRevision ; rv:component ?resource ;
      rv:lifecycle rv:Active ; rv:manifest ?manifest }
  } LIMIT ${WIKI_READ_COST.inventory + 1}`, WIKI_READ_COST.inventory) : [];
  const matches = names.map(() => new Set<string>());
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.resource || !row.manifest || seen.has(row.resource.value)) throw new WikiRejected('wiki_unavailable', 503);
    seen.add(row.resource.value);
    const state = await readWorkComponentState(read.work.environment, row.manifest.value, row.resource.value, PROFILES.resource);
    if (state.component !== 'resource' || state.lifecycle !== 'active' || !Array.isArray(state.types)
      || !Array.isArray(state.properties)) throw new WikiRejected('wiki_unavailable', 503);
    const types = state.types as string[];
    if (!types.some(type => wikiTypes.has(type))) continue;
    const labels = (state.properties as Array<{ predicate: string;
      value: { kind: string; lexical?: string; language?: string } }>).filter(property =>
      ['https://schema.org/name', 'https://schema.org/alternateName',
        'http://www.w3.org/2004/02/skos/core#prefLabel', 'http://www.w3.org/2004/02/skos/core#altLabel'].includes(property.predicate))
      .flatMap(property => property.value.lexical && ['string', 'language-string'].includes(property.value.kind)
        ? [{ value: property.value.lexical, language: canonicalLanguage(property.value.language ?? 'en') }] : []);
    const recorded = await read.session.query(`SELECT ?label WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(row.resource.value)} rv:nameRecord ?name .
      ?name <http://www.w3.org/2008/05/skos-xl#literalForm> ?label .
    } } LIMIT 65`, 64);
    labels.push(...recorded.flatMap(item => item.label ? [{ value: item.label.value,
      language: canonicalLanguage(item.label['xml:lang'] ?? 'en') }] : []));
    if (labels.length > WIKI_CANDIDATES_COST.nameRecordsPerEntity) throw new WikiRejected('wiki_query_budget');
    const normalizedLabels = new Set(labels.filter(label => label.language)
      .map(label => `${label.language}\0${wikiLabel(label.value)}`));
    names.forEach((name, index) => {
      if ((!name.type || types.includes(name.type)) && normalizedLabels.has(`${name.language}\0${name.normalized}`)) {
        matches[index]!.add(row.resource!.value);
      }
    });
  }
  const availability = new Map<string, boolean>();
  // Resolution alone owns current disclosure; restricted candidate identities
  // and their stored names never cross this response boundary.
  const matched = [...new Set(matches.flatMap(match => [...match]))];
  for (let start = 0; start < matched.length; start += WIKI_READ_COST.targetBatch) {
    const summaries = await targetSummaries(read.session, matched.slice(start, start + WIKI_READ_COST.targetBatch));
    const available = summaries.summaries.flatMap(summary => summary.status === 'available' ? [summary.reference] : []);
    for (const target of await (available.length ? resolveTargets(read.session, available, 'collection-member') : [])) {
      availability.set(target.resource, true);
    }
    for (const summary of summaries.summaries) if (summary.status !== 'available') availability.set(summary.reference, false);
  }
  return { profile: 'wiki-candidates-v1' as const, items: candidateItems(matches, availability) };
}
