import { fusekiReadBudget, FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded,
  type SparqlResult } from '../../infrastructure/fuseki.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { MAX_RATING_AGGREGATE_SLOTS, type RatingAggregateInventory } from '../access/rating-aggregate-inventory.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState, RevisionReadBudgetExceeded, type RevisionReadBudget } from '../work/history.ts';
import { InvalidRatingAggregateQuery, RatingAggregateBudgetExceeded, RatingAggregateUnavailable } from './aggregate.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY, RATING_STANDING_CADENCE,
  REALM_STANDING_RATING_CONTEXT_PROFILE } from './context.ts';
import { GLOBAL_CONTEXT_PROFILE, GLOBAL_OBSERVATION_PROFILE, GLOBAL_RATING_POPULATION_OWNER, GLOBAL_RATING_SCALE, globalContextPattern, globalRatingDigest,
  isGlobalContextState } from './global.ts';
import { sameRatingInstant, STANDING_RATING_OBSERVATION_PROFILE, standingRatingDigest } from './observation.ts';
import { REALM_GLOBAL_SYNTHESIS_POLICY, REALM_GLOBAL_SYNTHESIS_PROFILE, reduceStandingComponent,
  synthesizeRealmGlobal } from './synthesis.ts';

type Row = NonNullable<NonNullable<SparqlResult['results']>['bindings']>[number];
type InventoryAccess = Pick<AccessAdmissionRegistry, 'readRatingAggregateInventory' | 'checkRatingAggregateFence'>;
type Kind = 'realm' | 'global';
interface Target { work: string; mainVersion: string }

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const GLOBAL_AGGREGATE_PROFILE = 'global-rating-standing-latest-mean-v1';
/** Per request, whether it reads one Context or both synthesis components. */
export const GLOBAL_AGGREGATE_BUDGET = { graphCalls: 1, graphBytes: 1_048_576,
  manifestBytes: 524_288, deadlineMs: 10_000 } as const;

const KINDS = {
  realm: { contextProfile: REALM_STANDING_RATING_CONTEXT_PROFILE, observationProfile: STANDING_RATING_OBSERVATION_PROFILE,
    observationType: 'rv:RatingObservation', revisionType: 'rv:RatingObservationRevision',
    scale: { min: 1, max: 10 }, populationPolicy: 'account-principal' },
  global: { contextProfile: GLOBAL_CONTEXT_PROFILE, observationProfile: GLOBAL_OBSERVATION_PROFILE,
    observationType: 'rv:GlobalRatingObservation', revisionType: 'rv:GlobalRatingObservationRevision',
    scale: GLOBAL_RATING_SCALE, populationPolicy: 'global-account-principal' },
} as const;

function unavailable(): never { throw new RatingAggregateUnavailable('standing Rating evidence is incomplete'); }

function contextPattern(kind: Kind, context: string): string {
  return kind === 'global' ? `${globalContextPattern(context)} ; rv:head ?contextRevision ; rv:question ?question .
      BIND(${iri(GLOBAL_RATING_POPULATION_OWNER)} AS ?owner)`
    : `?space a rv:Space ; rv:realmCapability ?owner ; rv:disclosure rv:Public .
      ?owner a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ; rv:ratingContext ${iri(context)} .
      ${iri(context)} a rv:RatingContext ; rv:contextState rv:Active ; rv:realm ?owner ;
        rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
        rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ; rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
        rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ; rv:head ?contextRevision ; rv:question ?question .`;
}

/** One read transaction for every component: each root plus at most 101 candidates.
 * Candidates do not require a head, so damaged or unsealed slots stay detectable. */
