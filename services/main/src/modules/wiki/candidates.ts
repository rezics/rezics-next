import { Value } from 'typebox/value';
import { admittedTypes, onTypeRegistryChange, resourceTypeAdmitted } from '../types/registry.ts';
import { canonicalLanguage } from '../display-language/tag.ts';
import { readWorkComponentState } from '../work/history.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { PROFILES, semanticTypeOutcome } from '../semantic/schema.ts';
import { CANONICAL_TYPES } from '../semantic/change.ts';
import { targetSummaries } from '../target/resolve.ts';
import { readingPositionRead } from '../reading-position/read.ts';
import type { ReadingBoundary } from '../reading-position/boundary.ts';
import { propertyRevelationRecord, REVELATION_COST } from '../reading-position/store.ts';
import { WikiCandidatesSchema, WikiNativeResourceSchema, type WikiCandidates, WIKI_EXTRACTION_LIMITS } from './protocol.ts';
import { WikiRejected } from './errors.ts';
import { wikiMembers, wikiScope, WIKI_READ_COST, type WikiRead } from './read.ts';

export const WIKI_CANDIDATES_COST = { names: 64, candidatesPerName: 16,
  nameRecordQueries: 1, nameRecordsPerEntity: 64, normalizedLabels: 512 * 64,
  revelationRecords: 512 * (1 + 64 + 64), revelationBatch: REVELATION_COST.batch,
  comparisons: 64 * 512 * 64, ...WIKI_READ_COST } as const;
const admittedWikiTypes = new Set<string>();
export const wikiTypes: ReadonlySet<string> = admittedWikiTypes;
function refreshWikiTypes() {
  admittedWikiTypes.clear();
  for (const entry of admittedTypes) if (entry.base === 'resource' && !entry.default && entry.wikiSegment
    && resourceTypeAdmitted(entry.type) && semanticTypeOutcome(entry.type) === 'admitted'
    && !CANONICAL_TYPES.has(entry.type)) admittedWikiTypes.add(entry.type);
}
onTypeRegistryChange(refreshWikiTypes);
refreshWikiTypes();
export const wikiLabel = (value: string) => value.normalize('NFKC').trim().toLowerCase();

/** Bound the complete disclosed match set. A match that loses read authority
 * is indistinguishable from its absence, including a collision with a public alias. */
export function candidateItems(matches: readonly ReadonlySet<string>[], availability: ReadonlyMap<string, boolean>) {
  if (matches.length > WIKI_EXTRACTION_LIMITS.namesPerLookup) throw new WikiRejected('invalid_wiki_candidates', 400);
  return matches.map((match, index) => {
    const candidates = [...match].filter(target => availability.get(target)).sort();
    if (candidates.length > WIKI_EXTRACTION_LIMITS.candidatesPerName) throw new WikiRejected('wiki_query_budget');
    return { index, status: candidates.length === 0 ? 'new' as const : candidates.length === 1 ? 'matched' as const : 'ambiguous' as const,
      candidates };
  });
}

/** One complete bounded read, including a per-resource guard against skew. */
export async function readCandidateNameRecords(session: Pick<WikiRead['session'], 'query'>, resources: readonly string[],
  boundary?: Pick<ReadingBoundary, 'visible'>) {
  if (resources.length > WIKI_READ_COST.inventory) throw new WikiRejected('wiki_query_budget');
  const labels = new Map(resources.map(resource => [resource, [] as string[]]));
  if (!resources.length) return labels;
  const limit = resources.length * WIKI_CANDIDATES_COST.nameRecordsPerEntity;
  const rows = await session.query(`SELECT ?resource ?label ?name WHERE {
    VALUES ?resource { ${resources.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?resource rv:nameRecord ?name .
      ?name <http://www.w3.org/2008/05/skos-xl#literalForm> ?label . }
  } LIMIT ${limit + 1}`, limit);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const recorded = row.resource && labels.get(row.resource.value);
    if (!recorded || !row.label || boundary && !row.name) throw new WikiRejected('wiki_unavailable', 503);
    const count = (counts.get(row.resource!.value) ?? 0) + 1;
    counts.set(row.resource!.value, count);
    if (count > WIKI_CANDIDATES_COST.nameRecordsPerEntity) throw new WikiRejected('wiki_query_budget');
  }
  const visible = boundary ? await boundary.visible(rows.map(row => row.name!.value)) : null;
  for (const row of rows) if (!visible || visible.has(row.name!.value)) labels.get(row.resource!.value)!.push(row.label!.value);
  return labels;
}

