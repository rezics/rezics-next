import { DATASET, GRAPHS, RV, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY,
  RATING_STANDING_CADENCE } from './context.ts';
import { STANDING_RATING_OBSERVATION_PROFILE } from './observation.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const MAX_STANDING_SLOTS = 100;

export class InvalidRatingAggregateQuery extends Error {}
export class RatingAggregateUnavailable extends Error {}
export class RatingAggregateBudgetExceeded extends Error {}

export interface StandingRatingAggregateInput {
  context: string;
  work: string;
  mainVersion: string;
}

/** Exact bounded current-head reduction: a withdrawal removes only its own slot. */
export async function queryStandingRatingAggregate(env: WorkActivationEnvironment,
  input: StandingRatingAggregateInput) {
  if (![input.context, input.work, input.mainVersion].every(value => nativeId.test(value))) {
    throw new InvalidRatingAggregateQuery('invalid standing rating aggregate target');
  }
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    SELECT ?epoch ?sequence ?realm ?population ?observation ?slot ?head
      ?availability ?value ?manifest WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
        ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:ratingContext ${iri(input.context)} .
        ${iri(input.context)} a rv:RatingContext ; rv:contextState rv:Active ;
          rv:realm ?realm ; rv:targetGrain rv:MainVersion ;
          rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
          rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
          rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
          rv:head ?contextRevision .
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?contextRevision a rv:RevisionAnchor ;
        rv:component ${iri(input.context)} . }
      { SELECT (COUNT(DISTINCT ?candidate) AS ?population) WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?candidate a rv:RatingObservation ;
          rv:ratingContext ${iri(input.context)} ;
          rv:targetMainVersion ${iri(input.mainVersion)} . }
      } }
      OPTIONAL {
        GRAPH ${iri(GRAPHS.current)} {
          ?observation a rv:RatingObservation ; rv:ratingContext ${iri(input.context)} ;
            rv:targetMainVersion ${iri(input.mainVersion)} ;
            rv:ratingSlot ?slot ; rv:observationHead ?head . }
        GRAPH ${iri(GRAPHS.revisions)} {
          ?head a rv:RatingObservationRevision, rv:RevisionAnchor ;
            rv:component ?observation ; rv:observation ?observation ;
            rv:modelRevision ${iri(STANDING_RATING_OBSERVATION_PROFILE)} ;
            rv:ratingAvailability ?availability ; rv:manifest ?manifest .
          OPTIONAL { ?head rv:ratingValue ?value }
        }
      }
    }`);
  const rows = result.results?.bindings ?? [];
  const first = rows[0];
  if (!first?.epoch || !first.sequence || !first.realm || !first.population
    || rows.some(row => row.epoch?.value !== first.epoch!.value
      || row.sequence?.value !== first.sequence!.value
      || row.realm?.value !== first.realm!.value
      || row.population?.value !== first.population!.value)) {
    throw new RatingAggregateUnavailable('standing rating snapshot is unavailable');
  }
  const population = Number(first.population.value);
  if (!Number.isSafeInteger(population) || population < 0) {
    throw new RatingAggregateUnavailable('standing rating population is invalid');
  }
  if (population > MAX_STANDING_SLOTS) {
    throw new RatingAggregateBudgetExceeded('standing rating population exceeds admitted bound');
  }
  const observations = rows.filter(row => row.observation);
  if (observations.length !== population || (population === 0 && rows.length !== 1)) {
    throw new RatingAggregateUnavailable('standing rating population is incomplete');
  }
  const seenSlots = new Set<string>();
  const seenObservations = new Set<string>();
  const histogram = Array.from({ length: 10 }, () => 0);
  let withdrawnCount = 0;
  let sum = 0;
  for (const row of observations) {
    if (!row.observation || !row.slot || !row.head || !row.availability || !row.manifest
      || !/^urn:rezics:rating-slot:[0-9a-f]{64}$/.test(row.slot.value)
      || seenSlots.has(row.slot.value) || seenObservations.has(row.observation.value)) {
      throw new RatingAggregateUnavailable('standing rating slot is ambiguous');
    }
    seenSlots.add(row.slot.value);
    seenObservations.add(row.observation.value);
    const availability = row.availability.value === `${RV}Available` ? 'available'
      : row.availability.value === `${RV}Withdrawn` ? 'withdrawn' : null;
    const value = row.value ? Number(row.value.value) : null;
    if (!availability || (availability === 'available'
      && (!Number.isInteger(value) || value! < 1 || value! > 10))
      || (availability === 'withdrawn' && value !== null)) {
      throw new RatingAggregateUnavailable('standing rating value is invalid');
    }
    const state = readComponentState(env.objectDirectory, row.manifest.value,
      row.observation.value, STANDING_RATING_OBSERVATION_PROFILE);
    if (state.observation !== row.observation.value || state.slot !== row.slot.value
      || state.context !== input.context || state.realm !== first.realm.value
      || state.work !== input.work || state.mainVersion !== input.mainVersion
      || state.revision !== row.head.value || state.availability !== availability
      || state.value !== value) {
      throw new RatingAggregateUnavailable('standing rating revision bytes differ');
    }
    if (availability === 'withdrawn') withdrawnCount++;
    else { histogram[value! - 1] = histogram[value! - 1]! + 1; sum += value!; }
  }
  const count = population - withdrawnCount;
  return { profile: 'realm-standing-latest-mean-v1' as const, complete: true,
    context: input.context, realm: first.realm.value, work: input.work,
    mainVersion: input.mainVersion, targetGrain: 'mainVersion' as const,
    scale: { min: 1, max: 10, step: 1 }, cadence: 'standing' as const,
    populationPolicy: 'account-principal' as const,
    aggregationPolicy: 'latest-per-rater-mean' as const,
    population, count, withdrawnCount, histogram, sum,
    mean: count === 0 ? null : sum / count,
    precision: count === 0 ? { kind: 'no-data' as const }
      : { kind: 'exact-rational' as const, numerator: sum, denominator: count },
    sourcePosition: { datasetId: 'product' as const,
      dataEpoch: first.epoch.value, sequence: first.sequence.value } };
}