function standingComponentsSelect(env: WorkActivationEnvironment,
  components: readonly { kind: Kind; context: string }[], target: Target, inventories?: readonly RatingAggregateInventory[]): string {
  const branches = components.flatMap(({ kind, context }, index) => {
    const inherited = inventories?.[index]?.heads.filter(head => head.originWork) ?? [];
    const spec = KINDS[kind];
    return [`{
      BIND("context" AS ?kind) BIND("${kind}" AS ?component)
      GRAPH ${iri(GRAPHS.current)} {
        ${contextPattern(kind, context)}
        ${iri(target.work)} a schema:CreativeWork ; rv:mainVersion ${iri(target.mainVersion)} .
        ${iri(target.mainVersion)} a rv:MainVersion ; rv:work ${iri(target.work)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?contextRevision a rv:RevisionAnchor ; rv:component ${iri(context)} ;
        rv:modelRevision ${iri(spec.contextProfile)} ; rv:manifest ?contextManifest ; rv:operation ?contextOperation ;
        rv:dataEpoch ?contextEpoch ; rv:sequence ?contextSequence . }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:ratingContext ${iri(context)} ;
        rv:ratingContextRevision ?contextRevision ; rv:operation ?contextOperation ; rv:outcome rv:Succeeded . }
    }`, `{
      BIND("observation" AS ?kind) BIND("${kind}" AS ?component)
      { SELECT DISTINCT ?observation WHERE {
        { GRAPH ${iri(GRAPHS.current)} { ?observation rv:ratingContext ${iri(context)} ; rv:targetMainVersion ${iri(target.mainVersion)} } }
        ${inherited.length ? `UNION { VALUES (?observation ?origin) { ${inherited.map(head => `(${iri(head.observation)} ${iri(head.originWork!)})`).join(' ')} }
          GRAPH ${iri(GRAPHS.current)} { ?origin rv:mergedInto+ ${iri(target.work)} } }` : ''}
      } LIMIT ${101 + inherited.length} }
      OPTIONAL {
        GRAPH ${iri(GRAPHS.current)} { ?observation a ${spec.observationType} ;
          rv:ratingSlot ?slot ; rv:observationHead ?head . }
        GRAPH ${iri(GRAPHS.revisions)} {
          ?head a ${spec.revisionType}, rv:RevisionAnchor ; rv:component ?observation ; rv:observation ?observation ;
            rv:modelRevision ${iri(spec.observationProfile)} ; rv:ratingAvailability ?availability ;
            rv:manifest ?manifest ; rv:evaluatedAt ?evaluatedAt ; rv:submittedAt ?submittedAt ;
            rv:originalSubmissionAt ?originalSubmissionAt ; rv:revisedAt ?revisedAt ;
            rv:dataEpoch ?revisionEpoch ; rv:sequence ?revisionSequence .
          OPTIONAL { ?head rv:ratingValue ?value }
          OPTIONAL { ?head rv:predecessor ?predecessor }
        }
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:observationRevision ?head ;
          rv:ratingObservation ?observation ; rv:outcome rv:Succeeded ; rv:requestDigest ?digest . }
      }
    }`];
  });
  return `SELECT ?kind ?component ?epoch ?sequence ?owner ?contextRevision ?contextManifest ?question
    ?contextEpoch ?contextSequence ?observation ?slot ?head ?availability ?value ?manifest ?evaluatedAt
    ?submittedAt ?originalSubmissionAt ?revisedAt ?revisionEpoch ?revisionSequence ?receipt ?digest
    ?predecessor WHERE {
    GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence .
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
    }
    ${branches.join(' UNION ')}
  } LIMIT ${components.length * 102 + (inventories?.reduce((count,inventory) => count + inventory.heads.filter(head => head.originWork).length,0) ?? 0) + 1}`;
}

export function standingComponentsQuery(env: WorkActivationEnvironment,
  components: readonly { kind: Kind; context: string }[], target: Target, inventories?: readonly RatingAggregateInventory[]): string {
  return `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>\n${standingComponentsSelect(env, components, target, inventories)}`;
}

