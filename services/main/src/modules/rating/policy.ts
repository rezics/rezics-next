import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { readComponentState } from '../work/history.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { EXPERIENCE_CADENCE, EXPERIENCE_CONTEXT_PROFILE } from './experience.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY } from './context.ts';

export const RATING_DEFAULT_POLICY_PROFILE = 'https://rezics.com/definition/rating-aggregate-default-policy-v1';
export const RATING_DEFAULT_POLICIES = {
  'latest-per-rater-mean': RATING_LATEST_MEAN_POLICY,
  'mean-per-rater': 'https://rezics.com/definition/rating-mean-per-rater-v1',
  'pooled-observation-mean': 'https://rezics.com/definition/rating-pooled-observation-mean-v1',
} as const;
export type RatingDefaultPolicy = keyof typeof RATING_DEFAULT_POLICIES;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export class InvalidRatingPolicyInput extends Error {}
export class RatingPolicyUnavailable extends Error {}
export class StaleRatingPolicy extends Error {}

export interface SetRatingDefaultInput {
  context: string; expectedPolicyHead: string; aggregationPolicy: RatingDefaultPolicy;
  actingSubject: string;
}
export interface RatingPolicyReceipt {
  outcome: 'succeeded' | 'cancelled'; reason?: 'stale-head';
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string;
  scope: string; dataEpoch: string; sequence: string;
  context?: string; realm?: string; contextRevision?: string;
  policyRevision?: string; predecessor?: string; aggregationPolicy?: RatingDefaultPolicy;
}

export function ratingPolicyDigest(input: SetRatingDefaultInput): string {
  if (![input.context, input.expectedPolicyHead, input.actingSubject].every(value => nativeId.test(value))
    || !Object.hasOwn(RATING_DEFAULT_POLICIES, input.aggregationPolicy)) {
    throw new InvalidRatingPolicyInput('invalid Rating default policy request');
  }
  return hash(JSON.stringify({ family: 'rating-aggregate-default-policy-v1',
    context: input.context, expectedPolicyHead: input.expectedPolicyHead,
    aggregationPolicy: input.aggregationPolicy, actingSubject: input.actingSubject }));
}

export function ratingPolicyReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0rating-policy-set`)}`;
}

function namedPolicy(iriValue: string | undefined): RatingDefaultPolicy | null {
  return (Object.entries(RATING_DEFAULT_POLICIES).find(([, iri]) => iri === iriValue)?.[0]
    ?? null) as RatingDefaultPolicy | null;
}

export async function readRatingPolicyReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<RatingPolicyReceipt | null> {
  const receipt = ratingPolicyReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?reason ?digest ?id ?epoch
    ?scope ?dataEpoch ?sequence ?context ?realm ?contextRevision ?policyRevision ?predecessor ?policy WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ; rv:requestDigest ?digest ;
        rv:admissionId ?id ; rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ;
        rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:ratingContext ?context ; rv:realm ?realm ;
        rv:ratingContextRevision ?contextRevision ; rv:ratingPolicyRevision ?policyRevision ;
        rv:predecessor ?predecessor ; rv:ratingAggregationPolicy ?policy }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!, value = (name: string) => row[name]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const policy = namedPolicy(value('policy'));
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id') || !value('epoch')
    || !value('scope') || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (outcome === 'succeeded' && (!value('context') || !value('realm')
      || !value('contextRevision') || !value('policyRevision') || !value('predecessor') || !policy))
    || (outcome === 'cancelled' && (value('context') || value('policyRevision')
      || (value('reason') && value('reason') !== `${RV}StaleHead`)))) {
    throw new RatingPolicyUnavailable('Rating policy receipt is incomplete');
  }
  return { outcome, receipt, admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!, dataEpoch: value('dataEpoch')!,
    sequence: value('sequence')!, ...(value('reason') ? { reason: 'stale-head' as const } : {}),
    ...(outcome === 'succeeded' ? { context: value('context'), realm: value('realm'),
      contextRevision: value('contextRevision'), policyRevision: value('policyRevision'),
      predecessor: value('predecessor'), aggregationPolicy: policy! } : {}) };
}

