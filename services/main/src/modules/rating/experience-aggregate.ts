import { fusekiReadBudget, FusekiReadBudgetExceeded, FusekiQueryResponseTooLarge,
  type SparqlResult } from '../../infrastructure/fuseki.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { MAX_RATING_AGGREGATE_SLOTS } from '../access/rating-aggregate-inventory.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState, RevisionReadBudgetExceeded } from '../work/history.ts';
import { InvalidRatingAggregateQuery, RatingAggregateBudgetExceeded, RatingAggregateUnavailable,
  type StandingRatingAggregateInput } from './aggregate.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY } from './context.ts';
import { EXPERIENCE_CADENCE, EXPERIENCE_CONTEXT_PROFILE, EXPERIENCE_OBSERVATION_PROFILE,
  validOccasion } from './experience.ts';
import { EXPERIENCE_AGGREGATE_PROFILES, reduceExperienceRatings,
  type ExperienceAggregateProfile, type EffectiveExperience } from './experience-reduction.ts';
import { sameRatingInstant, standingRatingDigest } from './observation.ts';

type Row = NonNullable<NonNullable<SparqlResult['results']>['bindings']>[number];
type InventoryAccess = Pick<AccessAdmissionRegistry, 'readRatingAggregateInventory' | 'checkRatingAggregateFence'>;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const EXPERIENCE_AGGREGATE_BUDGET = { graphCalls: 1, graphBytes: 1_048_576,
  manifestBytes: 524_288, deadlineMs: 10_000 } as const;

function unavailable(): never { throw new RatingAggregateUnavailable('experience Rating evidence is incomplete'); }

/** Root and candidates share one Jena read transaction. The candidate branch
 * does not require a head: damaged or unsealed slots must remain detectable. */
export function experienceAggregateQuery(env: WorkActivationEnvironment, input: StandingRatingAggregateInput): string {
  return `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
  SELECT ?kind ?epoch ?sequence ?realm ?contextRevision ?contextManifest ?question
    ?contextEpoch ?contextSequence ?observation ?slot ?head ?occasion ?availability
    ?value ?manifest ?evaluatedAt ?submittedAt ?originalSubmissionAt ?revisedAt
    ?revisionEpoch ?revisionSequence ?receipt ?digest ?predecessor WHERE {
    GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence .
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
    }
    {
      BIND("context" AS ?kind)
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
        ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ; rv:ratingContext ${iri(input.context)} .
        ${iri(input.context)} a rv:RatingContext, rv:ExperienceRatingContext ; rv:contextState rv:Active ;
          rv:realm ?realm ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
          rv:ratingCadence ${iri(EXPERIENCE_CADENCE)} ; rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ; rv:head ?contextRevision ; rv:question ?question .
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?contextRevision a rv:RevisionAnchor ; rv:component ${iri(input.context)} ;
        rv:modelRevision ${iri(EXPERIENCE_CONTEXT_PROFILE)} ; rv:manifest ?contextManifest ;
        rv:dataEpoch ?contextEpoch ; rv:sequence ?contextSequence . }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:ratingContext ${iri(input.context)} ;
        rv:ratingContextRevision ?contextRevision ; rv:outcome rv:Succeeded . }
    } UNION {
      BIND("observation" AS ?kind)
      { SELECT ?observation WHERE { GRAPH ${iri(GRAPHS.current)} {
        ?observation rv:ratingContext ${iri(input.context)} ; rv:targetMainVersion ${iri(input.mainVersion)} .
      } } LIMIT 101 }
      OPTIONAL {
        GRAPH ${iri(GRAPHS.current)} { ?observation a rv:RatingObservation, rv:ExperienceRatingObservation ;
          rv:ratingSlot ?slot ; rv:observationHead ?head ; rv:ratingOccasion ?occasion . }
        GRAPH ${iri(GRAPHS.revisions)} {
          ?head a rv:RatingObservationRevision, rv:ExperienceRatingObservationRevision, rv:RevisionAnchor ;
            rv:component ?observation ; rv:observation ?observation ; rv:ratingOccasion ?occasion ;
            rv:modelRevision ${iri(EXPERIENCE_OBSERVATION_PROFILE)} ; rv:ratingAvailability ?availability ;
            rv:manifest ?manifest ; rv:evaluatedAt ?evaluatedAt ; rv:submittedAt ?submittedAt ;
            rv:originalSubmissionAt ?originalSubmissionAt ; rv:revisedAt ?revisedAt ;
            rv:dataEpoch ?revisionEpoch ; rv:sequence ?revisionSequence .
          OPTIONAL { ?head rv:ratingValue ?value }
          OPTIONAL { ?head rv:predecessor ?predecessor }
        }
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:observationRevision ?head ;
          rv:ratingObservation ?observation ; rv:outcome rv:Succeeded ; rv:requestDigest ?digest . }
      }
    }
  } LIMIT 103`;
}