/** Compare one Context's sealed Access inventory with the shared graph snapshot. */
function verifyComponent(env: WorkActivationEnvironment, kind: Kind, context: string, target: Target,
  inventory: RatingAggregateInventory, root: Row, rows: readonly Row[], budget: RevisionReadBudget,
  onlySlot?: string, contexts?: Map<string, Record<string, unknown>>) {
  const spec = KINDS[kind];
  const epoch = root.epoch!.value, sequence = root.sequence!.value;
  const later = (dataEpoch: string, at: string) => dataEpoch === epoch && BigInt(at) > BigInt(sequence);
  if (root.owner?.value !== inventory.realm || root.contextRevision?.value !== inventory.contextRevision
    || root.contextEpoch?.value !== inventory.contextDataEpoch || root.contextSequence?.value !== inventory.contextSequence
    || root.receipt?.value !== inventory.contextReceipt || !root.contextManifest || root.question?.['xml:lang'] !== 'en'
    || later(inventory.contextDataEpoch, inventory.contextSequence)) unavailable();
  const contextKey = `${context}\0${root.contextManifest.value}\0${spec.contextProfile}`;
  const contextState = contexts?.get(contextKey) ?? readComponentState(env.objectDirectory,
    root.contextManifest.value, context, spec.contextProfile, budget);
  contexts?.set(contextKey, contextState);
  if (kind === 'global' ? !isGlobalContextState(contextState, context, root.question!.value)
    : contextState.context !== context || contextState.realm !== inventory.realm
      || contextState.question !== root.question!.value || contextState.state !== 'active'
      || contextState.targetGrain !== 'MainVersion' || contextState.scaleMin !== 1 || contextState.scaleMax !== 10
      || contextState.cadence !== RATING_STANDING_CADENCE || contextState.populationPolicy !== RATING_ACCOUNT_POPULATION
      || contextState.aggregationPolicy !== RATING_LATEST_MEAN_POLICY) unavailable();
  if (rows.length !== inventory.heads.length) unavailable();
  const byObservation = new Map<string, Row>();
  for (const row of rows) {
    if (!row.observation || byObservation.has(row.observation.value)) unavailable();
    byObservation.set(row.observation.value, row);
  }
  const values: (number | null)[] = [];
  for (const head of inventory.heads) {
    const row = byObservation.get(head.observation);
    if (!row || head.work !== target.work || row.slot?.value !== head.slot || row.head?.value !== head.revision
      || row.receipt?.value !== head.receipt || row.digest?.value !== head.requestDigest
      || row.revisionEpoch?.value !== head.dataEpoch || row.revisionSequence?.value !== head.sequence
      || later(head.dataEpoch, head.sequence) || !row.manifest
      // Global writes take Access's admission instants; standing Realm writes predate that rule.
      || (kind === 'global' && (!sameRatingInstant(head.evaluatedAt, row.evaluatedAt?.value)
        || !sameRatingInstant(head.evaluatedAt, row.originalSubmissionAt?.value)
        || !sameRatingInstant(head.submittedAt, row.submittedAt?.value)
        || !sameRatingInstant(head.submittedAt, row.revisedAt?.value)))) unavailable();
    const availability = row.availability?.value === `${RV}Available` ? 'available'
      : row.availability?.value === `${RV}Withdrawn` ? 'withdrawn' : null;
    const value = row.value ? Number(row.value.value) : null;
    if (!availability || (availability === 'available' && (!Number.isInteger(value)
      || value! < spec.scale.min || value! > spec.scale.max))
      || (availability === 'withdrawn' && value !== null)) unavailable();
    const state = readComponentState(env.objectDirectory, row.manifest.value, head.observation,
      spec.observationProfile, budget);
    if (state.observation !== head.observation || state.revision !== head.revision || state.slot !== head.slot
      || state.context !== context || state.contextRevision !== inventory.contextRevision
      || (kind === 'global' ? state.populationOwner !== inventory.realm : state.realm !== inventory.realm)
      || state.work !== (head.originWork ?? target.work) || state.mainVersion !== (head.originMainVersion ?? target.mainVersion)
      || state.availability !== availability || state.value !== value
      || state.predecessor !== (row.predecessor?.value ?? null)
      || !sameRatingInstant(state.evaluatedAt, row.evaluatedAt?.value)
      || !sameRatingInstant(state.originalSubmissionAt, row.originalSubmissionAt?.value)
      || !sameRatingInstant(state.submittedAt, row.submittedAt?.value)
      || !sameRatingInstant(state.revisedAt, row.revisedAt?.value)) unavailable();
    const intent = { context, work: head.originWork ?? target.work, mainVersion: head.originMainVersion ?? target.mainVersion, value,
      expectedRevisionHead: state.predecessor as string | null, actingSubject: head.actingSubject };
    if ((kind === 'global' ? globalRatingDigest(intent) : standingRatingDigest(intent)) !== head.requestDigest) unavailable();
    if (onlySlot === undefined || (head.effectiveSlot ?? head.slot) === onlySlot) values.push(value);
  }
  return { context, populationOwner: inventory.realm, contextProfile: spec.contextProfile.split('/').at(-1)!,
    populationPolicy: spec.populationPolicy, cadence: 'standing' as const,
    aggregationPolicy: 'latest-per-rater-mean' as const, contextRevision: inventory.contextRevision,
    ...reduceStandingComponent(values, spec.scale) };
}

