import { readComponentState } from '../work/history.ts';
import { DATASET, GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { RatingAggregateBudgetExceeded, RatingAggregateUnavailable } from './aggregate.ts';
import { sameRatingInstant } from './observation.ts';
import { TARGET_OBSERVATION_PROFILE, LANGUAGE_OBSERVATION_PROFILE, readTargetRatingContext, targetRatingDigest } from './target.ts';
import type { TargetRatingInventoryStore } from './target-inventory.ts';

export const TARGET_AGGREGATE_PROFILE = 'realm-target-latest-mean-v1';
/** One indexed k+1 inventory, one exact Context, one bounded graph snapshot,
 * at most k immutable manifests, and one recovery fence. No cross-grain rollup. */
export const TARGET_AGGREGATE_COST = { slots: 100, graphCalls: 3, graphBytes: 524_288,
  manifestBytes: 524_288, deadlineMs: 10_000 } as const;

export async function queryTargetRatingAggregate(env: WorkActivationEnvironment, access: TargetRatingInventoryStore,
  input: { context: string; target: string }) {
  const signal = AbortSignal.timeout(TARGET_AGGREGATE_COST.deadlineMs);
  const inventory = await access.read(input.context, input.target, signal);
  if (inventory.heads.length > TARGET_AGGREGATE_COST.slots) throw new RatingAggregateBudgetExceeded('Target population exceeds budget');
  const context = await readTargetRatingContext(env, input.context);
  if (!context || context.contextRevision !== inventory.contextRevision || context.realm !== inventory.realm) {
    throw new RatingAggregateUnavailable('Target Context seal differs');
  }
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?population
    ?contextReceipt ?contextEpoch ?contextSequence ?receipt ?digest ?revisionEpoch ?revisionSequence
    ?observation ?slot ?head ?availability ?value ?manifest ?predecessor ?evaluatedAt ?submittedAt ?profile WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(inventory.contextRevision)} rv:component ${iri(input.context)} ;
      rv:dataEpoch ?contextEpoch ; rv:sequence ?contextSequence }
    GRAPH ${iri(GRAPHS.receipts)} { ?contextReceipt rv:ratingContext ${iri(input.context)} ;
      rv:ratingContextRevision ${iri(inventory.contextRevision)} ; rv:outcome rv:Succeeded }
    { SELECT (COUNT(DISTINCT ?candidate) AS ?population) WHERE { { SELECT ?candidate WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?candidate rv:ratingContext ${iri(input.context)} ; rv:target ${iri(input.target)} }
    } LIMIT 101 } } }
    OPTIONAL { { SELECT ?observation WHERE { GRAPH ${iri(GRAPHS.current)} {
      ?observation rv:ratingContext ${iri(input.context)} ; rv:target ${iri(input.target)} } } LIMIT 101 }
      GRAPH ${iri(GRAPHS.current)} { ?observation a rv:TargetRatingObservation ;
      rv:ratingContext ${iri(input.context)} ; rv:target ${iri(input.target)} ; rv:ratingSlot ?slot ; rv:observationHead ?head . }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:TargetRatingObservationRevision, rv:RevisionAnchor ;
        rv:component ?observation ; rv:observation ?observation ; rv:modelRevision ?profile ;
        rv:ratingAvailability ?availability ; rv:manifest ?manifest ; rv:evaluatedAt ?evaluatedAt ; rv:submittedAt ?submittedAt ;
        rv:dataEpoch ?revisionEpoch ; rv:sequence ?revisionSequence .
        VALUES ?profile { ${iri(TARGET_OBSERVATION_PROFILE)} ${iri(LANGUAGE_OBSERVATION_PROFILE)} }
        FILTER NOT EXISTS { ?head a rv:ErasedRevision }
        OPTIONAL { ?head rv:ratingValue ?value } OPTIONAL { ?head rv:predecessor ?predecessor } }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:ratingObservation ?observation ; rv:observationRevision ?head ;
        rv:requestDigest ?digest ; rv:outcome rv:Succeeded }
    } } LIMIT 101`, TARGET_AGGREGATE_COST.graphBytes)).results?.bindings ?? [];
  const first = rows[0];
  const population = Number(first?.population?.value);
  if (!first?.epoch || !first.sequence || first.epoch.value !== env.lineage.dataEpoch
    || first.contextReceipt?.value !== inventory.contextReceipt || first.contextEpoch?.value !== inventory.contextDataEpoch
    || first.contextSequence?.value !== inventory.contextSequence
    || !Number.isSafeInteger(population) || population < 0) throw new RatingAggregateUnavailable('Target snapshot unavailable');
  if (population > TARGET_AGGREGATE_COST.slots) throw new RatingAggregateBudgetExceeded('Target population exceeds budget');
  const observations = rows.filter(row => row.observation);
  if (observations.length !== population || population !== inventory.heads.length
    || population === 0 && rows.length !== 1) throw new RatingAggregateUnavailable('Target population incomplete');
  const heads = new Map(inventory.heads.map(head => [head.observation, head]));
  const seen = new Set<string>(), histogram = Array.from({ length: 10 }, () => 0);
  const budget = { bytesLeft: TARGET_AGGREGATE_COST.manifestBytes as number, signal };
  let withdrawnCount = 0, sum = 0;
  for (const row of observations) {
    signal.throwIfAborted();
    const sealed = heads.get(row.observation!.value);
    if (!sealed || !row.slot || !row.head || !row.manifest || !row.profile || seen.has(row.slot.value)
      || sealed.slot !== row.slot.value || sealed.revision !== row.head.value
      || sealed.receipt !== row.receipt?.value || sealed.requestDigest !== row.digest?.value
      || sealed.dataEpoch !== row.revisionEpoch?.value || sealed.sequence !== row.revisionSequence?.value
      || !sameRatingInstant(sealed.evaluatedAt, row.evaluatedAt?.value)
      || !sameRatingInstant(sealed.submittedAt, row.submittedAt?.value)
      || row.epoch?.value !== first.epoch.value || row.sequence?.value !== first.sequence.value) {
      throw new RatingAggregateUnavailable('Target head differs from seal');
    }
    seen.add(row.slot.value);
    const state = readComponentState(env.objectDirectory, row.manifest.value, row.observation!.value, row.profile!.value, budget);
    const available = row.availability?.value === `${RV}Available`, withdrawn = row.availability?.value === `${RV}Withdrawn`;
    const value = row.value ? Number(row.value.value) : null;
    if ((!available && !withdrawn) || available && (!Number.isInteger(value) || value! < 1 || value! > 10)
      || withdrawn && value !== null || state.observation !== sealed.observation || state.revision !== sealed.revision
      || state.context !== input.context || state.target !== input.target || state.slot !== sealed.slot
      || state.realm !== context.realm || state.contextRevision !== context.contextRevision || state.targetGrain !== context.targetGrain
      || state.availability !== (available ? 'available' : 'withdrawn') || state.value !== value
      || state.predecessor !== (row.predecessor?.value ?? null)
      || !sameRatingInstant(state.evaluatedAt, sealed.evaluatedAt) || !sameRatingInstant(state.originalSubmissionAt, sealed.evaluatedAt)
      || !sameRatingInstant(state.submittedAt, sealed.submittedAt) || !sameRatingInstant(state.revisedAt, sealed.submittedAt)
      || targetRatingDigest({ context: input.context, target: input.target, value,
        expectedRevisionHead: state.predecessor as string | null, actingSubject: sealed.actingSubject }) !== sealed.requestDigest) {
      throw new RatingAggregateUnavailable('Target revision bytes differ');
    }
    if (withdrawn) withdrawnCount++;
    else { histogram[value! - 1] = histogram[value! - 1]! + 1; sum += value!; }
  }
  if (!await access.checkFence(inventory.recoveryGeneration, signal)) throw new RatingAggregateUnavailable('Recovery fence changed');
  const count = population - withdrawnCount;
  return { profile: TARGET_AGGREGATE_PROFILE, complete: true as const, context: input.context, realm: context.realm,
    target: input.target, targetGrain: context.targetGrain,
    scope: { question: context.question, language: context.language, grain: context.targetGrain, population: 'account-principal' as const,
      countedTarget: input.target }, scale: context.scale, cadence: context.cadence,
    populationPolicy: 'account-principal' as const, aggregationPolicy: 'latest-per-rater-mean' as const,
    population, count, withdrawnCount, histogram, sum, mean: count ? sum / count : null,
    precision: count ? { kind: 'exact-rational' as const, numerator: sum, denominator: count }
      : { kind: 'no-data' as const },
    sourcePosition: { datasetId: 'product' as const, dataEpoch: first.epoch.value, sequence: first.sequence.value } };
}