function checked(receipt: RatingPolicyReceipt, admission: RegisteredAdmission,
  input: SetRatingDefaultInput, digest: string): RatingPolicyReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== digest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('Rating policy receipt differs from admission');
  }
  if (receipt.reason === 'stale-head') throw new StaleRatingPolicy('Rating policy head changed');
  if (receipt.outcome === 'cancelled') throw new RatingPolicyUnavailable('Rating policy admission was cancelled');
  if (receipt.context !== input.context || receipt.predecessor !== input.expectedPolicyHead
    || receipt.aggregationPolicy !== input.aggregationPolicy) {
    throw new IdempotencyConflict('Rating policy receipt differs from intent');
  }
  return receipt;
}

/** A point read of the fixed Context basis and independent policy head. */
export async function readRatingPolicyBasis(env: WorkActivationEnvironment, context: string) {
  if (!nativeId.test(context)) throw new InvalidRatingPolicyInput('invalid Rating Context');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?realm ?question ?contextRevision
    ?contextManifest ?policyHead ?policyManifest ?policy ?predecessor WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ; rv:ratingContext ${iri(context)} .
      ${iri(context)} a rv:RatingContext, rv:ExperienceRatingContext ; rv:contextState rv:Active ;
        rv:realm ?realm ; rv:question ?question ; rv:targetGrain rv:MainVersion ;
        rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence ${iri(EXPERIENCE_CADENCE)} ;
        rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
        rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
        rv:head ?contextRevision ; rv:ratingPolicyHead ?policyHead .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?contextRevision a rv:RevisionAnchor ; rv:component ${iri(context)} ;
        rv:modelRevision ${iri(EXPERIENCE_CONTEXT_PROFILE)} ; rv:manifest ?contextManifest .
      OPTIONAL { ?policyHead a rv:RatingPolicyRevision, rv:RevisionAnchor ;
        rv:component ${iri(context)} ; rv:contextRevision ?contextRevision ;
        rv:modelRevision ${iri(RATING_DEFAULT_POLICY_PROFILE)} ; rv:manifest ?policyManifest ;
        rv:ratingAggregationPolicy ?policy ; rv:predecessor ?predecessor }
    }
    FILTER(LANG(?question) = "en")
  }`);
  const rows = result.results?.bindings ?? [], row = rows[0];
  if (rows.length !== 1 || !row?.realm || !row.question || !row.contextRevision
    || !row.contextManifest || !row.policyHead || row.question['xml:lang'] !== 'en') {
    throw new RatingPolicyUnavailable('Rating Context policy basis is unavailable');
  }
  const state = readComponentState(env.objectDirectory, row.contextManifest.value,
    context, EXPERIENCE_CONTEXT_PROFILE);
  if (state.context !== context || state.realm !== row.realm.value || state.question !== row.question.value
    || state.state !== 'active' || state.targetGrain !== 'MainVersion' || state.scaleMin !== 1
    || state.scaleMax !== 10 || state.cadence !== EXPERIENCE_CADENCE
    || state.populationPolicy !== RATING_ACCOUNT_POPULATION || state.aggregationPolicy !== RATING_LATEST_MEAN_POLICY) {
    throw new RatingPolicyUnavailable('Rating Context question basis differs');
  }
  const baseline = row.policyHead.value === row.contextRevision.value;
  const policy = baseline ? 'latest-per-rater-mean' : namedPolicy(row.policy?.value);
  if (!policy || (!baseline && (!row.policyManifest || !row.predecessor))) {
    throw new RatingPolicyUnavailable('Rating policy revision is unavailable');
  }
  if (!baseline) {
    const policyState = readComponentState(env.objectDirectory, row.policyManifest!.value,
      context, RATING_DEFAULT_POLICY_PROFILE);
    if (policyState.context !== context || policyState.realm !== row.realm.value
      || policyState.contextRevision !== row.contextRevision.value
      || policyState.revision !== row.policyHead.value || policyState.predecessor !== row.predecessor!.value
      || policyState.aggregationPolicy !== policy || policyState.question !== state.question) {
      throw new RatingPolicyUnavailable('Rating policy revision bytes differ');
    }
  }
  return { context, realm: row.realm.value, question: row.question.value,
    contextRevision: row.contextRevision.value, policyHead: row.policyHead.value,
    aggregationPolicy: policy, predecessor: baseline ? null : row.predecessor!.value };
}

/** Historical policy reads follow an exact revision, never the moving head. */
export async function readExactRatingPolicyRevision(env: WorkActivationEnvironment,
  context: string, revision: string) {
  if (!nativeId.test(revision)) throw new InvalidRatingPolicyInput('invalid Rating policy revision');
  const basis = await readRatingPolicyBasis(env, context);
  if (revision === basis.contextRevision) {
    return { context, realm: basis.realm, contextRevision: basis.contextRevision,
      policyRevision: revision, predecessor: null, aggregationPolicy: 'latest-per-rater-mean' as const,
      basis: { question: basis.question, targetGrain: 'mainVersion' as const,
        scale: { min: 1 as const, max: 10 as const, step: 1 as const },
        cadence: 'experience' as const, population: 'account-principal' as const } };
  }
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?realm ?contextRevision
    ?predecessor ?policy ?manifest WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(context)} a rv:RatingContext, rv:ExperienceRatingContext ;
      rv:realm ?realm ; rv:head ?contextRevision . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RatingPolicyRevision, rv:RevisionAnchor ;
      rv:component ${iri(context)} ; rv:contextRevision ?contextRevision ; rv:predecessor ?predecessor ;
      rv:ratingAggregationPolicy ?policy ; rv:modelRevision ${iri(RATING_DEFAULT_POLICY_PROFILE)} ;
      rv:manifest ?manifest . }
  }`);
  const rows = result.results?.bindings ?? [], row = rows[0];
  const policy = namedPolicy(row?.policy?.value);
  if (rows.length !== 1 || !row?.manifest || !row.predecessor || !policy
    || row.realm?.value !== basis.realm || row.contextRevision?.value !== basis.contextRevision) {
    throw new RatingPolicyUnavailable('Rating policy revision is unavailable');
  }
  const state = readComponentState(env.objectDirectory, row.manifest.value,
    context, RATING_DEFAULT_POLICY_PROFILE);
  if (state.context !== context || state.realm !== basis.realm || state.question !== basis.question
    || state.contextRevision !== basis.contextRevision || state.revision !== revision
    || state.predecessor !== row.predecessor.value || state.aggregationPolicy !== policy) {
    throw new RatingPolicyUnavailable('Rating policy revision bytes differ');
  }
  return { context, realm: basis.realm, contextRevision: basis.contextRevision,
    policyRevision: revision, predecessor: row.predecessor.value, aggregationPolicy: policy,
    basis: { question: basis.question, targetGrain: 'mainVersion' as const,
      scale: { min: 1 as const, max: 10 as const, step: 1 as const },
      cadence: 'experience' as const, population: 'account-principal' as const } };
}