async function snapshot(env: WorkActivationEnvironment, access: InventoryAccess,
  components: readonly { kind: Kind; context: string }[], target: Target, signal: AbortSignal,
  onlySlot?: string) {
  const inventories: RatingAggregateInventory[] = [];
  for (const { kind, context } of components) {
    const inventory = await access.readRatingAggregateInventory(context, target.mainVersion, signal);
    if ((inventory.realm === GLOBAL_RATING_POPULATION_OWNER) !== (kind === 'global')) {
      throw new InvalidRatingAggregateQuery(`${kind} component names another Context kind`);
    }
    if (inventory.heads.length > MAX_RATING_AGGREGATE_SLOTS) {
      throw new RatingAggregateBudgetExceeded('standing Rating population exceeds admitted bound');
    }
    inventories.push(inventory);
  }
  if (inventories.some(inventory => inventory.recoveryGeneration !== inventories[0]!.recoveryGeneration)) unavailable();
  signal.throwIfAborted();
  const result = await env.fuseki.query(standingComponentsQuery(env, components, target, inventories),
    GLOBAL_AGGREGATE_BUDGET.graphBytes);
  const rows = result.results?.bindings ?? [];
  const root = rows[0];
  if (!root?.epoch || !/^[0-9]+$/.test(root.sequence?.value ?? '')
    || rows.some(row => row.epoch?.value !== root.epoch!.value || row.sequence?.value !== root.sequence!.value)) unavailable();
  const budget = { bytesLeft: GLOBAL_AGGREGATE_BUDGET.manifestBytes as number, signal };
  const verified = components.map(({ kind, context }, index) => {
    const own = rows.filter(row => row.component?.value === kind);
    const roots = own.filter(row => row.kind?.value === 'context');
    if (roots.length !== 1) unavailable();
    return verifyComponent(env, kind, context, target, inventories[index]!, roots[0]!,
      own.filter(row => row.kind?.value === 'observation'), budget, onlySlot);
  });
  if (rows.some(row => !components.some(({ kind }) => kind === row.component?.value))) unavailable();
  if (!await access.checkRatingAggregateFence(inventories[0]!.recoveryGeneration, signal)) unavailable();
  signal.throwIfAborted();
  return { components: verified,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: root.epoch.value, sequence: root.sequence!.value } };
}

/** One shared deadline and graph budget; each charge also debits an enclosing budget. */
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const outer = fusekiReadBudget.getStore();
  const deadline = AbortSignal.timeout(GLOBAL_AGGREGATE_BUDGET.deadlineMs);
  const signal = outer ? AbortSignal.any([deadline, outer.signal]) : deadline;
  let callsLeft: number = GLOBAL_AGGREGATE_BUDGET.graphCalls, bytesLeft: number = GLOBAL_AGGREGATE_BUDGET.graphBytes;
  const budget = { signal,
    get callsLeft() { return Math.min(callsLeft, outer?.callsLeft ?? callsLeft); },
    set callsLeft(value: number) { const used = this.callsLeft - value; callsLeft -= used; if (outer) outer.callsLeft -= used; },
    get bytesLeft() { return Math.min(bytesLeft, outer?.bytesLeft ?? bytesLeft); },
    set bytesLeft(value: number) { const used = this.bytesLeft - value; bytesLeft -= used; if (outer) outer.bytesLeft -= used; },
  };
  try {
    return await fusekiReadBudget.run(budget, () => operation(signal));
  } catch (error) {
    if (error instanceof RatingAggregateBudgetExceeded || error instanceof InvalidRatingAggregateQuery) throw error;
    if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge
      || error instanceof RevisionReadBudgetExceeded) throw new RatingAggregateBudgetExceeded('Rating read budget exceeded');
    throw new RatingAggregateUnavailable('standing Rating snapshot is unavailable');
  }
}