async function snapshot(env: WorkActivationEnvironment, access: InventoryAccess,
  input: StandingRatingAggregateInput & { profile: ExperienceAggregateProfile }, signal: AbortSignal) {
  const inventory = await access.readRatingAggregateInventory(input.context, input.mainVersion, signal);
  if (inventory.heads.length > MAX_RATING_AGGREGATE_SLOTS) {
    throw new RatingAggregateBudgetExceeded('experience Rating population exceeds admitted bound');
  }
  signal.throwIfAborted();
  const result = await env.fuseki.query(experienceAggregateQuery(env, input), EXPERIENCE_AGGREGATE_BUDGET.graphBytes);
  const rows = result.results?.bindings ?? [];
  const contexts = rows.filter(row => row.kind?.value === 'context'), context = contexts[0];
  if (contexts.length !== 1 || !context?.epoch || !/^[0-9]+$/.test(context.sequence?.value ?? '')
    || context.realm?.value !== inventory.realm || context.contextRevision?.value !== inventory.contextRevision
    || context.contextEpoch?.value !== inventory.contextDataEpoch || context.contextSequence?.value !== inventory.contextSequence
    || context.receipt?.value !== inventory.contextReceipt || !context.contextManifest || context.question?.['xml:lang'] !== 'en'
    || (inventory.contextDataEpoch === context.epoch.value && BigInt(inventory.contextSequence) > BigInt(context.sequence!.value))
    || rows.some(row => row.epoch?.value !== context.epoch!.value || row.sequence?.value !== context.sequence!.value)) unavailable();
  const budget = { bytesLeft: EXPERIENCE_AGGREGATE_BUDGET.manifestBytes as number, signal };
  const contextState = readComponentState(env.objectDirectory, context.contextManifest!.value,
    input.context, EXPERIENCE_CONTEXT_PROFILE, budget);
  if (contextState.context !== input.context || contextState.realm !== inventory.realm
    || contextState.question !== context.question!.value || contextState.state !== 'active'
    || contextState.targetGrain !== 'MainVersion' || contextState.scaleMin !== 1 || contextState.scaleMax !== 10
    || contextState.cadence !== EXPERIENCE_CADENCE || contextState.populationPolicy !== RATING_ACCOUNT_POPULATION
    || contextState.aggregationPolicy !== RATING_LATEST_MEAN_POLICY) unavailable();
  const graphHeads = rows.filter(row => row.kind?.value === 'observation');
  if (graphHeads.length !== inventory.heads.length || rows.length !== graphHeads.length + 1) unavailable();
  const byObservation = new Map<string, Row>();
  for (const row of graphHeads) {
    if (!row.observation || byObservation.has(row.observation.value)) unavailable();
    byObservation.set(row.observation.value, row);
  }
  const effective: EffectiveExperience[] = [];
  for (const head of inventory.heads) {
    const row = byObservation.get(head.observation);
    if (!row || head.work !== input.work || row.slot?.value !== head.slot || row.head?.value !== head.revision
      || row.receipt?.value !== head.receipt || row.digest?.value !== head.requestDigest
      || row.revisionEpoch?.value !== head.dataEpoch || row.revisionSequence?.value !== head.sequence
      || (head.dataEpoch === context.epoch!.value && BigInt(head.sequence) > BigInt(context.sequence!.value))
      || !row.manifest || !sameRatingInstant(head.evaluatedAt, row.evaluatedAt?.value)
      || !sameRatingInstant(head.evaluatedAt, row.originalSubmissionAt?.value)
      || !sameRatingInstant(head.submittedAt, row.submittedAt?.value)
      || !sameRatingInstant(head.submittedAt, row.revisedAt?.value)) unavailable();
    const availability = row.availability?.value === `${RV}Available` ? 'available'
      : row.availability?.value === `${RV}Withdrawn` ? 'withdrawn' : null;
    const value = row.value ? Number(row.value.value) : null;
    if (!availability || (availability === 'available' && (!Number.isInteger(value) || value! < 1 || value! > 10))
      || (availability === 'withdrawn' && value !== null)) unavailable();
    const state = readComponentState(env.objectDirectory, row.manifest.value,
      head.observation, EXPERIENCE_OBSERVATION_PROFILE, budget);
    if (state.observation !== head.observation || state.revision !== head.revision || state.slot !== head.slot
      || state.context !== input.context || state.contextRevision !== inventory.contextRevision || state.realm !== inventory.realm
      || state.work !== input.work || state.mainVersion !== input.mainVersion || state.availability !== availability
      || state.value !== value || state.evaluatedAt !== head.evaluatedAt || state.originalSubmissionAt !== head.evaluatedAt
      || state.submittedAt !== head.submittedAt || state.revisedAt !== head.submittedAt
      || state.predecessor !== (row.predecessor?.value ?? null) || !validOccasion(state.occasion)
      || state.occasionKey !== row.occasion?.value) unavailable();
    if (standingRatingDigest({ context: input.context, work: input.work, mainVersion: input.mainVersion,
      value, expectedRevisionHead: state.predecessor as string | null, actingSubject: head.actingSubject,
      occasion: state.occasion }) !== head.requestDigest) unavailable();
    effective.push({ observation: head.observation, raterKey: head.raterKey, evaluatedAt: head.evaluatedAt, value });
  }
  if (!await access.checkRatingAggregateFence(inventory.recoveryGeneration, signal)) unavailable();
  signal.throwIfAborted();
  return { profile: input.profile, complete: true as const,
    context: input.context, realm: inventory.realm, work: input.work, mainVersion: input.mainVersion,
    targetGrain: 'mainVersion' as const, scale: { min: 1, max: 10, step: 1 },
    cadence: 'experience' as const, populationPolicy: 'account-principal' as const,
    ...reduceExperienceRatings(input.profile, effective),
    sourcePosition: { datasetId: 'product' as const, dataEpoch: context.epoch!.value, sequence: context.sequence!.value } };
}

