import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { readComponentState } from '../work/history.ts';
import { CancelledActivation, DATASET, GRAPHS, ID, IdempotencyConflict, PendingActivation, RV,
  hash, iri, lit, prepareComponent, type WorkActivationEnvironment } from '../work/activate.ts';
import { InvalidRatingContextInput, RATING_LATEST_MEAN_POLICY, RATING_STANDING_CADENCE,
  ratingContextReceiptIri, readRatingContextReceipt, type RatingContextReceipt } from './context.ts';
import { canonicalRatingInstant, InvalidRatingObservationInput, RatingObservationUnavailable,
  readStandingRatingReceipt, StaleRatingObservation, standingRatingReceiptIri, standingRatingSlotIri,
  type RatingObservationReceipt } from './observation.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** The Global population's authority scope. It stands where Realm profiles name a
 * Realm (Access scope, receipt, event and inventory), but it is not a Realm. */
export const GLOBAL_RATING_POPULATION_OWNER = 'https://rezics.com/id/00000000-0000-8000-8000-676c6f62616c';
export const GLOBAL_CONTEXT_ID = 'global-rating-standing-context-v1';
export const GLOBAL_OBSERVATION_ID = 'global-rating-standing-observation-v1';
export const GLOBAL_CONTEXT_PROFILE = `https://rezics.com/definition/${GLOBAL_CONTEXT_ID}`;
export const GLOBAL_OBSERVATION_PROFILE = `https://rezics.com/definition/${GLOBAL_OBSERVATION_ID}`;
export const GLOBAL_RATING_POPULATION =
  'https://rezics.com/definition/rating-global-account-principal-population-v1';
export const GLOBAL_RATING_SCALE = { min: 1, max: 5 } as const;
export const GLOBAL_CONTEXT_SCOPE = `rating:context:${GLOBAL_RATING_POPULATION_OWNER}`;

export interface CreateGlobalRatingContextInput { question: string; actingSubject: string }

export interface SetGlobalRatingInput {
  context: string; work: string; mainVersion: string;
  expectedRevisionHead: string | null; value: number | null; actingSubject: string;
}

/** Fixed Context triples; reads and command guards share them so no Realm pattern can match. */
export function globalContextPattern(context: string): string {
  return `${iri(context)} a rv:GlobalRatingContext ; rv:contextState rv:Active ;
    rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} ; rv:targetGrain rv:MainVersion ;
    rv:ratingScaleMin ${GLOBAL_RATING_SCALE.min} ; rv:ratingScaleMax ${GLOBAL_RATING_SCALE.max} ;
    rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
    rv:ratingPopulationPolicy ${iri(GLOBAL_RATING_POPULATION)} ;
    rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)}`;
}

/** The immutable Context manifest must restate every fixed Global policy. */
export function isGlobalContextState(state: Record<string, unknown>, context: string, question: string): boolean {
  return state.context === context && state.populationOwner === GLOBAL_RATING_POPULATION_OWNER
    && state.question === question && state.state === 'active' && state.targetGrain === 'MainVersion'
    && state.scaleMin === GLOBAL_RATING_SCALE.min && state.scaleMax === GLOBAL_RATING_SCALE.max
    && state.cadence === RATING_STANDING_CADENCE && state.populationPolicy === GLOBAL_RATING_POPULATION
    && state.aggregationPolicy === RATING_LATEST_MEAN_POLICY && !('realm' in state);
}

export function globalRatingContextDigest(input: CreateGlobalRatingContextInput): string {
  if (!nativeId.test(input.actingSubject) || typeof input.question !== 'string'
    || input.question.length < 3 || input.question.length > 120
    || input.question !== input.question.normalize('NFC') || input.question.trim() !== input.question
    || /[\u0000-\u001f\u007f]/u.test(input.question)) {
    throw new InvalidRatingContextInput('invalid Global rating context request');
  }
  return hash(JSON.stringify({ family: GLOBAL_CONTEXT_ID, populationOwner: GLOBAL_RATING_POPULATION_OWNER,
    question: input.question, actingSubject: input.actingSubject, targetGrain: 'MainVersion',
    scale: [GLOBAL_RATING_SCALE.min, GLOBAL_RATING_SCALE.max], cadence: RATING_STANDING_CADENCE,
    population: GLOBAL_RATING_POPULATION, aggregation: RATING_LATEST_MEAN_POLICY }));
}

