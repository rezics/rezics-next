import type { ReleaseSourceEvidence } from '../source/release-evidence-contract.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { ContentLimitExceeded, type ExactReadResult } from '../../../../content/src/core.ts';
import { retainedDocumentBody } from '../../../../content/src/document-body.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, iri } from '../work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { MAX_SEARCH_RESPONSE_BYTES, SearchSnapshotMoved, assertSearchDeadline } from '../work/search-readiness.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from '../work/search-budget.ts';
import { discloseSearchMatches } from '../disclosure/search.ts';
import { visibleContentSearchRights } from '../content-publication/search.ts';
import { publicDomainRevisionsCurrent } from '../content-publication/public-domain-read.ts';
import { projectionRecipeFor, extractProjectionText } from '../content-publication/projection-recipes.ts';
import { searchText, normalizeSearchText, type SearchMatchMode } from './text.ts';

export const SEARCH_EXCERPT_COST = { revisions: 64, codePoints: 240, graphReads: 2 } as const;
export type SearchExcerpt = { status: 'available'; text: string; language: string;
  revision: string; resource: string; variant: string }
  | { status: 'unavailable'; reason: 'unavailable' | 'not-matching' | 'unsupported-format' | 'not-hydrated' };
export interface ExcerptMatch {
  matchUnit?: string; work?: string; resource?: string; variant?: string; revision?: string;
  language?: string; contribution?: string; matchedField?: string;
  disambiguation?: { context: 'main-version-default' | { kind: 'realm-local'; id: string } | null;
    contentFormat: { status: 'available'; value: string } | { status: 'unavailable' };
    releases: { status: 'available'; values: Array<{ release: string; revision: string; kind: string; year: number | null; platform: string | null; sourceEvidence: ReleaseSourceEvidence[] }> } | { status: 'unavailable' } };
  matchedPlacements?: Array<{ resource: string; work: string; occurrence: string; profile: string; title: string; revision?: string }>;
  matchedChapter?: { post: string; book: string; title: string };
}
export interface ExcerptQuery { phrase: string; matchMode?: SearchMatchMode }
const revisionUuid = (revision: string | undefined) =>
  /^urn:rezics:content:revision:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(revision ?? '')?.[1];

/** A window of actual matching text, never the first arbitrary paragraph. No
 * markup is returned, and truncation is counted in Unicode code points. */
export function matchingExcerpt(body: string, query: ExcerptQuery): string | null {
  const text = normalizeSearchText(body), folded = text.toLowerCase();
  const { tokens } = searchText(query.phrase, query.matchMode);
  const offsets = tokens.map(token => folded.indexOf(token.toLowerCase()));
  if (offsets.some(offset => offset < 0)) return null;
  // Case folding can expand characters, so locate the original code-point
  // boundary through folded prefixes rather than slicing at a folded offset.
  const first = Math.min(...offsets), points = [...text];
  let foldedUnits = 0, anchor = 0;
  while (anchor < points.length && foldedUnits < first) foldedUnits += points[anchor++]!.toLowerCase().length;
  const start = Math.max(0, anchor - 64);
  const end = Math.min(points.length, start + SEARCH_EXCERPT_COST.codePoints - 2);
  return `${start ? '…' : ''}${points.slice(start, end).join('')}${end < points.length ? '…' : ''}`;
}

/** Hydrate only a bounded selected page. The generation owner has already
 * qualified the population; these are exact current-unit/publication fences,
 * followed by the existing Content owner read and its live delivery fence. */
