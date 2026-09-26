import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState, RevisionReadBudgetExceeded } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { ReleaseRatingInventoryStore } from '../access/rating-aggregate-inventory.ts';
import { InvalidRatingAggregateQuery, RatingAggregateBudgetExceeded,
  RatingAggregateUnavailable } from './aggregate.ts';
import { RELEASE_CONTEXT_PROFILE, RELEASE_OBSERVATION_PROFILE, releaseRatingDigest,
  releaseTargetPattern } from './release.ts';
import { sameRatingInstant } from './observation.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY,
  RATING_STANDING_CADENCE } from './context.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const RELEASE_AGGREGATE_PROFILE = 'realm-release-latest-mean-v1';
/** Same admitted bound as the standing MainVersion aggregate: k slots plus one sentinel. */
export const MAX_RELEASE_SLOTS = 100;
export const RELEASE_AGGREGATE_BUDGET = { deadlineMs: 10_000, graphCalls: 2,
  graphBytes: 1_048_576, manifestBytes: 1_048_576, candidateRows: MAX_RELEASE_SLOTS + 1 } as const;

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
  access: Pick<ReleaseRatingInventoryStore, 'read' | 'checkFence'>,
  input: ReleaseRatingAggregateInput) {
  if (![input.context, input.release].every(value => nativeId.test(value))) {
    throw new InvalidRatingAggregateQuery('invalid release rating aggregate target');
  }
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const signal = AbortSignal.timeout(RELEASE_AGGREGATE_BUDGET.deadlineMs);
  const inventory = await access.read(input.context, input.release, signal);
  if (inventory.heads.length > MAX_RELEASE_SLOTS) {
    throw new RatingAggregateBudgetExceeded('release rating population exceeds admitted bound');
  }
  // Leading exact keys (Context, release) bound the candidate scan to k+1 slots.
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?epoch ?sequence ?realm ?work ?main ?population ?contextRevision ?contextManifest
      ?contextReceipt ?contextEpoch ?contextSequence ?observation ?slot ?head
      ?availability ?value ?predecessor ?manifest ?receipt ?digest ?revisionEpoch ?revisionSequence
      ?evaluatedAt ?submittedAt ?originalSubmissionAt ?revisedAt WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      ${releaseTargetPattern({ realm: '?realm', context: iri(input.context), work: '?work',
        main: '?main', release: iri(input.release), contextRevision: '?contextRevision' })}
      GRAPH ${iri(GRAPHS.revisions)} { ?contextRevision a rv:RevisionAnchor ;
        rv:component ${iri(input.context)} ; rv:modelRevision ${iri(RELEASE_CONTEXT_PROFILE)} ;
        rv:manifest ?contextManifest ; rv:dataEpoch ?contextEpoch ; rv:sequence ?contextSequence . }
      GRAPH ${iri(GRAPHS.receipts)} { ?contextReceipt a rv:OperationReceipt ;
        rv:ratingContext ${iri(input.context)} ; rv:ratingContextRevision ?contextRevision ;
        rv:outcome rv:Succeeded . }
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
            rv:ratingAvailability ?availability ; rv:manifest ?manifest ;
            rv:evaluatedAt ?evaluatedAt ; rv:submittedAt ?submittedAt ;
            rv:originalSubmissionAt ?originalSubmissionAt ; rv:revisedAt ?revisedAt ;
            rv:dataEpoch ?revisionEpoch ; rv:sequence ?revisionSequence .
          OPTIONAL { ?head rv:ratingValue ?value }
          OPTIONAL { ?head rv:predecessor ?predecessor }
        }
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ;
          rv:ratingObservation ?observation ; rv:observationRevision ?head ;
          rv:requestDigest ?digest ; rv:outcome rv:Succeeded . }
      }
    } LIMIT ${RELEASE_AGGREGATE_BUDGET.candidateRows + 1}`,
  RELEASE_AGGREGATE_BUDGET.graphBytes);
  const rows = result.results?.bindings ?? [];
  const first = rows[0];
  if (!first?.epoch || !first.sequence || !first.realm || !first.work || !first.main || !first.population
    || !first.contextRevision || !first.contextManifest || !first.contextReceipt
    || !first.contextEpoch || !first.contextSequence
    || first.realm.value !== inventory.realm || first.contextRevision.value !== inventory.contextRevision
    || first.contextReceipt.value !== inventory.contextReceipt
    || first.contextEpoch.value !== inventory.contextDataEpoch
    || first.contextSequence.value !== inventory.contextSequence
    || rows.some(row => row.epoch?.value !== first.epoch!.value
      || row.sequence?.value !== first.sequence!.value || row.realm?.value !== first.realm!.value
      || row.work?.value !== first.work!.value || row.main?.value !== first.main!.value
      || row.population?.value !== first.population!.value
      || row.contextRevision?.value !== first.contextRevision!.value
      || row.contextManifest?.value !== first.contextManifest!.value
      || row.contextReceipt?.value !== first.contextReceipt!.value)) {
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
  if (observations.length !== population || observations.length !== inventory.heads.length
    || (population === 0 && rows.length !== 1)) {
    throw new RatingAggregateUnavailable('release rating population is incomplete');
  }
  const manifestBudget = { bytesLeft: RELEASE_AGGREGATE_BUDGET.manifestBytes as number, signal };
  const readState = (manifest: string, component: string, profile: string) => {
    try { return readComponentState(env.objectDirectory, manifest, component, profile, manifestBudget); }
    catch (error) {
      if (error instanceof RevisionReadBudgetExceeded) {
        throw new RatingAggregateBudgetExceeded('release rating manifest budget exceeded');
      }
      throw new RatingAggregateUnavailable('release rating revision bytes are unavailable');
    }
  };
  const contextState = readState(first.contextManifest.value, input.context, RELEASE_CONTEXT_PROFILE);
  if (contextState.context !== input.context || contextState.realm !== inventory.realm
    || contextState.targetGrain !== 'FixedRelease' || contextState.state !== 'active'
    || typeof contextState.question !== 'string' || contextState.scaleMin !== 1
    || contextState.scaleMax !== 10 || contextState.cadence !== RATING_STANDING_CADENCE
    || contextState.populationPolicy !== RATING_ACCOUNT_POPULATION
    || contextState.aggregationPolicy !== RATING_LATEST_MEAN_POLICY) {
    throw new RatingAggregateUnavailable('release rating Context bytes differ');
  }
  const byObservation = new Map(inventory.heads.map(head => [head.observation, head]));
  const seenSlots = new Set<string>();
  const seenObservations = new Set<string>();
  const histogram = Array.from({ length: 10 }, () => 0);
  let withdrawnCount = 0;
  let sum = 0;
  for (const row of observations) {
    if (!row.observation || !row.slot || !row.head || !row.availability || !row.manifest
      || !row.receipt || !row.digest || !row.revisionEpoch || !row.revisionSequence
      || !row.evaluatedAt || !row.submittedAt || !row.originalSubmissionAt || !row.revisedAt
      || !/^urn:rezics:rating-slot:[0-9a-f]{64}$/.test(row.slot.value)
      || seenSlots.has(row.slot.value) || seenObservations.has(row.observation.value)) {
      throw new RatingAggregateUnavailable('release rating slot is ambiguous');
    }
    seenSlots.add(row.slot.value);
    seenObservations.add(row.observation.value);
    const sealed = byObservation.get(row.observation.value);
    if (!sealed || sealed.slot !== row.slot.value || sealed.revision !== row.head.value
      || sealed.work !== first.work.value || sealed.mainVersion !== first.main.value
      || sealed.receipt !== row.receipt.value || sealed.requestDigest !== row.digest.value
      || sealed.dataEpoch !== row.revisionEpoch.value || sealed.sequence !== row.revisionSequence.value
      || !sameRatingInstant(sealed.evaluatedAt, row.evaluatedAt.value)
      || !sameRatingInstant(sealed.evaluatedAt, row.originalSubmissionAt.value)
      || !sameRatingInstant(sealed.submittedAt, row.submittedAt.value)
      || !sameRatingInstant(sealed.submittedAt, row.revisedAt.value)) {
      throw new RatingAggregateUnavailable('release rating Access head differs');
    }
    const availability = row.availability.value === `${RV}Available` ? 'available'
      : row.availability.value === `${RV}Withdrawn` ? 'withdrawn' : null;
    const value = row.value ? Number(row.value.value) : null;
    if (!availability || (availability === 'available'
      && (!Number.isInteger(value) || value! < 1 || value! > 10))
      || (availability === 'withdrawn' && value !== null)) {
      throw new RatingAggregateUnavailable('release rating value is invalid');
    }
    const state = readState(row.manifest.value, row.observation.value, RELEASE_OBSERVATION_PROFILE);
    if (state.observation !== row.observation.value || state.slot !== row.slot.value
      || state.context !== input.context || state.realm !== first.realm.value
      || state.release !== input.release || state.work !== first.work.value
      || state.mainVersion !== first.main.value || state.revision !== row.head.value
      || state.contextRevision !== inventory.contextRevision
      || state.predecessor !== (row.predecessor?.value ?? null)
      || state.availability !== availability || state.value !== value
      || !sameRatingInstant(state.evaluatedAt, sealed.evaluatedAt)
      || !sameRatingInstant(state.originalSubmissionAt, sealed.evaluatedAt)
      || !sameRatingInstant(state.submittedAt, sealed.submittedAt)
      || !sameRatingInstant(state.revisedAt, sealed.submittedAt)) {
      throw new RatingAggregateUnavailable('release rating revision bytes differ');
    }
    if (releaseRatingDigest({ context: input.context, work: first.work.value,
      mainVersion: first.main.value, release: input.release,
      expectedRevisionHead: state.predecessor as string | null, value,
      actingSubject: sealed.actingSubject }) !== sealed.requestDigest) {
      throw new RatingAggregateUnavailable('release rating intent differs');
    }
    if (availability === 'withdrawn') withdrawnCount++;
    else { histogram[value! - 1] = histogram[value! - 1]! + 1; sum += value!; }
  }
  const count = population - withdrawnCount;
  if (!await access.checkFence(inventory.recoveryGeneration, signal)) {
    throw new RatingAggregateUnavailable('release rating recovery fence changed');
  }
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