export async function queryGlobalRatingAggregate(env: WorkActivationEnvironment, access: InventoryAccess,
  input: { context: string } & Target) {
  if (![input.context, input.work, input.mainVersion].every(value => nativeId.test(value))) {
    throw new InvalidRatingAggregateQuery('invalid Global Rating aggregate target');
  }
  const result = await bounded(signal => snapshot(env, access, [{ kind: 'global', context: input.context }], input, signal));
  return { profile: GLOBAL_AGGREGATE_PROFILE, complete: true as const, work: input.work,
    mainVersion: input.mainVersion, targetGrain: 'mainVersion' as const, ...result.components[0]!,
    sourcePosition: result.sourcePosition };
}

/** Work-page adapter: preserve the same sealed evidence and caps for a single Realm
 * population or the authenticated reader's slot. Slot derivation stays server-side. */
export async function queryWorkStandingRating(env: WorkActivationEnvironment, access: InventoryAccess,
  input: { kind: Kind; context: string; onlySlot?: string } & Target) {
  if (![input.context, input.work, input.mainVersion].every(value => nativeId.test(value))
    || (input.onlySlot !== undefined && !/^urn:rezics:rating-slot:[0-9a-f]{64}$/.test(input.onlySlot))) {
    throw new InvalidRatingAggregateQuery('invalid Work Rating target');
  }
  const result = await bounded(signal => snapshot(env, access,
    [{ kind: input.kind, context: input.context }], input, signal, input.onlySlot));
  return { ...result.components[0]!, sourcePosition: result.sourcePosition };
}

/** Preserve the public Realm aggregate contract while using the same effective
 * person inventory as Work pages and Realm/global synthesis. */
export async function queryRealmStandingAggregate(env: WorkActivationEnvironment,access: InventoryAccess,
  input: { context: string } & Target) {
  const result = await queryWorkStandingRating(env,access,{ ...input,kind: 'realm' });
  return { profile: 'realm-standing-latest-mean-v1' as const,complete: true,
    context: input.context,realm: result.populationOwner,work: input.work,mainVersion: input.mainVersion,
    targetGrain: 'mainVersion' as const,scale: result.scale,cadence: 'standing' as const,
    populationPolicy: 'account-principal' as const,aggregationPolicy: 'latest-per-rater-mean' as const,
    population: result.population,count: result.count,withdrawnCount: result.withdrawnCount,
    histogram: result.histogram,sum: result.sum,mean: result.mean,
    precision: result.count ? { kind: 'exact-rational' as const,numerator: result.sum,denominator: result.count }
      : { kind: 'no-data' as const },sourcePosition: result.sourcePosition };
}

/** Search's page adapter preserves the single-Work sealed-inventory verifier.
 * One graph transaction for <=64 targets, <=100 slots per target, one shared
 * 1 MiB graph / 512 KiB manifest budget and one recovery fence. Access still
 * owns each exact inventory; a missing, extra or damaged slot fails the page.
 * Grouping/verification is O(targets + slots); the shared Context manifest is
 * read and charged once, while each target retains its exact receipt checks. */