export function checkedGlobalContextReceipt(receipt: RatingContextReceipt, admission: RegisteredAdmission,
  digest: string): RatingContextReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== digest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('Global rating context admission differs from receipt');
  }
  if (receipt.outcome === 'cancelled') throw new CancelledActivation('Global rating context creation was cancelled');
  if (receipt.realm !== GLOBAL_RATING_POPULATION_OWNER) throw new IdempotencyConflict('rating population owner differs');
  return receipt;
}

/** One guarded write: Context, revision anchor, creation receipt and retained event. */
export async function createGlobalRatingContext(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: CreateGlobalRatingContextInput): Promise<RatingContextReceipt> {
  const digest = globalRatingContextDigest(input);
  if (admission.action !== 'rating.context.create' || admission.scope !== GLOBAL_CONTEXT_SCOPE
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('Global rating context admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, ratingContextReceiptIri(admission.id));
  const existing = await readRatingContextReceipt(env, admission.id);
  if (existing) return checkedGlobalContextReceipt(existing, admission, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Global rating context admission expired');
  const context = ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await profileValidations(env.fuseki, GLOBAL_CONTEXT_ID, [
    { shape: `${GLOBAL_CONTEXT_PROFILE}/context-shape`, focus: [context], graphs: [GRAPHS.current] },
  ], { context, question: input.question });
  const manifest = prepareComponent(env.objectDirectory, context,
    { context, populationOwner: GLOBAL_RATING_POPULATION_OWNER, question: input.question, state: 'active',
      targetGrain: 'MainVersion', scaleMin: GLOBAL_RATING_SCALE.min, scaleMax: GLOBAL_RATING_SCALE.max,
      cadence: RATING_STANDING_CADENCE, populationPolicy: GLOBAL_RATING_POPULATION,
      aggregationPolicy: RATING_LATEST_MEAN_POLICY }, GLOBAL_CONTEXT_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Global rating context admission expired');
  const receipt = ratingContextReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  let updateError: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${globalContextPattern(context)} ;
          rv:question ${lit(input.question)}@en ; rv:head ${iri(revision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(context)} ;
          rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(GLOBAL_CONTEXT_PROFILE)} ; rv:shapeRevision ${iri(GLOBAL_CONTEXT_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:ratingContext ${iri(context)} ; rv:realm ${iri(GLOBAL_RATING_POPULATION_OWNER)} ;
          rv:ratingContextRevision ${iri(revision)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:RatingContextCreatedEvent ; rv:ordinal 0 ;
          rv:action "rating.context.create" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:realm ${iri(GLOBAL_RATING_POPULATION_OWNER)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(context)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') throw new InvalidRatingContextInput('Global rating context validation invalid');
  } catch (error) {
    if (error instanceof InvalidRatingContextInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readRatingContextReceipt(env, admission.id);
  if (committed) return checkedGlobalContextReceipt(committed, admission, digest);
  throw new PendingActivation(updateError
    ? 'Global rating context update outcome unknown' : 'Global rating context guard did not match');
}

export async function readGlobalRatingContext(env: WorkActivationEnvironment, context: string) {
  if (!nativeId.test(context)) throw new RatingObservationUnavailable('Global rating context is unavailable');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?question ?revision ?manifest WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${globalContextPattern(context)} ; rv:question ?question ; rv:head ?revision . }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RevisionAnchor ; rv:component ${iri(context)} ;
      rv:modelRevision ${iri(GLOBAL_CONTEXT_PROFILE)} ; rv:manifest ?manifest . }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.question || row.question['xml:lang'] !== 'en' || !row.revision || !row.manifest) {
    return null;
  }
  const state = readComponentState(env.objectDirectory, row.manifest.value, context, GLOBAL_CONTEXT_PROFILE);
  if (!isGlobalContextState(state, context, row.question.value)) {
    throw new RatingObservationUnavailable('Global rating context bytes differ');
  }
  return { context, question: row.question.value, contextRevision: row.revision.value };
}

export function globalRatingDigest(input: SetGlobalRatingInput): string {
  if (![input.context, input.work, input.mainVersion, input.actingSubject].every(value => nativeId.test(value))
    || (input.expectedRevisionHead !== null && !nativeId.test(input.expectedRevisionHead))
    || (input.value !== null && (!Number.isInteger(input.value)
      || input.value < GLOBAL_RATING_SCALE.min || input.value > GLOBAL_RATING_SCALE.max))
    || (input.value === null && input.expectedRevisionHead === null)) {
    throw new InvalidRatingObservationInput('invalid Global rating request');
  }
  return hash(JSON.stringify({ family: GLOBAL_OBSERVATION_ID, context: input.context, work: input.work,
    mainVersion: input.mainVersion, expectedRevisionHead: input.expectedRevisionHead,
    value: input.value, actingSubject: input.actingSubject }));
}

function matches(receipt: RatingObservationReceipt, admission: RegisteredAdmission, digest: string): boolean {
  return receipt.admissionId === admission.id && receipt.requestDigest === digest
    && receipt.authorityEpoch === admission.authorityEpoch && receipt.scope === admission.scope;
}

export function checkedGlobalRatingReceipt(receipt: RatingObservationReceipt, admission: RegisteredAdmission,
  input: SetGlobalRatingInput, digest: string): RatingObservationReceipt {
  if (!matches(receipt, admission, digest)) throw new IdempotencyConflict('Global rating receipt differs from admission');
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new StaleRatingObservation('Global rating revision is stale');
    throw new RatingObservationUnavailable('Global rating was cancelled');
  }
  if (receipt.realm !== GLOBAL_RATING_POPULATION_OWNER || receipt.context !== input.context
    || receipt.work !== input.work || receipt.mainVersion !== input.mainVersion
    || receipt.predecessor !== input.expectedRevisionHead || receipt.value !== input.value
    || receipt.slot !== standingRatingSlotIri(admission.principalId, input.context, input.mainVersion)) {
    throw new IdempotencyConflict('Global rating receipt targets another intent');
  }
  return receipt;
}

interface Dependencies {
  contextRevision: string; observation?: string; prior?: string;
  evaluatedAt?: string; originalSubmissionAt?: string;
}

async function readDependencies(env: WorkActivationEnvironment, input: SetGlobalRatingInput,
  slot: string): Promise<Dependencies> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?contextRevision ?contextManifest ?question ?observation ?prior ?evaluatedAt ?originalSubmissionAt WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${globalContextPattern(input.context)} ; rv:question ?question ; rv:head ?contextRevision .
      ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
      ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
    }
    GRAPH ${iri(GRAPHS.revisions)} { ?contextRevision a rv:RevisionAnchor ; rv:component ${iri(input.context)} ;
      rv:modelRevision ${iri(GLOBAL_CONTEXT_PROFILE)} ; rv:manifest ?contextManifest . }
    OPTIONAL {
      GRAPH ${iri(GRAPHS.current)} { ?observation a rv:GlobalRatingObservation ; rv:ratingSlot ${iri(slot)} ;
        rv:ratingContext ${iri(input.context)} ; rv:targetMainVersion ${iri(input.mainVersion)} ;
        rv:observationHead ?prior . }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?prior a rv:GlobalRatingObservationRevision, rv:RevisionAnchor ;
        rv:component ?observation ; rv:evaluatedAt ?evaluatedAt ; rv:originalSubmissionAt ?originalSubmissionAt . } }
    }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.contextRevision || !row.contextManifest || !row.question
    || (row.observation && (!row.prior || !row.evaluatedAt || !row.originalSubmissionAt))) {
    throw new RatingObservationUnavailable('Global rating Context, target or slot is unavailable');
  }
  try {
    const state = readComponentState(env.objectDirectory, row.contextManifest.value, input.context, GLOBAL_CONTEXT_PROFILE);
    if (!isGlobalContextState(state, input.context, row.question.value)) throw new Error('Global Context manifest differs');
  } catch { throw new RatingObservationUnavailable('Global Context manifest is unavailable'); }
  return { contextRevision: row.contextRevision.value, ...(row.observation ? {
    observation: row.observation.value, prior: row.prior!.value,
    evaluatedAt: canonicalRatingInstant(row.evaluatedAt!.value),
    originalSubmissionAt: canonicalRatingInstant(row.originalSubmissionAt!.value) } : {}) };
}