/** Match only exact property values admitted by the shared reading boundary. */
export async function candidatePropertyLabels(boundary: Pick<ReadingBoundary, 'visible'>, resource: string,
  properties: Array<{ predicate: string; value: { kind: string; lexical?: string; language?: string } }>) {
  const names = properties.filter(property =>
    ['https://schema.org/name', 'https://schema.org/alternateName',
      'http://www.w3.org/2004/02/skos/core#prefLabel', 'http://www.w3.org/2004/02/skos/core#altLabel'].includes(property.predicate)
    && property.value.lexical && ['string', 'language-string'].includes(property.value.kind));
  if (names.length > WIKI_CANDIDATES_COST.nameRecordsPerEntity) throw new WikiRejected('wiki_query_budget');
  const records = names.map(property => propertyRevelationRecord(resource, property.predicate, property.value));
  const visible = await boundary.visible(records);
  return names.flatMap((property, index) => visible.has(records[index]!) ? [property.value.lexical!] : []);
}

/** Exact normalized label/alias equality across language tags, never inferred equivalence. */
export async function wikiCandidates(read: WikiRead, input: WikiCandidates) {
  if (!Value.Check(WikiCandidatesSchema, input)
    || !Value.Check(WikiNativeResourceSchema, input.target)
    || !Value.Check(WikiNativeResourceSchema, input.zone)) throw new WikiRejected('invalid_wiki_candidates', 400);
  const names = input.names.map(name => {
    const language = canonicalLanguage(name.language);
    if (!language) throw new WikiRejected('invalid_language', 400);
    if (!wikiLabel(name.value)) throw new WikiRejected('invalid_wiki_candidates', 400);
    if (name.type && !wikiTypes.has(name.type)) throw new WikiRejected('wiki_entity_type');
    return { ...name, normalized: wikiLabel(name.value) };
  });
  return readingPositionRead(read.work, read.session.request, read.principal, read.actingSubject, async boundary => {
    const scope = await wikiScope(read, input.target, input.zone);
    const inventory = await wikiMembers(read, scope.collections);
    const visibleMembers = await boundary.visible(inventory);
    const members = inventory.filter(member => visibleMembers.has(member));
    const rows = members.length ? await read.session.query(`SELECT ?resource ?manifest WHERE {
      VALUES ?resource { ${members.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?resource rv:semanticHead ?head }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:SemanticRevision ; rv:component ?resource ;
        rv:lifecycle rv:Active ; rv:manifest ?manifest }
    } LIMIT ${WIKI_READ_COST.inventory + 1}`, WIKI_READ_COST.inventory) : [];
    const matches = names.map(() => new Set<string>());
    const seen = new Set<string>();
    const candidates: Array<{ resource: string; types: string[]; labels: string[] }> = [];
    for (const row of rows) {
      if (!row.resource || !row.manifest || seen.has(row.resource.value)) throw new WikiRejected('wiki_unavailable', 503);
      seen.add(row.resource.value);
      const state = await readWorkComponentState(read.work.environment, row.manifest.value, row.resource.value, PROFILES.resource);
      if (state.component !== 'resource' || state.lifecycle !== 'active' || !Array.isArray(state.types)
        || !Array.isArray(state.properties)) throw new WikiRejected('wiki_unavailable', 503);
      const types = state.types as string[];
      if (!types.some(type => wikiTypes.has(type))) continue;
      const labels = await candidatePropertyLabels(boundary, row.resource.value, state.properties as
        Array<{ predicate: string; value: { kind: string; lexical?: string; language?: string } }>);
      candidates.push({ resource: row.resource.value, types, labels });
    }
    const recorded = await readCandidateNameRecords(read.session, candidates.map(candidate => candidate.resource), boundary);
    for (const { resource, types, labels } of candidates) {
      labels.push(...recorded.get(resource)!);
      if (labels.length > WIKI_CANDIDATES_COST.nameRecordsPerEntity) throw new WikiRejected('wiki_query_budget');
      const normalizedLabels = new Set(labels.map(wikiLabel));
      names.forEach((name, index) => {
        if ((!name.type || types.includes(name.type)) && normalizedLabels.has(name.normalized)) {
          matches[index]!.add(resource);
        }
      });
    }
    const availability = new Map<string, boolean>();
    // Recheck current disclosure after matching: a revoked member cannot alter
    // either the status or the candidate list, even when it shares a readable alias.
    const matched = [...new Set(matches.flatMap(match => [...match]))];
    for (let start = 0; start < matched.length; start += WIKI_READ_COST.targetBatch) {
      const summaries = await targetSummaries(read.session, matched.slice(start, start + WIKI_READ_COST.targetBatch));
      for (const summary of summaries.summaries) availability.set(summary.reference, summary.status === 'available');
    }
    return { profile: 'wiki-candidates-v1' as const, items: candidateItems(matches, availability) };
  });
}
