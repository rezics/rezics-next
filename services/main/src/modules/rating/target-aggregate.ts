import { readComponentState, type RevisionReadBudget } from '../work/history.ts';
import { DATASET, GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { MAX_RATING_AGGREGATE_SLOTS, type RatingAggregateInventory, type RatingInventoryHead, type TargetRatingComponents,
  type TargetRatingSnapshot } from '../access/rating-aggregate-inventory.ts';
import { RatingAggregateUnavailable } from './aggregate.ts';
import { componentsAgree, meanDisclosure, type MeanDisplay, type RatingComponents } from './components.ts';
import { sameRatingInstant } from './observation.ts';
import { TARGET_OBSERVATION_PROFILES, readTargetRatingContext, targetRatingDigest } from './target.ts';
import type { TargetRatingInventoryStore } from './target-inventory.ts';

export const TARGET_AGGREGATE_PROFILE = 'realm-target-latest-mean-v1';
/** Read from the sealed additive components, whatever the population: one Access
 * snapshot (Context seal, the target's row, recovery fence), one bounded graph
 * snapshot that finds the last sealed write live, and one fence recheck.
 * A target of at most `verifiedHeads` raters is also checked head by head against
 * its immutable manifests, and the components must equal that recomputation. */
export const TARGET_AGGREGATE_COST = { verifiedHeads: MAX_RATING_AGGREGATE_SLOTS, graphCalls: 3,
  graphBytes: 524_288, manifestBytes: 524_288, deadlineMs: 10_000 } as const;

/** One head's verified standing value, in the shape Access records it. */
interface VerifiedHead { slot: string; revision: string; value: number | null }

export async function queryTargetRatingAggregate(env: WorkActivationEnvironment, access: TargetRatingInventoryStore,
  input: { context: string; target: string }) {
  const signal = AbortSignal.timeout(TARGET_AGGREGATE_COST.deadlineMs);
  const manifestBudget = { bytesLeft: TARGET_AGGREGATE_COST.manifestBytes as number, signal };
  const snapshot = await access.read(input.context, input.target, signal);
  const context = await readTargetRatingContext(env, input.context, manifestBudget);
  if (!context || context.contextRevision !== snapshot.contextRevision || context.realm !== snapshot.realm) {
    throw new RatingAggregateUnavailable('Target Context seal differs');
  }
  const components = snapshot.members.get(input.target) ?? null;
  // Heads exist only for a target of at most `verifiedHeads` raters; the check
  // below recomputes its figures, so unrecorded values need no reconstruction.
  if (components && components.unvalued > 0 && snapshot.heads === null)
    throw new RatingAggregateUnavailable('Target components need reconstruction');
  const verified = snapshot.heads !== null
    ? await verifyTargetRatingHeads(env, snapshot, snapshot.heads, components, input, context, signal, false, manifestBudget) : null;
  let figures: RatingComponents & { slots: number };
  if (verified) {
    ({ figures } = verified);
  } else {
    if (!components) throw new RatingAggregateUnavailable('Target components need reconstruction');
    await witnessLastWrite(env, snapshot, components, input);
    figures = { slots: components.slots, count: components.count, sum: components.sum, histogram: components.histogram };
  }
  if (!componentsAgree(figures)) throw new RatingAggregateUnavailable('Target components are inconsistent');
  if (!await access.checkFence(snapshot.recoveryGeneration, signal)) throw new RatingAggregateUnavailable('Recovery fence changed');
  const { mean, display } = meanDisclosure(figures, context.displayThreshold);
  const position = components?.last ?? {
    dataEpoch: snapshot.contextDataEpoch,
    sequence: snapshot.contextSequence,
  };
  return { profile: TARGET_AGGREGATE_PROFILE, complete: true as const, context: input.context, realm: context.realm,
    contextRevision: snapshot.contextRevision,
    lastAdmissionId: components?.last.admissionId ?? null,
    target: input.target, targetGrain: context.targetGrain,
    scope: { question: context.question, language: context.language, grain: context.targetGrain, population: 'account-principal' as const,
      countedTarget: input.target }, scale: context.scale, cadence: context.cadence,
    populationPolicy: 'account-principal' as const, aggregationPolicy: 'latest-per-rater-mean' as const,
    population: figures.slots, count: figures.count, withdrawnCount: figures.slots - figures.count,
    histogram: [...figures.histogram], sum: figures.sum, displayThreshold: context.displayThreshold, mean,
    meanDisplay: display, precision: precision(figures, display),
    sourcePosition: { datasetId: 'product' as const, dataEpoch: position.dataEpoch, sequence: position.sequence } };
}

export function precision(figures: RatingComponents, display: MeanDisplay) {
  return display === 'shown' ? { kind: 'exact-rational' as const, numerator: figures.sum, denominator: figures.count }
    : display === 'no-data' ? { kind: 'no-data' as const } : { kind: 'withheld-below-threshold' as const };
}

/** O(1) in the population: control position, the Context seal, and the last
 * sealed write, which must still be its observation's live head. A graph that
 * lost it, or that was rolled back past it, cannot match the sealed receipt. */
async function witnessLastWrite(env: WorkActivationEnvironment, snapshot: TargetRatingSnapshot,
  components: TargetRatingComponents, input: { context: string; target: string }) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?contextReceipt ?contextEpoch
    ?contextSequence ?digest ?lastEpoch ?lastSequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(snapshot.contextRevision)} rv:component ${iri(input.context)} ;
      rv:dataEpoch ?contextEpoch ; rv:sequence ?contextSequence }
    GRAPH ${iri(GRAPHS.receipts)} { ?contextReceipt rv:ratingContext ${iri(input.context)} ;
      rv:ratingContextRevision ${iri(snapshot.contextRevision)} ; rv:outcome rv:Succeeded .
      ${iri(components.last.receipt)} a rv:OperationReceipt ; rv:ratingContext ${iri(input.context)} ;
        rv:target ${iri(input.target)} ; rv:ratingObservation ?observation ; rv:observationRevision ?lastRevision ;
        rv:requestDigest ?digest ; rv:outcome rv:Succeeded ; rv:dataEpoch ?lastEpoch ; rv:sequence ?lastSequence }
    GRAPH ${iri(GRAPHS.current)} { ?observation a rv:TargetRatingObservation ; rv:ratingContext ${iri(input.context)} ;
      rv:target ${iri(input.target)} ; rv:observationHead ?lastRevision }
  } LIMIT 2`, TARGET_AGGREGATE_COST.graphBytes)).results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row || row.epoch?.value !== env.lineage.dataEpoch || !row.sequence
    || row.contextReceipt?.value !== snapshot.contextReceipt || row.contextEpoch?.value !== snapshot.contextDataEpoch
    || row.contextSequence?.value !== snapshot.contextSequence
    || row.digest?.value !== components.last.requestDigest || row.lastEpoch?.value !== components.last.dataEpoch
    || row.lastSequence?.value !== components.last.sequence) {
    throw new RatingAggregateUnavailable('Target snapshot unavailable');
  }
  return { dataEpoch: row.epoch.value, sequence: row.sequence!.value };
}

/** The exhaustive check for a target small enough to verify: every sealed head
 * against its graph row, receipt and immutable manifest. */
export async function verifyTargetRatingHeads(env: WorkActivationEnvironment, snapshot: Omit<RatingAggregateInventory, 'heads'>,
  inventory: readonly RatingInventoryHead[], components: TargetRatingComponents | null,
  input: { context: string; target: string }, context: NonNullable<Awaited<ReturnType<typeof readTargetRatingContext>>>,
  signal: AbortSignal,
  partial = false,
  budget: RevisionReadBudget = { bytesLeft: TARGET_AGGREGATE_COST.manifestBytes, signal },
) {
  if (inventory.length > TARGET_AGGREGATE_COST.verifiedHeads) throw new RatingAggregateUnavailable('Target population exceeds verification');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?population
    ?contextReceipt ?contextEpoch ?contextSequence ?receipt ?digest ?revisionEpoch ?revisionSequence
    ?observation ?slot ?head ?availability ?value ?manifest ?predecessor ?evaluatedAt ?submittedAt ?profile WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(snapshot.contextRevision)} rv:component ${iri(input.context)} ;
      rv:dataEpoch ?contextEpoch ; rv:sequence ?contextSequence }
    GRAPH ${iri(GRAPHS.receipts)} { ?contextReceipt rv:ratingContext ${iri(input.context)} ;
      rv:ratingContextRevision ${iri(snapshot.contextRevision)} ; rv:outcome rv:Succeeded }
    ${
      partial
        ? `BIND(${inventory.length} AS ?population)`
        : `{ SELECT (COUNT(DISTINCT ?candidate) AS ?population) WHERE { { SELECT ?candidate WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?candidate rv:ratingContext ${iri(input.context)} ; rv:target ${iri(input.target)} }
    } LIMIT 101 } } }`
    }
    OPTIONAL { ${
      partial
        ? `VALUES ?observation { ${inventory.map((head) => iri(head.observation)).join(' ')} }`
        : `{ SELECT ?observation WHERE { GRAPH ${iri(GRAPHS.current)} {
      ?observation rv:ratingContext ${iri(input.context)} ; rv:target ${iri(input.target)} } } LIMIT 101 }`
    }
      GRAPH ${iri(GRAPHS.current)} { ?observation a rv:TargetRatingObservation ;
      rv:ratingContext ${iri(input.context)} ; rv:target ${iri(input.target)} ; rv:ratingSlot ?slot ; rv:observationHead ?head . }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:TargetRatingObservationRevision, rv:RevisionAnchor ;
        rv:component ?observation ; rv:observation ?observation ; rv:modelRevision ?profile ;
        rv:ratingAvailability ?availability ; rv:manifest ?manifest ; rv:evaluatedAt ?evaluatedAt ; rv:submittedAt ?submittedAt ;
        rv:dataEpoch ?revisionEpoch ; rv:sequence ?revisionSequence .
        VALUES ?profile { ${TARGET_OBSERVATION_PROFILES.map(iri).join(' ')} }
        FILTER NOT EXISTS { ?head a rv:ErasedRevision }
        OPTIONAL { ?head rv:ratingValue ?value } OPTIONAL { ?head rv:predecessor ?predecessor } }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:ratingObservation ?observation ; rv:observationRevision ?head ;
        rv:requestDigest ?digest ; rv:outcome rv:Succeeded }
    } } LIMIT 101`, TARGET_AGGREGATE_COST.graphBytes)).results?.bindings ?? [];
  const first = rows[0];
  const population = Number(first?.population?.value);
  if (!first?.epoch || !first.sequence || first.epoch.value !== env.lineage.dataEpoch
    || first.contextReceipt?.value !== snapshot.contextReceipt || first.contextEpoch?.value !== snapshot.contextDataEpoch
    || first.contextSequence?.value !== snapshot.contextSequence
    || !Number.isSafeInteger(population) || population < 0) throw new RatingAggregateUnavailable('Target snapshot unavailable');
  if (population > TARGET_AGGREGATE_COST.verifiedHeads) throw new RatingAggregateUnavailable('Target population exceeds verification');
  const observations = rows.filter(row => row.observation);
  if (observations.length !== population || population !== inventory.length
    || population === 0 && rows.length !== 1) throw new RatingAggregateUnavailable('Target population incomplete');
  const sealed = new Map(inventory.map(head => [head.observation, head]));
  const seen = new Set<string>(), histogram = Array.from({ length: 10 }, () => 0), heads: VerifiedHead[] = [];
  let withdrawnCount = 0, sum = 0;
  for (const row of observations) {
    signal.throwIfAborted();
    const head = sealed.get(row.observation!.value);
    if (!head || !row.slot || !row.head || !row.manifest || !row.profile || seen.has(row.slot.value)
      || head.slot !== row.slot.value || head.revision !== row.head.value
      || head.receipt !== row.receipt?.value || head.requestDigest !== row.digest?.value
      || head.dataEpoch !== row.revisionEpoch?.value || head.sequence !== row.revisionSequence?.value
      || !sameRatingInstant(head.evaluatedAt, row.evaluatedAt?.value)
      || !sameRatingInstant(head.submittedAt, row.submittedAt?.value)
      || row.epoch?.value !== first.epoch.value || row.sequence?.value !== first.sequence.value) {
      throw new RatingAggregateUnavailable('Target head differs from seal');
    }
    seen.add(row.slot.value);
    const state = readComponentState(env.objectDirectory, row.manifest.value, row.observation!.value, row.profile!.value, budget);
    const available = row.availability?.value === `${RV}Available`, withdrawn = row.availability?.value === `${RV}Withdrawn`;
    const value = row.value ? Number(row.value.value) : null;
    if ((!available && !withdrawn) || available && (!Number.isInteger(value) || value! < 1 || value! > 10)
      || withdrawn && value !== null || state.observation !== head.observation || state.revision !== head.revision
      || state.context !== input.context || state.target !== input.target || state.slot !== head.slot
      || state.realm !== context.realm || state.contextRevision !== context.contextRevision || state.targetGrain !== context.targetGrain
      || state.availability !== (available ? 'available' : 'withdrawn') || state.value !== value
      || state.predecessor !== (row.predecessor?.value ?? null)
      || !sameRatingInstant(state.evaluatedAt, head.evaluatedAt) || !sameRatingInstant(state.originalSubmissionAt, head.evaluatedAt)
      || !sameRatingInstant(state.submittedAt, head.submittedAt) || !sameRatingInstant(state.revisedAt, head.submittedAt)
      || targetRatingDigest({ context: input.context, target: input.target, value,
        expectedRevisionHead: state.predecessor as string | null, actingSubject: head.actingSubject }) !== head.requestDigest) {
      throw new RatingAggregateUnavailable('Target revision bytes differ');
    }
    heads.push({ slot: head.slot, revision: head.revision, value });
    if (withdrawn) withdrawnCount++;
    else { histogram[value! - 1] = histogram[value! - 1]! + 1; sum += value!; }
  }
  const figures = { slots: population, count: population - withdrawnCount, sum, histogram };
  // Sealed components are exact only once no pre-component head awaits its value.
  const exact = components !== null && components.unvalued === 0;
  if (!partial &&
    ((components ? components.slots !== population : population !== 0)
    || (exact && (components.count !== figures.count || components.sum !== sum
      || components.histogram.some((bin, index) => bin !== histogram[index]))) )
  ) {
    throw new RatingAggregateUnavailable('Target components differ from heads');
  }
  return { figures, heads, position: { dataEpoch: first.epoch.value, sequence: first.sequence.value } };
}
