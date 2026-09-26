import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { InvalidRatingAggregateQuery, RatingAggregateBudgetExceeded,
  RatingAggregateUnavailable } from './aggregate.ts';
import { RELEASE_CONTEXT_PROFILE, RELEASE_OBSERVATION_PROFILE, releaseTargetPattern } from './release.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const RELEASE_AGGREGATE_PROFILE = 'realm-release-latest-mean-v1';
/** Same admitted bound as the standing MainVersion aggregate: k slots plus one sentinel. */
export const MAX_RELEASE_SLOTS = 100;
export const RELEASE_AGGREGATE_BUDGET = { graphCalls: 2, candidateRows: MAX_RELEASE_SLOTS + 1 } as const;

export interface ReleaseRatingAggregateInput {
  context: string;
  release: string;
}

/**
 * Exact bounded current-head reduction over one release population. Only
 * release-typed observations whose target is this exact release are counted;
 * the release's MainVersion population and sibling releases are never read.
 */
export async function queryReleaseRatingAggregate(env: WorkActivationEnvironment,
  input: ReleaseRatingAggregateInput) {
  if (![input.context, input.release].every(value => nativeId.test(value))) {
    throw new InvalidRatingAggregateQuery('invalid release rating aggregate target');
  }
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  // Leading exact keys (Context, release) bound the candidate scan to k+1 slots.
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?epoch ?sequence ?realm ?work ?main ?population ?observation ?slot ?head
      ?availability ?value ?manifest WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      ${releaseTargetPattern({ realm: '?realm', context: iri(input.context), work: '?work',
        main: '?main', release: iri(input.release), contextRevision: '?contextRevision' })}
      GRAPH ${iri(GRAPHS.revisions)} { ?contextRevision a rv:RevisionAnchor ;
        rv:component ${iri(input.context)} ; rv:modelRevision ${iri(RELEASE_CONTEXT_PROFILE)} . }
      { SELECT (COUNT(DISTINCT ?candidate) AS ?population) WHERE {
        { SELECT ?candidate WHERE { GRAPH ${iri(GRAPHS.current)} {
          ?candidate rv:ratingContext ${iri(input.context)} ; rv:targetRelease ${iri(input.release)} .
        } } LIMIT ${RELEASE_AGGREGATE_BUDGET.candidateRows} }
      } }
      OPTIONAL {
        { SELECT ?observation WHERE { GRAPH ${iri(GRAPHS.current)} {
          ?observation rv:ratingContext ${iri(input.context)} ; rv:targetRelease ${iri(input.release)} .
        } } LIMIT ${RELEASE_AGGREGATE_BUDGET.candidateRows} }
        GRAPH ${iri(GRAPHS.current)} {
          ?observation a rv:ReleaseRatingObservation ; rv:ratingSlot ?slot ; rv:observationHead ?head . }
        GRAPH ${iri(GRAPHS.revisions)} {
          ?head a rv:ReleaseRatingObservationRevision, rv:RevisionAnchor ;
            rv:component ?observation ; rv:observation ?observation ;
            rv:modelRevision ${iri(RELEASE_OBSERVATION_PROFILE)} ;
            rv:ratingAvailability ?availability ; rv:manifest ?manifest .
          OPTIONAL { ?head rv:ratingValue ?value }
        }
      }
    } LIMIT ${RELEASE_AGGREGATE_BUDGET.candidateRows + 1}`);
  const rows = result.results?.bindings ?? [];
  const first = rows[0];
  if (!first?.epoch || !first.sequence || !first.realm || !first.work || !first.main || !first.population
    || rows.some(row => row.epoch?.value !== first.epoch!.value
      || row.sequence?.value !== first.sequence!.value || row.realm?.value !== first.realm!.value
      || row.work?.value !== first.work!.value || row.main?.value !== first.main!.value
      || row.population?.value !== first.population!.value)) {
    throw new RatingAggregateUnavailable('release rating snapshot is unavailable');
  }
  const population = Number(first.population.value);
  if (!Number.isSafeInteger(population) || population < 0) {
    throw new RatingAggregateUnavailable('release rating population is invalid');
  }
  if (population > MAX_RELEASE_SLOTS) {
    throw new RatingAggregateBudgetExceeded('release rating population exceeds admitted bound');
  }
  const observations = rows.filter(row => row.observation);
  if (observations.length !== population || (population === 0 && rows.length !== 1)) {
    throw new RatingAggregateUnavailable('release rating population is incomplete');
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
      throw new RatingAggregateUnavailable('release rating slot is ambiguous');
    }
    seenSlots.add(row.slot.value);
    seenObservations.add(row.observation.value);
    const availability = row.availability.value === `${RV}Available` ? 'available'
      : row.availability.value === `${RV}Withdrawn` ? 'withdrawn' : null;
    const value = row.value ? Number(row.value.value) : null;
    if (!availability || (availability === 'available'
      && (!Number.isInteger(value) || value! < 1 || value! > 10))
      || (availability === 'withdrawn' && value !== null)) {
      throw new RatingAggregateUnavailable('release rating value is invalid');
    }
    const state = readComponentState(env.objectDirectory, row.manifest.value,
      row.observation.value, RELEASE_OBSERVATION_PROFILE);
    if (state.observation !== row.observation.value || state.slot !== row.slot.value
      || state.context !== input.context || state.realm !== first.realm.value
      || state.release !== input.release || state.work !== first.work.value
      || state.mainVersion !== first.main.value || state.revision !== row.head.value
      || state.availability !== availability || state.value !== value) {
      throw new RatingAggregateUnavailable('release rating revision bytes differ');
    }
    if (availability === 'withdrawn') withdrawnCount++;
    else { histogram[value! - 1] = histogram[value! - 1]! + 1; sum += value!; }
  }
  const count = population - withdrawnCount;
  return { profile: RELEASE_AGGREGATE_PROFILE, complete: true as const,
    context: input.context, realm: first.realm.value, work: first.work.value,
    mainVersion: first.main.value, release: input.release, targetGrain: 'fixedRelease' as const,
    scale: { min: 1 as const, max: 10 as const, step: 1 as const }, cadence: 'standing' as const,
    populationPolicy: 'account-principal' as const,
    aggregationPolicy: 'latest-per-rater-mean' as const,
    population, count, withdrawnCount, histogram, sum,
    mean: count === 0 ? null : sum / count,
    precision: count === 0 ? { kind: 'no-data' as const }
      : { kind: 'exact-rational' as const, numerator: sum, denominator: count },
    sourcePosition: { datasetId: 'product' as const,
      dataEpoch: first.epoch.value, sequence: first.sequence.value } };
}