export async function setRatingDefaultPolicy(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: SetRatingDefaultInput): Promise<RatingPolicyReceipt> {
  const digest = ratingPolicyDigest(input);
  if (admission.action !== 'rating.context.policy.set'
    || admission.scope !== `rating:policy:${input.context}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('Rating policy admission differs from intent');
  }
  const receipt = ratingPolicyReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  const existing = await readRatingPolicyReceipt(env, admission.id);
  if (existing) return checked(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Rating policy admission expired');
  const basis = await readRatingPolicyBasis(env, input.context);
  if (basis.policyHead !== input.expectedPolicyHead) throw new StaleRatingPolicy('Rating policy head changed');
  const revision = ID + Bun.randomUUIDv7(), operation = ID + Bun.randomUUIDv7();
  const manifest = prepareComponent(env.objectDirectory, input.context,
    { context: input.context, realm: basis.realm, question: basis.question,
      contextRevision: basis.contextRevision, revision, predecessor: input.expectedPolicyHead,
      aggregationPolicy: input.aggregationPolicy }, RATING_DEFAULT_POLICY_PROFILE);
  const validations = [
    ...await profileValidations(env.fuseki, 'realm-experience-rating-context-v1', [
      { shape: `${EXPERIENCE_CONTEXT_PROFILE}/realm-shape`, focus: [basis.realm], graphs: [GRAPHS.current] },
      { shape: `${EXPERIENCE_CONTEXT_PROFILE}/context-shape`, focus: [input.context], graphs: [GRAPHS.current] },
    ], { realm: basis.realm, context: input.context, question: basis.question }),
    ...await profileValidations(env.fuseki, 'rating-aggregate-default-policy-v1', [
    { shape: `${RATING_DEFAULT_POLICY_PROFILE}/context-shape`, focus: [input.context], graphs: [GRAPHS.current] },
    { shape: `${RATING_DEFAULT_POLICY_PROFILE}/revision-shape`, focus: [revision], graphs: [GRAPHS.revisions] },
    ], { context: input.context, revision, contextRevision: basis.contextRevision,
      predecessor: input.expectedPolicyHead, aggregationPolicy: input.aggregationPolicy }),
  ];
  const batch = `urn:rezics:outbox:${hash(receipt)}`, event = `urn:rezics:event:${hash(operation)}`;
  let updateError: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} rv:ratingPolicyHead ${iri(input.expectedPolicyHead)} } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.context)} rv:ratingPolicyHead ${iri(revision)} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RatingPolicyRevision, rv:RevisionAnchor ;
          rv:component ${iri(input.context)} ; rv:contextRevision ${iri(basis.contextRevision)} ;
          rv:predecessor ${iri(input.expectedPolicyHead)} ;
          rv:ratingAggregationPolicy ${iri(RATING_DEFAULT_POLICIES[input.aggregationPolicy])} ;
          rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(RATING_DEFAULT_POLICY_PROFILE)} ;
          rv:shapeRevision ${iri(RATING_DEFAULT_POLICY_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:operation ${iri(operation)} ; rv:requestDigest ${lit(digest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:ratingContext ${iri(input.context)} ; rv:realm ${iri(basis.realm)} ;
          rv:ratingContextRevision ${iri(basis.contextRevision)} ;
          rv:ratingPolicyRevision ${iri(revision)} ; rv:predecessor ${iri(input.expectedPolicyHead)} ;
          rv:ratingAggregationPolicy ${iri(RATING_DEFAULT_POLICIES[input.aggregationPolicy])} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:RatingPolicyChangedEvent ; rv:ordinal 0 ;
          rv:action "rating.context.policy.set" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:ratingContext ${iri(input.context)} . }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(input.context)} a rv:RatingContext, rv:ExperienceRatingContext ;
            rv:contextState rv:Active ; rv:realm ${iri(basis.realm)} ;
            rv:head ${iri(basis.contextRevision)} ; rv:ratingPolicyHead ${iri(input.expectedPolicyHead)} .
          ${iri(basis.realm)} a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext ${iri(input.context)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(basis.contextRevision)} a rv:RevisionAnchor ;
          rv:component ${iri(input.context)} . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
        BIND(?n + 1 AS ?next)
      }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') throw new InvalidRatingPolicyInput('Rating policy shape rejected');
  } catch (error) {
    if (error instanceof InvalidRatingPolicyInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readRatingPolicyReceipt(env, admission.id);
  if (committed) return checked(committed, admission, input, digest);
  if (!updateError) {
    const head = await readRatingPolicyBasis(env, input.context);
    if (head.policyHead !== input.expectedPolicyHead) throw new StaleRatingPolicy('Rating policy head changed');
  }
  throw new PendingActivation('Rating policy update outcome unknown');
}

export async function sealRatingPolicyAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, reason?: 'stale-head'): Promise<RatingPolicyReceipt> {
  if (admission.action !== 'rating.context.policy.set'
    || !admission.scope.startsWith('rating:policy:')) throw new IdempotencyConflict('unsupported Rating policy admission');
  const existing = await readRatingPolicyReceipt(env, admission.id);
  if (existing) return existing;
  const receipt = ratingPolicyReceiptIri(admission.id);
  const suffix = hash(`${receipt}\0${reason ? 'stale' : 'cancel'}`);
  const event = `urn:rezics:event:${suffix}`;
  const batch = `urn:rezics:outbox:${suffix}`;
  let updateError: unknown;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
          rv:outcome rv:Cancelled ; ${reason ? 'rv:reason rv:StaleHead ;' : ''}
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a ${reason ? 'rv:RatingPolicyStaleEvent' : 'rv:RatingPolicyCancelledEvent'} ;
            rv:ordinal 0 ; rv:action "rating.context.policy.set" ; rv:receipt ${iri(receipt)} ;
            rv:admissionId ${lit(admission.id)} . }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next)
      }` }); } catch (error) { updateError = error; }
  const committed = await readRatingPolicyReceipt(env, admission.id);
  if (!committed || committed.requestDigest !== admission.requestDigest
    || committed.admissionId !== admission.id || committed.authorityEpoch !== admission.authorityEpoch
    || committed.scope !== admission.scope) throw new PendingActivation(updateError
      ? 'Rating policy cancellation outcome unknown' : 'Rating policy cancellation guard did not match');
  return committed;
}
