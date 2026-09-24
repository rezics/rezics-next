import { DATASET, GRAPHS, RV, iri, lit,
  type WorkActivationEnvironment } from './activate.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { SELECTION_POLICY } from '../space/create.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { CLASSIFICATION_DIRECT_DECISION_PROFILE } from '../classification/decision.ts';
import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY,
  RATING_STANDING_CADENCE } from '../rating/context.ts';
import { STANDING_RATING_OBSERVATION_PROFILE } from '../rating/observation.ts';
import { InvalidPublicQuery, PublicQueryBudgetExceeded, PublicQueryUnavailable,
  PublicRealmUnavailable } from './search-public.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const MAX_UNITS = 100;
const MAX_SLOTS = 100;

export interface PublicRealmClassifiedRatedPhraseQuery {
  context: { kind: 'realm-local'; id: string };
  phrase: string;
  language: string | null;
  sense: string;
  ratingContext: string;
  minimumMeanTimes10: number;
}

/** One bounded graph/text/classification/current-standing-score ARQ relation. */
export async function queryPublicRealmClassifiedRatedPhrase(env: WorkActivationEnvironment,
  input: PublicRealmClassifiedRatedPhraseQuery) {
  const phrase = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (input.context?.kind !== 'realm-local' || !nativeId.test(input.context.id)
    || !nativeId.test(input.sense) || !nativeId.test(input.ratingContext)
    || phrase.length < 2 || phrase.length > 80 || /[\u0000-\u001f\u007f]/u.test(phrase)
    || (input.language !== null
      && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.language))
    || !Number.isInteger(input.minimumMeanTimes10)
    || input.minimumMeanTimes10 < 10 || input.minimumMeanTimes10 > 100) {
    throw new InvalidPublicQuery('invalid joined Realm query');
  }
  const realm = input.context.id;
  const lucene = `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?epoch ?sequence ?population ?ratingPopulation ?unit ?score ?work ?main
      ?contribution ?revision ?selection ?language ?reason ?decision ?application
      ?source ?sourceContext ?ratingCount ?ratingSum ?ratingTargetPopulation WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
        ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} ;
          rv:classificationContext ?classificationContext ;
          rv:ratingContext ${iri(input.ratingContext)} .
        ?classificationContext a rv:ClassificationContext ;
          rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ;
          rv:realm ${iri(realm)} ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
          rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:head ?classificationContextRevision .
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
          rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
        ${iri(input.sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
          rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:head ?senseRevision .
        ${iri(input.ratingContext)} a rv:RatingContext ; rv:contextState rv:Active ;
          rv:realm ${iri(realm)} ; rv:targetGrain rv:MainVersion ;
          rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
          rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
          rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
          rv:head ?ratingContextRevision .
        FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?globalRealm }
        FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?globalFallback }
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?classificationContextRevision a rv:RevisionAnchor ;
          rv:component ?classificationContext .
        ?senseRevision a rv:RevisionAnchor ; rv:component ${iri(input.sense)} ;
          rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} .
        ?ratingContextRevision a rv:RevisionAnchor ;
          rv:component ${iri(input.ratingContext)} .
      }
      { SELECT (COUNT(DISTINCT ?candidate) AS ?population) WHERE {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?candidate a rv:MatchUnit }
      } }
      { SELECT (COUNT(DISTINCT ?ratingCandidate) AS ?ratingPopulation) WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?ratingCandidate a rv:RatingObservation ;
          rv:ratingContext ${iri(input.ratingContext)} . }
      } }
      OPTIONAL {
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${MAX_UNITS + 1}) .
          ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
            rv:work ?work ; rv:mainVersion ?main ; rv:context ?unitContext ;
            rv:contribution ?contribution ; rv:revision ?revision ;
            rv:selection ?selection ; rv:language ?language .
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?work a schema:CreativeWork ; rv:mainVersion ?main .
          ?main a rv:MainVersion ; rv:work ?work .
          OPTIONAL { ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
            rv:mainVersion ?main ; rv:selectionHead ?localSelection }
          OPTIONAL { ?main rv:selectionHead ?fallbackSelection }
        }
        BIND(COALESCE(?localSelection, ?fallbackSelection) AS ?effectiveSelection)
        BIND(IF(BOUND(?localSelection), ${iri(realm)}, ?main) AS ?effectiveContext)
        BIND(IF(BOUND(?localSelection), "realm-adoption", "main-fallback") AS ?reason)
        FILTER(?selection = ?effectiveSelection && ?unitContext = ?effectiveContext)
        ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
        OPTIONAL {
          GRAPH ${iri(GRAPHS.current)} {
            ?globalApplication a rv:ClassificationApplication ;
              rv:targetMainVersion ?main ; rv:sense ${iri(input.sense)} ;
              rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
              rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ;
              rv:decisionHead ?globalDecision .
          }
          GRAPH ${iri(GRAPHS.revisions)} {
            ?globalDecision a rv:ClassificationDecision, rv:RevisionAnchor ;
              rv:component ?globalApplication ; rv:application ?globalApplication ;
              rv:outcome ?globalOutcome ;
              rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} .
          }
        }
        OPTIONAL {
          GRAPH ${iri(GRAPHS.current)} {
            ?localApplication a rv:ClassificationApplication ;
              rv:targetMainVersion ?main ; rv:sense ${iri(input.sense)} ;
              rv:classificationContext ?classificationContext ;
              rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ;
              rv:decisionHead ?localDecision .
          }
          GRAPH ${iri(GRAPHS.revisions)} {
            ?localDecision a rv:ClassificationDecision, rv:RevisionAnchor ;
              rv:component ?localApplication ; rv:application ?localApplication ;
              rv:outcome ?localOutcome ;
              rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} .
          }
        }
        BIND(COALESCE(?localDecision, ?globalDecision) AS ?decision)
        BIND(COALESCE(?localApplication, ?globalApplication) AS ?application)
        BIND(COALESCE(?localOutcome, ?globalOutcome) AS ?outcome)
        BIND(IF(BOUND(?localDecision), "local", "inherited-global") AS ?source)
        BIND(IF(BOUND(?localDecision), ?classificationContext,
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)}) AS ?sourceContext)
        FILTER(?outcome = rv:Accepted)
        { SELECT ?main (COUNT(?observation) AS ?ratingTargetPopulation)
            (SUM(IF(?availability = rv:Available, 1, 0)) AS ?ratingCount)
            (SUM(IF(?availability = rv:Available, ?value, 0)) AS ?ratingSum)
          WHERE {
            GRAPH ${iri(GRAPHS.current)} {
              ?observation a rv:RatingObservation ;
                rv:ratingContext ${iri(input.ratingContext)} ;
                rv:targetMainVersion ?main ; rv:observationHead ?head .
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
          ${input.minimumMeanTimes10} * ?ratingCount)
      }
    }`);
  const rows = result.results?.bindings ?? [];
  const first = rows[0];
  if (!first) throw new PublicRealmUnavailable('Realm or joined query scope is unavailable');
  if (!first.population || !first.ratingPopulation || !first.epoch || !first.sequence
    || rows.some(row => row.epoch?.value !== first.epoch!.value
      || row.sequence?.value !== first.sequence!.value
      || row.population?.value !== first.population!.value
      || row.ratingPopulation?.value !== first.ratingPopulation!.value)) {
    throw new PublicQueryUnavailable('joined public query snapshot is unavailable');
  }
  const population = Number(first.population.value);
  const ratingPopulation = Number(first.ratingPopulation.value);
  if (![population, ratingPopulation].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new PublicQueryUnavailable('joined public query population is invalid');
  }
  if (population > MAX_UNITS || ratingPopulation > MAX_SLOTS) {
    throw new PublicQueryBudgetExceeded('joined public query population exceeds admitted bound');
  }
  const matches = rows.filter(row => row.unit).map(row => {
    if (!row.unit || !row.score || !row.work || !row.main || !row.contribution
      || !row.revision || !row.selection || !row.language || !row.reason
      || !row.decision || !row.application || !row.source || !row.sourceContext
      || !row.ratingCount || !row.ratingSum || !row.ratingTargetPopulation) {
      throw new PublicQueryUnavailable('joined public query result is incomplete');
    }
    const score = Number(row.score.value);
    const count = Number(row.ratingCount.value);
    const sum = Number(row.ratingSum.value);
    const targetPopulation = Number(row.ratingTargetPopulation.value);
    if (!Number.isFinite(score) || !Number.isSafeInteger(count) || count < 1
      || !Number.isSafeInteger(sum) || sum < count || sum > count * 10
      || !Number.isSafeInteger(targetPopulation) || targetPopulation < count
      || targetPopulation > ratingPopulation
      || !['realm-adoption', 'main-fallback'].includes(row.reason.value)
      || !['local', 'inherited-global'].includes(row.source.value)) {
      throw new PublicQueryUnavailable('joined public query result is invalid');
    }
    return { matchUnit: row.unit.value, work: row.work.value,
      mainVersion: row.main.value, contribution: row.contribution.value,
      revision: row.revision.value, selection: row.selection.value,
      language: row.language.value, reason: row.reason.value, score,
      classification: { sense: input.sense, decision: row.decision.value,
        application: row.application.value, source: row.source.value,
        sourceContext: row.sourceContext.value },
      rating: { context: input.ratingContext, count, sum, mean: sum / count,
        precision: { kind: 'exact-rational' as const, numerator: sum, denominator: count } } };
  });
  if (new Set(matches.map(match => match.matchUnit)).size !== matches.length
    || (matches.length === 0 && rows.length !== 1)) {
    throw new PublicQueryUnavailable('joined public query has ambiguous results');
  }
  matches.sort((left, right) => right.score - left.score
    || left.mainVersion.localeCompare(right.mainVersion));
  return { profile: 'public-realm-classified-rated-phrase-v1' as const,
    contractVersion: '1', resultGrain: 'mainVersion' as const,
    context: input.context, classificationSense: input.sense,
    ratingCriterion: { context: input.ratingContext,
      minimumMeanTimes10: input.minimumMeanTimes10, policy: 'latest-per-rater-mean' as const },
    complete: true, population, ratingPopulation,
    total: matches.length, results: matches,
    sourcePosition: { datasetId: 'product' as const,
      dataEpoch: first.epoch.value, sequence: first.sequence.value } };
}