export async function queryWorkStandingRatings(env: WorkActivationEnvironment, access: InventoryAccess,
  input: { kind: Kind; context: string; targets: readonly Target[] }) {
  if (input.targets.length > 64 || !nativeId.test(input.context)
    || input.targets.some(target => !nativeId.test(target.work) || !nativeId.test(target.mainVersion))
    || new Set(input.targets.map(target => target.work)).size !== input.targets.length
    || new Set(input.targets.map(target => target.mainVersion)).size !== input.targets.length) {
    throw new InvalidRatingAggregateQuery('invalid Work Rating batch');
  }
  return bounded(async signal => {
    const values = new Map<string, Awaited<ReturnType<typeof queryWorkStandingRating>>>();
    if (!input.targets.length) return values;
    const inventories: RatingAggregateInventory[] = [];
    for (const target of input.targets) {
      const inventory = await access.readRatingAggregateInventory(input.context, target.mainVersion, signal);
      if ((inventory.realm === GLOBAL_RATING_POPULATION_OWNER) !== (input.kind === 'global')) unavailable();
      if (inventory.heads.length > MAX_RATING_AGGREGATE_SLOTS) {
        throw new RatingAggregateBudgetExceeded('standing Rating population exceeds admitted bound');
      }
      inventories.push(inventory);
    }
    if (inventories.some(inventory => inventory.recoveryGeneration !== inventories[0]!.recoveryGeneration)) unavailable();
    const branches = input.targets.map((target,index) => `{ {
      ${standingComponentsSelect(env, [{ kind: input.kind, context: input.context }], target, [inventories[index]!])}
    } BIND(${iri(target.work)} AS ?targetWork) }`);
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      SELECT * WHERE { ${branches.join(' UNION ')} } LIMIT ${input.targets.length * 203 + 1}`,
    GLOBAL_AGGREGATE_BUDGET.graphBytes)).results?.bindings ?? [];
    const root = rows[0];
    if (!root?.epoch || !/^\d+$/.test(root.sequence?.value ?? '')) unavailable();
    const groups = new Map<string, Row[]>(input.targets.map(target => [target.work, []]));
    for (const row of rows) {
      const group = groups.get(row.targetWork?.value ?? '');
      if (!group || row.epoch?.value !== root.epoch.value || row.sequence?.value !== root.sequence!.value
        || row.component?.value !== input.kind || !['context', 'observation'].includes(row.kind?.value ?? '')) unavailable();
      group.push(row);
    }
    const budget = { bytesLeft: GLOBAL_AGGREGATE_BUDGET.manifestBytes as number, signal };
    const contexts = new Map<string, Record<string, unknown>>();
    for (const [index, target] of input.targets.entries()) {
      const own = groups.get(target.work)!;
      const roots = own.filter(row => row.kind?.value === 'context');
      if (roots.length !== 1) unavailable();
      const component = verifyComponent(env, input.kind, input.context, target, inventories[index]!, roots[0]!,
        own.filter(row => row.kind?.value === 'observation'), budget, undefined, contexts);
      values.set(target.work, { ...component, sourcePosition: { datasetId: 'product',
        dataEpoch: root.epoch.value, sequence: root.sequence!.value } });
    }
    if (!await access.checkRatingAggregateFence(inventories[0]!.recoveryGeneration, signal)) unavailable();
    signal.throwIfAborted();
    return values;
  });
}

export async function queryRealmGlobalSynthesis(env: WorkActivationEnvironment, access: InventoryAccess,
  input: { realmContext: string; globalContext: string } & Target) {
  if (![input.realmContext, input.globalContext, input.work, input.mainVersion].every(value => nativeId.test(value))
    || input.realmContext === input.globalContext) {
    throw new InvalidRatingAggregateQuery('invalid Rating synthesis target');
  }
  const result = await bounded(signal => snapshot(env, access, [{ kind: 'realm', context: input.realmContext },
    { kind: 'global', context: input.globalContext }], input, signal));
  const [realm, global] = result.components as [typeof result.components[0], typeof result.components[0]];
  return { profile: REALM_GLOBAL_SYNTHESIS_PROFILE, work: input.work, mainVersion: input.mainVersion,
    targetGrain: 'mainVersion' as const, policy: REALM_GLOBAL_SYNTHESIS_POLICY,
    ...synthesizeRealmGlobal(realm, global), components: { realm, global },
    sourcePosition: result.sourcePosition };
}
