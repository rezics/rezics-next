import { fallbackLanguage, realmLanguage } from './selection-heads.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY, RATING_STANDING_CADENCE }
  from '../rating/context.ts';
import { STANDING_RATING_OBSERVATION_PROFILE } from '../rating/observation.ts';
import { term } from '../context/command.ts';
import { SELECTION_POLICY } from '../space/create.ts';
import { DATASET, GRAPHS, RV, iri, lit, PUBLIC_SEARCH_ANCHOR,
  type WorkActivationEnvironment } from './activate.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from './search-budget.ts';
import { PublicRealmUnavailable } from './search-public.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { assertPublicTextReady, assertSameTextInstance, assertSnapshotMoved, MAX_SEARCH_RESPONSE_BYTES,
  PHRASE_HIT_PROBE, SearchSnapshotMoved } from './search-readiness.ts';

export const GROUPED_RATED_COST = {
  coreArqReads: 1, maxRawTextCandidates: PHRASE_HIT_PROBE - 1,
  maxRatingSlots: 100, maxReturnedRows: 20,
  maxCoreResponseBytes: MAX_SEARCH_RESPONSE_BYTES,
} as const;
const MAX_RATING_SLOTS = GROUPED_RATED_COST.maxRatingSlots;
export const MAX_GROUPED_ROWS = GROUPED_RATED_COST.maxReturnedRows;

export interface GroupedRatingInput { context: string; minimumMeanTimes10: number }
export interface GroupedRating { context: string; count: number; sum: number; mean: number;
  precision: { kind: 'exact-rational'; numerator: number; denominator: number } }

interface Binding { value: string }
export interface RatedGroupBinding {
  epoch?: Binding; sequence?: Binding; indexGeneration?: Binding; candidateCount?: Binding;
  ratingPopulation?: Binding; ratingRows?: Binding; ratingUniqueSlots?: Binding;
  ratingValidRows?: Binding; unit?: Binding; score?: Binding; work?: Binding; main?: Binding;
  contribution?: Binding; bodyRevision?: Binding; selection?: Binding; language?: Binding;
  reason?: Binding; ratingCount?: Binding; ratingSum?: Binding; ratingTargetPopulation?: Binding;
  occurrence?: Binding; participant?: Binding; statement?: Binding; applicability?: Binding;
}

const integer = (value: Binding | undefined) => {
  const number = Number(value?.value);
  return value && Number.isSafeInteger(number) && number >= 0 ? number : null;
};

/** One bounded ARQ read binds selected public text, current standing ratings,
 * the active relation occurrence and direct Statement subjects. A 21st row is
 * a budget result even when its text unit has no grouped Statement candidate. */