/** Terminal stale or cancelled receipt in the standing family; guarded by the slot's real head. */
async function sealTerminal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  slot: string, expectedHead: string | null): Promise<RatingObservationReceipt | null> {
  const receipt = standingRatingReceiptIri(admission.id);
  const suffix = hash(`${receipt}\0stale`);
  const staleGuard = expectedHead
    ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
         ?observation rv:ratingSlot ${iri(slot)} ; rv:observationHead ${iri(expectedHead)} . } }`
    : `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
         ?observation rv:ratingSlot ${iri(slot)} ; rv:observationHead ?prior . } }`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ; rv:reason rv:StaleHead ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        <urn:rezics:outbox:${suffix}> a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event <urn:rezics:event:${suffix}> .
        <urn:rezics:event:${suffix}> a rv:RatingObservationStaleEvent ;
          rv:ordinal 0 ; rv:action "rating.observation.set" ; rv:receipt ${iri(receipt)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      ${staleGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch { /* resolve ambiguous update through receipt */ }
  return readStandingRatingReceipt(env, admission.id);
}

/** Replace one Global Account-principal opinion by exact head; prior revisions stay immutable. */
export async function setGlobalRating(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: SetGlobalRatingInput): Promise<RatingObservationReceipt> {
  const digest = globalRatingDigest(input);
  if (admission.action !== 'rating.observation.set' || admission.scope !== `rating:observe:${input.context}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('Global rating admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, standingRatingReceiptIri(admission.id));
  const existing = await readStandingRatingReceipt(env, admission.id);
  if (existing) return checkedGlobalRatingReceipt(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Global rating admission expired');
  // Access's durable admission instant is the trusted clock the aggregate compares.
  if (!admission.registeredAt) throw new RatingObservationUnavailable('server admission time is missing');
  const now = canonicalRatingInstant(admission.registeredAt);
  const slot = standingRatingSlotIri(admission.principalId, input.context, input.mainVersion);
  const deps = await readDependencies(env, input, slot);
  if ((deps.prior ?? null) !== input.expectedRevisionHead) {
    const stale = await sealTerminal(env, admission, slot, input.expectedRevisionHead);
    if (stale) return checkedGlobalRatingReceipt(stale, admission, input, digest);
    throw new PendingActivation('stale Global rating was not sealed');
  }
  const observation = deps.observation ?? ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const evaluatedAt = deps.evaluatedAt ?? now;
  const originalSubmissionAt = deps.originalSubmissionAt ?? now;
  const prior = input.expectedRevisionHead;
  const availability = input.value === null ? 'Withdrawn' : 'Available';
  const graphs = [GRAPHS.current, GRAPHS.revisions];
  const validations = await profileValidations(env.fuseki, GLOBAL_OBSERVATION_ID,
    (['context', 'work', 'main', 'observation', 'revision'] as const).map(role => ({
      shape: `${GLOBAL_OBSERVATION_PROFILE}/${role}-shape`, graphs,
      focus: [{ context: input.context, work: input.work, main: input.mainVersion, observation, revision }[role]],
    })), { context: input.context, work: input.work, main: input.mainVersion, slot, observation, revision,
      availability: availability.toLowerCase(), ...(input.value === null ? {} : { value: String(input.value) }),
      ...(prior ? { predecessor: prior } : {}) });
  const manifest = prepareComponent(env.objectDirectory, observation,
    { observation, slot, context: input.context, contextRevision: deps.contextRevision,
      populationOwner: GLOBAL_RATING_POPULATION_OWNER, work: input.work, mainVersion: input.mainVersion,
      revision, predecessor: prior, availability: availability.toLowerCase(), value: input.value,
      evaluatedAt, submittedAt: now, originalSubmissionAt, revisedAt: now }, GLOBAL_OBSERVATION_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Global rating admission expired');
  const receipt = standingRatingReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  const headGuard = prior ? `GRAPH ${iri(GRAPHS.current)} {
      ${iri(observation)} a rv:GlobalRatingObservation ; rv:ratingSlot ${iri(slot)} ;
        rv:ratingContext ${iri(input.context)} ; rv:targetMainVersion ${iri(input.mainVersion)} ;
        rv:observationHead ${iri(prior)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(prior)} a rv:GlobalRatingObservationRevision,
        rv:RevisionAnchor ; rv:component ${iri(observation)} . }`
    : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?occupied rv:ratingSlot ${iri(slot)} . } }
       FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(observation)} ?p ?o } }`;
  let updateError: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${prior ? `GRAPH ${iri(GRAPHS.current)} { ${iri(observation)} rv:observationHead ${iri(prior)} }` : ''}
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(observation)} a rv:GlobalRatingObservation ; rv:ratingContext ${iri(input.context)} ;
          rv:targetMainVersion ${iri(input.mainVersion)} ; rv:ratingSlot ${iri(slot)} ;
          rv:observationHead ${iri(revision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:GlobalRatingObservationRevision, rv:RevisionAnchor ;
          rv:component ${iri(observation)} ; rv:observation ${iri(observation)} ;
          rv:operation ${iri(operation)} ; rv:ratingAvailability rv:${availability} ;
          ${input.value === null ? '' : `rv:ratingValue ${input.value} ;`}
          ${prior ? `rv:predecessor ${iri(prior)} ;` : ''}
          rv:evaluatedAt ${lit(evaluatedAt)}^^xsd:dateTime ; rv:submittedAt ${lit(now)}^^xsd:dateTime ;
          rv:originalSubmissionAt ${lit(originalSubmissionAt)}^^xsd:dateTime ;
          rv:revisedAt ${lit(now)}^^xsd:dateTime ;
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(GLOBAL_OBSERVATION_PROFILE)} ; rv:shapeRevision ${iri(GLOBAL_OBSERVATION_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:realm ${iri(GLOBAL_RATING_POPULATION_OWNER)} ; rv:ratingContext ${iri(input.context)} ;
          rv:contextRevision ${iri(deps.contextRevision)} ;
          rv:work ${iri(input.work)} ; rv:mainVersion ${iri(input.mainVersion)} ;
          rv:ratingSlot ${iri(slot)} ; rv:ratingObservation ${iri(observation)} ;
          rv:observationRevision ${iri(revision)} ; rv:ratingAvailability rv:${availability} ;
          ${input.value === null ? '' : `rv:ratingValue ${input.value} ;`}
          ${prior ? `rv:expectedHead ${iri(prior)} ;` : ''}
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:RatingObservationChangedEvent ; rv:ordinal 0 ;
          rv:action "rating.observation.set" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:ratingContext ${iri(input.context)} ;
          rv:ratingObservation ${iri(observation)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${globalContextPattern(input.context)} ; rv:head ${iri(deps.contextRevision)} .
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
      }
      ${headGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') throw new InvalidRatingObservationInput('Global rating validation invalid');
  } catch (error) {
    if (error instanceof InvalidRatingObservationInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readStandingRatingReceipt(env, admission.id);
  if (committed) return checkedGlobalRatingReceipt(committed, admission, input, digest);
  const stale = await sealTerminal(env, admission, slot, input.expectedRevisionHead);
  if (stale) return checkedGlobalRatingReceipt(stale, admission, input, digest);
  throw new PendingActivation(updateError
    ? 'Global rating update outcome unknown' : 'Global rating guard did not match');
}