export async function enrichSearchExcerptPage<T extends { results: ExcerptMatch[];
  sourcePosition?: { dataEpoch: string; sequence: string };
  graphPosition?: { dataEpoch: string; sequence: string };
  contentPosition?: { dataEpoch: string; sequence: string } }>(
  deps: MainWorkDependencies, page: T, query: ExcerptQuery): Promise<T> {
  const unavailable = (reason: Extract<SearchExcerpt, { status: 'unavailable' }>['reason'] = 'unavailable'): SearchExcerpt =>
    ({ status: 'unavailable', reason });
  const excerpts = new Map<ExcerptMatch, SearchExcerpt>(page.results.map(match => [match, unavailable('not-hydrated')]));
  const formats = new Map<ExcerptMatch, string>();
  const deliver = () => {
    const result = { ...page, results: page.results.map(match => ({ ...match, excerpt: excerpts.get(match)!,
    disambiguation: { context: null, releases: { status: 'unavailable' as const }, ...match.disambiguation,
      contentFormat: formats.has(match) ? { status: 'available' as const, value: formats.get(match)! }
        : { status: 'unavailable' as const } } })) };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_SEARCH_RESPONSE_BYTES) {
      throw new PublicQueryBudgetExceeded('Search excerpts exceed the response byte bound');
    }
    return result;
  };
  const projection = deps.contentProjection, content = projection?.content;
  const position = page.sourcePosition ?? page.graphPosition;
  const selected = page.results.slice(0, SEARCH_EXCERPT_COST.revisions);
  for (const match of selected) excerpts.set(match, unavailable());
  if (!content || !projection || !position || !selected.length) return deliver();
  const candidates = selected.flatMap(match => {
    const id = revisionUuid(match.revision);
    if (!id || !match.matchUnit || !match.language) return [];
    return [{ match, id }];
  });
  if (!candidates.length) return deliver();
  const owner = await content.ownerPosition();
  const checkpoint = await projection.cursor.read(projection.consumer);
  if (owner.dataEpoch !== checkpoint.dataEpoch || owner.sequence !== checkpoint.sequence
    || page.contentPosition && (owner.dataEpoch !== page.contentPosition.dataEpoch || owner.sequence !== page.contentPosition.sequence)) {
    throw new SearchSnapshotMoved('Content excerpt owner moved before hydration');
  }
  const read = async () => {
    assertSearchDeadline();
    const rows = (await deps.environment.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?epoch ?sequence ?matchUnit ?resource ?variant ?revision ?publicationDecision
        ?eligibility ?projection ?language ?rightsBasis ?assessment WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      VALUES (?matchUnit ?revision) { ${candidates.map(({ match }) => `(${iri(match.matchUnit!)} ${iri(match.revision!)})`).join(' ')} }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?matchUnit a rv:MatchUnit ; rv:field rv:Body ; rv:disclosure rv:Public ;
        rv:resource ?resource ; rv:variant ?variant ; rv:revision ?revision ; rv:publicationDecision ?publicationDecision ;
        rv:eligibility ?eligibility ; rv:projection ?projection ; rv:language ?language }
      GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ?resource ;
        rv:contentPublicationHead ?publicationDecision ; rv:publicSearchEligibilityHead ?eligibility }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?publicationDecision a rv:ContentPublicationDecision ; rv:resource ?resource ; rv:variant ?variant ; rv:contentRevision ?revision .
        ?eligibility a rv:ContentSearchEligibilityDecision ; rv:variant ?variant ; rv:publicationDecision ?publicationDecision ;
          rv:rightsBasis ?rightsBasis ; rv:disclosure rv:Public .
        OPTIONAL { ?eligibility rv:rightsAssessment ?assessment }
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision }
      }
    } LIMIT ${SEARCH_EXCERPT_COST.revisions + 1}`, MAX_SEARCH_RESPONSE_BYTES)).results?.bindings ?? [];
    if (rows.length > SEARCH_EXCERPT_COST.revisions) throw new PublicQueryBudgetExceeded('Excerpt admissions exceed their bound');
    if (rows.some(row => row.epoch?.value !== position.dataEpoch || row.sequence?.value !== position.sequence)) {
      throw new SearchSnapshotMoved('Content excerpt graph moved during hydration');
    }
    const admissions = rows.map(row => {
      if (!row.matchUnit || !row.resource || !row.variant || !row.revision || !row.publicationDecision
        || !row.eligibility || !row.projection || !row.language || !row.rightsBasis) {
        throw new PublicQueryUnavailable('Content excerpt admission is incomplete');
      }
      return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value!.value])) as
        { matchUnit: string; resource: string; variant: string; revision: string; publicationDecision: string;
          eligibility: string; projection: string; language: string; rightsBasis: string; assessment: string | undefined };
    });
    if (new Set(admissions.map(row => row.matchUnit)).size !== admissions.length) {
      throw new PublicQueryUnavailable('Content excerpt admission is ambiguous');
    }
    return admissions.sort((a, b) => a.matchUnit.localeCompare(b.matchUnit));
  };
  const before = await read();
  const admitted = await visibleContentSearchRights(before, deps.rights?.store);
  const disclosed = new Set(await discloseSearchMatches(deps.environment, candidates.map(({ match }) => ({
    ...match, work: match.work ?? match.matchedPlacements?.[0]?.work ?? match.resource!, matchedField: 'body',
  }))));
  const visibleKeys = new Set([...disclosed].map(match => match.matchUnit));
  const picked = candidates.flatMap(candidate => {
    const proof = admitted.find(row => row.matchUnit === candidate.match.matchUnit
      && row.revision === candidate.match.revision && row.language === candidate.match.language
      && (!candidate.match.variant || row.variant === candidate.match.variant)
      && row.resource === (candidate.match.resource ?? candidate.match.matchedPlacements?.find(place =>
        (place.revision ?? candidate.match.revision) === candidate.match.revision)?.resource ?? candidate.match.matchedChapter?.post));
    return proof && visibleKeys.has(candidate.match.matchUnit) ? [{ ...candidate, proof }] : [];
  });
  const ids = [...new Set(picked.map(item => item.id))];
  if (!ids.length) return deliver();
  let exact: ExactReadResult[];
  try { exact = await content.readExactBatch(ids, async requested => new Set(requested.filter(id => ids.includes(id)))); }
  catch (error) {
    if (error instanceof ContentLimitExceeded) return deliver();
    throw error;
  }
  const budget = fusekiReadBudget.getStore();
  if (budget) {
    budget.bytesLeft -= exact.reduce((total, result) => total + (result.status === 'available' ? Buffer.byteLength(result.serializedJson) : 0), 0);
    if (budget.bytesLeft < 0) throw new PublicQueryBudgetExceeded('Content excerpts exceed the search byte budget');
  }
  const references = exact.flatMap(result => result.status === 'available' ? [result.reference] : []);
  const rights = await publicDomainRevisionsCurrent(references, deps.rights?.store);
  const readable = new Set(references.filter((_, index) => rights[index]).map(ref => ref.revisionId));
  const metadata = await content.readExactMetadataBatch(ids, async requested => new Set(requested.filter(id => ids.includes(id))));
  for (const { match, id, proof } of picked) {
    const result = exact.find(item => item.revisionId === id), fence = metadata.get(id);
    if (!result || result.status !== 'available' || !readable.has(id) || result.reference.revisionId !== id
      || result.reference.resourceId !== proof.resource || result.reference.variantId !== proof.variant
      || result.reference.language.kind !== 'tag' || result.reference.language.tag !== match.language
      || result.reference.format !== 'rezics-content-json-v1' || fence?.availability !== 'available'
      || fence.byteDigest !== result.reference.byteDigest) continue;
    formats.set(match, result.reference.format);
    const recipe = projectionRecipeFor(result.reference.model);
    if (recipe.kind !== 'text') { excerpts.set(match, unavailable('unsupported-format')); continue; }
    // The retained body owner checks document/text equality for its real format.
    if (result.body.document !== undefined || result.body.body !== undefined) retainedDocumentBody(result.body);
    const extracted = extractProjectionText(recipe, result.body, result.reference);
    const text = matchingExcerpt(extracted.text, query);
    excerpts.set(match, text === null ? unavailable('not-matching') : { status: 'available', text,
      revision: match.revision!, language: extracted.language, resource: proof.resource, variant: proof.variant });
  }
  const finalAdmissions = await read();
  if (JSON.stringify(before) !== JSON.stringify(finalAdmissions)) throw new SearchSnapshotMoved('Content excerpt publication moved');
  const finalRights = await visibleContentSearchRights(finalAdmissions, deps.rights?.store);
  const finalReferences = await publicDomainRevisionsCurrent(references, deps.rights?.store);
  const finalDisclosed = await discloseSearchMatches(deps.environment, picked.map(({ match }) => ({ ...match,
    work: match.work ?? match.matchedPlacements?.[0]?.work ?? match.resource!, matchedField: 'body' })));
  const visible = new Set(finalDisclosed.map(match => match.matchUnit));
  for (const { match, id } of picked) if (!visible.has(match.matchUnit)
    || !finalRights.some(row => row.matchUnit === match.matchUnit)
    || !finalReferences[references.findIndex(ref => ref.revisionId === id)]) { excerpts.set(match, unavailable()); formats.delete(match); }
  const [after, afterCheckpoint] = await Promise.all([content.ownerPosition(), projection.cursor.read(projection.consumer)]);
  if (after.dataEpoch !== owner.dataEpoch || after.sequence !== owner.sequence
    || afterCheckpoint.dataEpoch !== owner.dataEpoch || afterCheckpoint.sequence !== owner.sequence) {
    throw new SearchSnapshotMoved('Content excerpt owner moved during hydration');
  }
  assertSearchDeadline();
  return deliver();
}