export async function queryPublicGroupedRatedCore(env: WorkActivationEnvironment,
  input: { realm: string; phrase: string; language: string; rating: GroupedRatingInput;
    relationDefinition: string; workRole: string; participantRole: string;
    predicates: readonly string[] }): Promise<{
      phrase: { contractVersion: string; resultGrain: 'mainVersion';
        context: { kind: 'realm-local'; id: string }; complete: true; population: number;
        total: number; indexGeneration: string;
        sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
        results: Array<{ matchUnit: string; work: string; mainVersion: string;
          contribution: string; revision: string; selection: string; language: string;
          reason: string; score: number; rating: GroupedRating }> };
      bindings: RatedGroupBinding[]; ratingPopulation: number;
    }> {
  const index = await assertPublicTextReady(env.fuseki, env.lineage);
  const normalized = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const lucene = `"${normalized.replace(/[\\"]/gu, '\\$&')}"`;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    PREFIX schema: <https://schema.org/>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?epoch ?sequence ?indexGeneration ?candidateCount ?ratingPopulation
      ?ratingRows ?ratingUniqueSlots ?ratingValidRows ?unit ?score ?work ?main
      ?contribution ?bodyRevision ?selection ?language ?reason ?ratingCount ?ratingSum
      ?ratingTargetPopulation ?occurrence ?participant ?statement
      (GROUP_CONCAT(DISTINCT STR(?app); separator="|") AS ?applicability) WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
        rv:textIndexGeneration ?indexGeneration .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . }
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(input.realm)} ; rv:disclosure rv:Public .
        ${iri(input.realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} ;
          rv:ratingContext ${iri(input.rating.context)} .
        ${iri(input.rating.context)} a rv:RatingContext ; rv:contextState rv:Active ;
          rv:realm ${iri(input.realm)} ; rv:targetGrain rv:MainVersion ;
          rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
          rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
          rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
          rv:head ?ratingContextRevision .
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?ratingContextRevision a rv:RevisionAnchor ;
        rv:component ${iri(input.rating.context)} . }
      { SELECT (COUNT(?rawUnit) AS ?candidateCount) WHERE {
        { SELECT ?rawUnit WHERE { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?rawUnit ?rawScore) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
        } } LIMIT ${PHRASE_HIT_PROBE} }
      } }
      { SELECT (COUNT(DISTINCT ?ratingCandidate) AS ?ratingPopulation) WHERE {
        { SELECT DISTINCT ?ratingCandidate WHERE { GRAPH ${iri(GRAPHS.current)} {
          ?ratingCandidate a rv:RatingObservation ;
            rv:ratingContext ${iri(input.rating.context)} .
        } } LIMIT ${MAX_RATING_SLOTS + 1} }
      } }
      { SELECT (COUNT(?auditObservation) AS ?ratingRows)
          (COUNT(DISTINCT ?auditSlot) AS ?ratingUniqueSlots)
          (SUM(IF(COALESCE(BOUND(?auditMain) && BOUND(?auditManifest)
            && REGEX(STR(?auditSlot), "^urn:rezics:rating-slot:[0-9a-f]{64}$")
            && ((?auditAvailability = rv:Available
              && ?auditValue IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
              || (?auditAvailability = rv:Withdrawn && !BOUND(?auditValue))),
            false), 1, 0)) AS ?ratingValidRows)
        WHERE {
          { SELECT DISTINCT ?auditObservation WHERE { GRAPH ${iri(GRAPHS.current)} {
            ?auditObservation a rv:RatingObservation ;
              rv:ratingContext ${iri(input.rating.context)} .
          } } LIMIT ${MAX_RATING_SLOTS + 1} }
          GRAPH ${iri(GRAPHS.current)} {
            OPTIONAL { ?auditObservation rv:targetMainVersion ?auditMain ;
              rv:ratingSlot ?auditSlot ; rv:observationHead ?auditHead .
              OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
                ?auditHead a rv:RatingObservationRevision, rv:RevisionAnchor ;
                  rv:component ?auditObservation ; rv:observation ?auditObservation ;
                  rv:modelRevision ${iri(STANDING_RATING_OBSERVATION_PROFILE)} ;
                  rv:ratingAvailability ?auditAvailability ; rv:manifest ?auditManifest .
                OPTIONAL { ?auditHead rv:ratingValue ?auditValue }
              } }
            }
          }
        }
      }
      OPTIONAL {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) .
          ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
            rv:work ?work ; rv:mainVersion ?main ; rv:context ?unitContext ;
            rv:contribution ?contribution ; rv:revision ?bodyRevision ;
            rv:selection ?selection ; rv:language ?language .
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?work a schema:CreativeWork ; rv:mainVersion ?main .
          ?main a rv:MainVersion ; rv:work ?work .
        }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
          ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(input.realm)} ;
            rv:mainVersion ?main ; rv:selectionHead ?localSelection . }
          ${realmLanguage('?localSelection', '?language')} }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?main rv:selectionHead ?fallbackSelection }
          ${fallbackLanguage('?fallbackSelection', '?language')} }
        BIND(COALESCE(?localSelection, ?fallbackSelection) AS ?effectiveSelection)
        BIND(IF(BOUND(?localSelection), ${iri(input.realm)}, ?main) AS ?effectiveContext)
        BIND(IF(BOUND(?localSelection), "realm-adoption", "main-fallback") AS ?reason)
        FILTER(?selection = ?effectiveSelection && ?unitContext = ?effectiveContext
          && ?language = ${lit(input.language)})
        { SELECT ?main (COUNT(?observation) AS ?ratingTargetPopulation)
            (SUM(IF(?availability = rv:Available, 1, 0)) AS ?ratingCount)
            (SUM(IF(?availability = rv:Available, ?value, 0)) AS ?ratingSum)
          WHERE {
            { SELECT DISTINCT ?observation WHERE { GRAPH ${iri(GRAPHS.current)} {
              ?observation a rv:RatingObservation ;
                rv:ratingContext ${iri(input.rating.context)} .
            } } LIMIT ${MAX_RATING_SLOTS + 1} }
            GRAPH ${iri(GRAPHS.current)} {
              ?observation rv:targetMainVersion ?main ; rv:observationHead ?head .
            }
            GRAPH ${iri(GRAPHS.revisions)} {
              ?head a rv:RatingObservationRevision, rv:RevisionAnchor ;
                rv:component ?observation ; rv:observation ?observation ;
                rv:modelRevision ${iri(STANDING_RATING_OBSERVATION_PROFILE)} ;
                rv:ratingAvailability ?availability .
              OPTIONAL { ?head rv:ratingValue ?value }
            }
          } GROUP BY ?main
        }
        FILTER(?ratingCount > 0 && 10 * ?ratingSum >=
          ${input.rating.minimumMeanTimes10} * ?ratingCount)
        OPTIONAL {
          GRAPH ${iri(GRAPHS.current)} {
            ?occurrence a rv:RelationOccurrence ;
              rv:relationDefinition ${iri(input.relationDefinition)} ;
              rv:occurrenceHead ?relationRevision .
            ?statement a rdf:Statement ; rv:statementState rv:Active ;
              rdf:subject ?participant ; rdf:predicate ?predicate .
            VALUES ?predicate { ${input.predicates.map(term).join(' ')} }
          }
          GRAPH ${iri(GRAPHS.revisions)} {
            ?relationRevision a rv:RelationOccurrenceRevision ; rv:component ?occurrence ;
              rv:lifecycle rv:Active ; rv:participation ?workPart, ?participantPart .
            ?workPart rv:role ${iri(input.workRole)} ; rv:participant ?workEndpoint .
            ?participantPart rv:role ${iri(input.participantRole)} ;
              rv:participant ?participant .
          }
          FILTER(?workEndpoint = ?work || ?workEndpoint = ?main)
          OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?occurrence rv:applicability ?app } }
        }
      }
    } GROUP BY ?epoch ?sequence ?indexGeneration ?candidateCount ?ratingPopulation
      ?ratingRows ?ratingUniqueSlots ?ratingValidRows ?unit ?score ?work ?main
      ?contribution ?bodyRevision ?selection ?language ?reason ?ratingCount ?ratingSum
      ?ratingTargetPopulation ?occurrence ?participant ?statement
    ORDER BY DESC(?score) STR(?work) STR(?occurrence) STR(?participant) STR(?statement)
    LIMIT ${MAX_GROUPED_ROWS + 1}`, MAX_SEARCH_RESPONSE_BYTES);
  await assertSameTextInstance(env.fuseki, index);
  const rows = (result.results?.bindings ?? []) as RatedGroupBinding[];
  if (!rows.length) {
    await assertSnapshotMoved(env.fuseki, index);
    throw new PublicRealmUnavailable('Realm or rated grouped scope is unavailable');
  }
  if (rows.some(row => row.epoch?.value !== rows[0]?.epoch?.value
    || row.sequence?.value !== rows[0]?.sequence?.value
    || row.indexGeneration?.value !== index.generation)) {
    throw new SearchSnapshotMoved('rated grouped relation moved');
  }
  const first = rows[0]!;
  if (first.epoch?.value !== index.dataEpoch || !first.sequence
    || !/^(0|[1-9][0-9]*)$/u.test(first.sequence.value)
    || BigInt(first.sequence.value) < BigInt(index.sequence)) {
    throw new SearchSnapshotMoved('rated grouped source moved');
  }
  const candidateCount = integer(first.candidateCount);
  const ratingPopulation = integer(first.ratingPopulation);
  const audits = [integer(first.ratingRows), integer(first.ratingUniqueSlots),
    integer(first.ratingValidRows)];
  if (candidateCount === null || ratingPopulation === null || audits.some(value => value === null)
    || rows.some(row => row.candidateCount?.value !== first.candidateCount?.value
      || row.ratingPopulation?.value !== first.ratingPopulation?.value
      || row.ratingRows?.value !== first.ratingRows?.value
      || row.ratingUniqueSlots?.value !== first.ratingUniqueSlots?.value
      || row.ratingValidRows?.value !== first.ratingValidRows?.value)) {
    throw new PublicQueryUnavailable('rated grouped population proof is unavailable');
  }
  if (candidateCount >= PHRASE_HIT_PROBE || ratingPopulation > MAX_RATING_SLOTS
    || rows.length > MAX_GROUPED_ROWS) {
    throw new PublicQueryBudgetExceeded('rated grouped candidate population exceeds its bound');
  }
  if (audits.some(value => value !== ratingPopulation)) {
    throw new PublicQueryUnavailable('rated grouped current rating slots are incomplete');
  }
  const matches = new Map<string, {
    matchUnit: string; work: string; mainVersion: string; contribution: string;
    revision: string; selection: string; language: string; reason: string; score: number;
    rating: GroupedRating }>();
  for (const row of rows.filter(item => item.unit)) {
    const count = integer(row.ratingCount), sum = integer(row.ratingSum);
    const targetPopulation = integer(row.ratingTargetPopulation);
    const score = Number(row.score?.value);
    if (!row.unit || !row.work || !row.main || !row.contribution || !row.bodyRevision
      || !row.selection || !row.language || !row.reason || !Number.isFinite(score)
      || count === null || count < 1 || sum === null || sum < count || sum > 10 * count
      || targetPopulation === null || targetPopulation < count
      || targetPopulation > ratingPopulation
      || !['realm-adoption', 'main-fallback'].includes(row.reason.value)) {
      throw new PublicQueryUnavailable('rated grouped text or rating binding is incomplete');
    }
    const match = { matchUnit: row.unit.value, work: row.work.value,
      mainVersion: row.main.value, contribution: row.contribution.value,
      revision: row.bodyRevision.value, selection: row.selection.value,
      language: row.language.value, reason: row.reason.value, score,
      rating: { context: input.rating.context, count, sum, mean: sum / count,
        precision: { kind: 'exact-rational' as const, numerator: sum, denominator: count } } };
    const prior = matches.get(match.matchUnit);
    if (prior && JSON.stringify(prior) !== JSON.stringify(match)) {
      throw new PublicQueryUnavailable('rated grouped MatchUnit has conflicting rating paths');
    }
    matches.set(match.matchUnit, match);
  }
  if (new Set([...matches.values()].map(match => match.mainVersion)).size !== matches.size) {
    throw new PublicQueryUnavailable('rated grouped Main Version is ambiguous');
  }
  const ordered = [...matches.values()].sort((a, b) => b.score - a.score
    || a.mainVersion.localeCompare(b.mainVersion) || a.matchUnit.localeCompare(b.matchUnit));
  return { phrase: { contractVersion: '1', resultGrain: 'mainVersion',
    context: { kind: 'realm-local', id: input.realm }, complete: true,
    population: index.population, total: ordered.length, results: ordered,
    indexGeneration: index.generation,
    sourcePosition: { datasetId: 'product', dataEpoch: first.epoch.value,
      sequence: first.sequence.value } }, bindings: rows, ratingPopulation };
}