export async function queryExperienceRatingAggregate(env: WorkActivationEnvironment, access: InventoryAccess,
  input: StandingRatingAggregateInput & { profile: ExperienceAggregateProfile }) {
  if (!EXPERIENCE_AGGREGATE_PROFILES.includes(input.profile)
    || ![input.context, input.work, input.mainVersion].every(value => nativeId.test(value))) {
    throw new InvalidRatingAggregateQuery('invalid experience Rating aggregate target');
  }
  const outer = fusekiReadBudget.getStore();
  const deadline = AbortSignal.timeout(EXPERIENCE_AGGREGATE_BUDGET.deadlineMs);
  const signal = outer ? AbortSignal.any([deadline, outer.signal]) : deadline;
  let callsLeft: number = EXPERIENCE_AGGREGATE_BUDGET.graphCalls, bytesLeft: number = EXPERIENCE_AGGREGATE_BUDGET.graphBytes;
  const budget = { signal,
    get callsLeft() { return Math.min(callsLeft, outer?.callsLeft ?? callsLeft); },
    set callsLeft(value: number) { const used = this.callsLeft - value; callsLeft -= used; if (outer) outer.callsLeft -= used; },
    get bytesLeft() { return Math.min(bytesLeft, outer?.bytesLeft ?? bytesLeft); },
    set bytesLeft(value: number) { const used = this.bytesLeft - value; bytesLeft -= used; if (outer) outer.bytesLeft -= used; },
  };
  try {
    // Each charge also debits the enclosing budget; neither gets replenished.
    return await fusekiReadBudget.run(budget, () => snapshot(env, access, input, signal));
  } catch (error) {
    if (error instanceof RatingAggregateBudgetExceeded) throw error;
    if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge
      || error instanceof RevisionReadBudgetExceeded) throw new RatingAggregateBudgetExceeded('Rating read budget exceeded');
    throw new RatingAggregateUnavailable('experience Rating snapshot is unavailable');
  }
}
