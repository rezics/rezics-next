import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { readComponentState } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  CancelledActivation, IdempotencyConflict, PendingActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { InvalidRatingContextInput, RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY,
  RATING_STANDING_CADENCE, RatingRealmUnavailable, ratingContextDigest, ratingContextReceiptIri, readRatingContextReceipt,
  sealRatingContextAdmission, type RatingContextReceipt } from './context.ts';
import { InvalidRatingObservationInput, RatingObservationUnavailable, StaleRatingObservation,
  canonicalRatingInstant, readStandingRatingReceipt, sameRatingInstant,
  sealRatingObservationTerminal, sealStandingRatingAdmission, standingRatingReceiptIri,
  type RatingObservationReceipt } from './observation.ts';

// An exact FixedRelease is its own target grain. Its Context, observation and
// revision carry release-only types, so MainVersion routes, bindings and
// populations never select them, and a release never counts toward its MainVersion.
export const RELEASE_CONTEXT_ID = 'realm-release-rating-context-v1';
export const RELEASE_OBSERVATION_ID = 'realm-release-rating-observation-v1';
export const RELEASE_CONTEXT_PROFILE = `https://rezics.com/definition/${RELEASE_CONTEXT_ID}`;
export const RELEASE_OBSERVATION_PROFILE = `https://rezics.com/definition/${RELEASE_OBSERVATION_ID}`;
export const FIXED_RELEASE_PROFILE = 'https://rezics.com/definition/fixed-native-text-release-v1';
/** One exact-key owner admission, at most a bounded handful of graph reads and one native command. */
export const RELEASE_RATING_WRITE_COST = { graphCalls: 16, graphBytes: 262_144,
  commandDeadlineMs: 10_000 } as const;

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f-]{36}$/;

/** The request names a target of another grain than its Context fixes. */
export class RatingTargetGrainMismatch extends Error {}

/** Failure-path classification only: one exact-key read of the Context's fixed grain. */
export async function ratingContextGrain(env: WorkActivationEnvironment,
  context: string): Promise<'MainVersion' | 'FixedRelease' | 'Release' | 'Realization' | 'Occurrence' | 'Resource' | null> {
  if (!nativeId.test(context)) return null;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?grain WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(context)} rv:targetGrain ?grain } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const grain = rows.length === 1 ? rows[0]?.grain?.value : undefined;
  const grains = ['MainVersion', 'FixedRelease', 'Release', 'Realization', 'Occurrence', 'Resource'] as const;
  return grains.find(value => grain === `${RV}${value}`) ?? null;
}

/** Rethrows `error` as a grain mismatch when the Context fixes the other grain. */
export async function classifyRatingGrain(env: WorkActivationEnvironment, context: string,
  expected: 'MainVersion' | 'FixedRelease', error: unknown): Promise<never> {
  let grain: Awaited<ReturnType<typeof ratingContextGrain>> = null;
  try { grain = await ratingContextGrain(env, context); } catch { /* keep the original outcome */ }
  if (grain && grain !== expected) {
    throw new RatingTargetGrainMismatch(`Rating Context fixes the ${grain} grain`);
  }
  throw error;
}

export interface CreateReleaseRatingContextInput {
  realm: string;
  question: string;
  actingSubject: string;
}

export function releaseRatingContextDigest(input: CreateReleaseRatingContextInput): string {
  // Shares the standing request validation; the digest family keeps the grain distinct.
  ratingContextDigest({ realm: input.realm, question: input.question, actingSubject: input.actingSubject });
  return hash(JSON.stringify({ family: RELEASE_CONTEXT_ID,
    realm: input.realm, question: input.question, actingSubject: input.actingSubject,
    targetGrain: 'FixedRelease', scale: [1, 10], cadence: RATING_STANDING_CADENCE,
    population: RATING_ACCOUNT_POPULATION, aggregation: RATING_LATEST_MEAN_POLICY }));
}

function checkedContext(receipt: RatingContextReceipt, admission: RegisteredAdmission,
  input: CreateReleaseRatingContextInput, digest: string): RatingContextReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== digest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('release rating context admission differs from receipt');
  }
  if (receipt.outcome === 'cancelled') throw new CancelledActivation('release rating context creation was cancelled');
  if (receipt.realm !== input.realm) throw new IdempotencyConflict('rating Realm differs');
  return receipt;
}

export async function createReleaseRatingContext(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: CreateReleaseRatingContextInput,
): Promise<RatingContextReceipt> {
  const digest = releaseRatingContextDigest(input);
  if (admission.action !== 'rating.context.create'
    || admission.scope !== `rating:context:${input.realm}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('release rating context admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, ratingContextReceiptIri(admission.id));
  const existing = await readRatingContextReceipt(env, admission.id);
  if (existing) return checkedContext(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('release rating context admission expired');
  }
  const realmCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rv:realmCapability ${iri(input.realm)} ; rv:disclosure rv:Public .
      ${iri(input.realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
    }
  }`);
  if (realmCheck.boolean !== true) throw new RatingRealmUnavailable('Realm is unavailable');
  const context = ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await releaseContextValidations(env, input.realm, context, input.question);
  const manifest = prepareComponent(env.objectDirectory, context,
    { context, realm: input.realm, question: input.question, state: 'active',
      targetGrain: 'FixedRelease', scaleMin: 1, scaleMax: 10, cadence: RATING_STANDING_CADENCE,
      populationPolicy: RATING_ACCOUNT_POPULATION, aggregationPolicy: RATING_LATEST_MEAN_POLICY },
    RELEASE_CONTEXT_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('release rating context admission expired');
  }
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
      ${releaseContextTriples({ realm: input.realm, context, revision, operation,
        question: input.question, manifest: `urn:rezics:sha256:${manifest}`, receipt, digest,
        admission, batch, event, dataEpoch: env.lineage.dataEpoch, sequence: '?next' })}
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(input.realm)} ; rv:disclosure rv:Public .
        ${iri(input.realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(context)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') {
      throw new InvalidRatingContextInput(`Release rating context validation ${result.status}`);
    }
  } catch (error) {
    if (error instanceof InvalidRatingContextInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readRatingContextReceipt(env, admission.id);
  if (committed) return checkedContext(committed, admission, input, digest);
  throw new PendingActivation(updateError
    ? 'release rating context update outcome unknown' : 'release rating context guard did not match');
}

export function releaseContextValidations(env: WorkActivationEnvironment, realm: string,
  context: string, question: string): Promise<CommandValidation[]> {
  iri(realm); iri(context);
  return profileValidations(env.fuseki, RELEASE_CONTEXT_ID, [
    { shape: `${RELEASE_CONTEXT_PROFILE}/realm-shape`, focus: [realm], graphs: [GRAPHS.current] },
    { shape: `${RELEASE_CONTEXT_PROFILE}/context-shape`, focus: [context], graphs: [GRAPHS.current] },
  ], { realm, context, question });
}

/** INSERT graph blocks shared by live creation and retained replay; callers add control and guard. */
export function releaseContextTriples(value: { realm: string; context: string; revision: string;
  operation: string; question: string; manifest: string; receipt: string; digest: string;
  admission: Pick<RegisteredAdmission, 'id' | 'authorityEpoch' | 'scope'>; batch: string; event: string;
  dataEpoch: string; sequence: string }): string {
  const next = value.sequence;
  return `GRAPH ${iri(GRAPHS.current)} {
        ${iri(value.realm)} rv:ratingContext ${iri(value.context)} .
        ${iri(value.context)} a rv:ReleaseRatingContext ; rv:contextState rv:Active ;
          rv:realm ${iri(value.realm)} ; rv:question ${lit(value.question)}@en ;
          rv:targetGrain rv:FixedRelease ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
          rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
          rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
          rv:head ${iri(value.revision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(value.revision)} a rv:RevisionAnchor ; rv:component ${iri(value.context)} ;
          rv:operation ${iri(value.operation)} ; rv:manifest ${iri(value.manifest)} ;
          rv:modelRevision ${iri(RELEASE_CONTEXT_PROFILE)} ;
          rv:shapeRevision ${iri(RELEASE_CONTEXT_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(value.dataEpoch)} ;
          rv:sequence ${next} .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(value.receipt)} a rv:OperationReceipt ; rv:operation ${iri(value.operation)} ;
          rv:requestDigest ${lit(value.digest)} ; rv:admissionId ${lit(value.admission.id)} ;
          rv:authorityEpoch ${lit(value.admission.authorityEpoch)} ;
          rv:admittedScope ${lit(value.admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:ratingContext ${iri(value.context)} ; rv:realm ${iri(value.realm)} ;
          rv:ratingContextRevision ${iri(value.revision)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(value.dataEpoch)} ; rv:sequence ${next} .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(value.batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(value.dataEpoch)} ;
          rv:sequence ${next} ; rv:eventCount 1 ; rv:event ${iri(value.event)} .
        ${iri(value.event)} a rv:RatingContextCreatedEvent ; rv:ordinal 0 ;
          rv:action "rating.context.create" ; rv:receipt ${iri(value.receipt)} ;
          rv:operation ${iri(value.operation)} ; rv:realm ${iri(value.realm)} .
      }`;
}

export async function createAdmittedReleaseRatingContext(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: CreateReleaseRatingContextInput & { idempotencyKey: string },
): Promise<RatingContextReceipt & { replayed: boolean }> {
  const digest = releaseRatingContextDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['rating:configure']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `rating:context:${input.realm}`, action: 'rating.context.create',
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealRatingContextAdmission(env, admission);
      } else {
        try { await createReleaseRatingContext(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof RatingRealmUnavailable) await sealRatingContextAdmission(env, admission);
        }
      }
    }
    const terminal = await readRatingContextReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'rating-context');
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...checkedContext(terminal, registered, input, digest), replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof CancelledActivation) throw error;
    throw new PendingAdmittedWork(registered.id, 'rating-context');
  }
}

export interface SetReleaseRatingInput {
  context: string;
  work: string;
  mainVersion: string;
  release: string;
  expectedRevisionHead: string | null;
  value: number | null;
  actingSubject: string;
}

export function releaseRatingDigest(input: SetReleaseRatingInput): string {
  if (![input.context, input.work, input.mainVersion, input.release, input.actingSubject]
    .every(value => nativeId.test(value))
    || new Set([input.work, input.mainVersion, input.release]).size !== 3
    || (input.expectedRevisionHead !== null && !nativeId.test(input.expectedRevisionHead))
    || (input.value !== null && (!Number.isInteger(input.value) || input.value < 1 || input.value > 10))
    || (input.value === null && input.expectedRevisionHead === null)) {
    throw new InvalidRatingObservationInput('invalid release rating request');
  }
  return hash(JSON.stringify({ family: RELEASE_OBSERVATION_ID, context: input.context,
    work: input.work, mainVersion: input.mainVersion, release: input.release,
    expectedRevisionHead: input.expectedRevisionHead, value: input.value,
    actingSubject: input.actingSubject }));
}

/** Access owns the counting identity; the slot keys principal, Context, exact release and cadence. */
export function releaseRatingSlotIri(principalId: string, context: string, release: string): string {
  if (!uuid.test(principalId) || !nativeId.test(context) || !nativeId.test(release)) {
    throw new InvalidRatingObservationInput('invalid release rating slot');
  }
  return `urn:rezics:rating-slot:${hash(JSON.stringify({ principalId, context, release,
    targetGrain: 'FixedRelease', cadence: RATING_STANDING_CADENCE }))}`;
}

export function checkedReleaseRatingReceipt(receipt: RatingObservationReceipt,
  admission: RegisteredAdmission, input: SetReleaseRatingInput, digest: string): RatingObservationReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== digest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('release rating receipt differs from admission');
  }
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new StaleRatingObservation('release rating revision is stale');
    throw new RatingObservationUnavailable('release rating was cancelled');
  }
  if (receipt.context !== input.context || receipt.work !== input.work
    || receipt.mainVersion !== input.mainVersion || receipt.release !== input.release
    || receipt.predecessor !== input.expectedRevisionHead || receipt.value !== input.value
    || receipt.slot !== releaseRatingSlotIri(admission.principalId, input.context, input.release)) {
    throw new IdempotencyConflict('release rating receipt targets another intent');
  }
  return receipt;
}

interface Dependencies {
  realm: string;
  contextRevision: string;
  observation?: string;
  prior?: string;
  evaluatedAt?: string;
  originalSubmissionAt?: string;
}

/**
 * Pins one active release Context and one sealed release of the named Work. Every
 * argument is a SPARQL term: an `iri()` result or a variable.
 */
export function releaseTargetPattern(term: { realm: string; context: string; work: string;
  main: string; release: string; contextRevision: string }): string {
  const { realm, context, work, main, release, contextRevision } = term;
  return `GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rv:realmCapability ${realm} ; rv:disclosure rv:Public .
      ${realm} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ; rv:ratingContext ${context} .
      ${context} a rv:ReleaseRatingContext ; rv:contextState rv:Active ;
        rv:realm ${realm} ; rv:targetGrain rv:FixedRelease ; rv:ratingScaleMin 1 ;
        rv:ratingScaleMax 10 ; rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
        rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
        rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ; rv:head ${contextRevision} .
      ${work} a schema:CreativeWork ; rv:mainVersion ${main} .
      ${main} a rv:MainVersion ; rv:work ${work} .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${release} a rv:FixedRelease ; rv:work ${work} ;
        rv:mainVersion ${main} ; rv:modelRevision ${iri(FIXED_RELEASE_PROFILE)} .
    }`;
}

async function readDependencies(env: WorkActivationEnvironment, input: SetReleaseRatingInput,
  slot: string): Promise<Dependencies> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?realm ?contextRevision ?observation ?prior ?evaluatedAt ?originalSubmissionAt WHERE {
    ${releaseTargetPattern({ realm: '?realm', context: iri(input.context), work: iri(input.work),
      main: iri(input.mainVersion), release: iri(input.release), contextRevision: '?contextRevision' })}
    GRAPH ${iri(GRAPHS.revisions)} {
      ?contextRevision a rv:RevisionAnchor ; rv:component ${iri(input.context)} ;
        rv:modelRevision ${iri(RELEASE_CONTEXT_PROFILE)} . }
    OPTIONAL {
      GRAPH ${iri(GRAPHS.current)} { ?observation a rv:ReleaseRatingObservation ;
        rv:ratingSlot ${iri(slot)} ; rv:ratingContext ${iri(input.context)} ;
        rv:targetRelease ${iri(input.release)} ; rv:observationHead ?prior . }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?prior
        a rv:ReleaseRatingObservationRevision, rv:RevisionAnchor ; rv:component ?observation ;
        rv:evaluatedAt ?evaluatedAt ; rv:originalSubmissionAt ?originalSubmissionAt . } }
    }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.realm || !row.contextRevision
    || (row.observation && (!row.prior || !row.evaluatedAt || !row.originalSubmissionAt))) {
    throw new RatingObservationUnavailable('release rating Context, target or slot is unavailable');
  }
  return { realm: row.realm.value, contextRevision: row.contextRevision.value,
    ...(row.observation ? { observation: row.observation.value, prior: row.prior!.value,
      evaluatedAt: canonicalRatingInstant(row.evaluatedAt!.value),
      originalSubmissionAt: canonicalRatingInstant(row.originalSubmissionAt!.value) } : {}) };
}

export interface ReleaseObservationBinding {
  realm: string; context: string; work: string; mainVersion: string; release: string;
  slot: string; observation: string; revision: string;
  availability: 'available' | 'withdrawn'; value: number | null; predecessor: string | null;
}

export function releaseObservationValidations(env: WorkActivationEnvironment,
  value: ReleaseObservationBinding): Promise<CommandValidation[]> {
  for (const term of [value.realm, value.context, value.work, value.mainVersion, value.release,
    value.slot, value.observation, value.revision]) iri(term);
  const graphs = [GRAPHS.current, GRAPHS.revisions];
  const shape = (role: string) => `${RELEASE_OBSERVATION_PROFILE}/${role}-shape`;
  return profileValidations(env.fuseki, RELEASE_OBSERVATION_ID, [
    { shape: shape('realm'), focus: [value.realm], graphs },
    { shape: shape('context'), focus: [value.context], graphs },
    { shape: shape('work'), focus: [value.work], graphs },
    { shape: shape('main'), focus: [value.mainVersion], graphs },
    { shape: shape('release'), focus: [value.release], graphs },
    { shape: shape('observation'), focus: [value.observation], graphs },
    { shape: shape('revision'), focus: [value.revision], graphs },
  ], { realm: value.realm, context: value.context, work: value.work, main: value.mainVersion,
    release: value.release, slot: value.slot, observation: value.observation, revision: value.revision,
    availability: value.availability,
    ...(value.value === null ? {} : { value: String(value.value) }),
    ...(value.predecessor ? { predecessor: value.predecessor } : {}) });
}

/** INSERT triples of one release opinion revision; the observation keeps no MainVersion target. */
export function releaseObservationTriples(value: ReleaseObservationBinding & { operation: string;
  contextRevision: string; manifest: string; receipt: string; digest: string;
  admission: Pick<RegisteredAdmission, 'id' | 'authorityEpoch' | 'scope'>;
  batch: string; event: string; dataEpoch: string; sequence: string;
  times: { evaluatedAt: string; submittedAt: string; originalSubmissionAt: string; revisedAt: string } }): string {
  const availability = value.availability === 'available' ? 'Available' : 'Withdrawn';
  const rated = value.value === null ? '' : `rv:ratingValue ${value.value} ;`;
  return `GRAPH ${iri(GRAPHS.current)} {
        ${iri(value.observation)} a rv:ReleaseRatingObservation ;
          rv:ratingContext ${iri(value.context)} ; rv:targetRelease ${iri(value.release)} ;
          rv:ratingSlot ${iri(value.slot)} ; rv:observationHead ${iri(value.revision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(value.revision)} a rv:ReleaseRatingObservationRevision, rv:RevisionAnchor ;
          rv:component ${iri(value.observation)} ; rv:observation ${iri(value.observation)} ;
          rv:operation ${iri(value.operation)} ; rv:ratingAvailability rv:${availability} ; ${rated}
          ${value.predecessor ? `rv:predecessor ${iri(value.predecessor)} ;` : ''}
          rv:evaluatedAt ${lit(value.times.evaluatedAt)}^^xsd:dateTime ;
          rv:submittedAt ${lit(value.times.submittedAt)}^^xsd:dateTime ;
          rv:originalSubmissionAt ${lit(value.times.originalSubmissionAt)}^^xsd:dateTime ;
          rv:revisedAt ${lit(value.times.revisedAt)}^^xsd:dateTime ;
          rv:manifest ${iri(value.manifest)} ;
          rv:modelRevision ${iri(RELEASE_OBSERVATION_PROFILE)} ;
          rv:shapeRevision ${iri(RELEASE_OBSERVATION_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(value.dataEpoch)} ;
          rv:sequence ${value.sequence} .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(value.receipt)} a rv:OperationReceipt ; rv:operation ${iri(value.operation)} ;
          rv:requestDigest ${lit(value.digest)} ; rv:admissionId ${lit(value.admission.id)} ;
          rv:authorityEpoch ${lit(value.admission.authorityEpoch)} ;
          rv:admittedScope ${lit(value.admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:realm ${iri(value.realm)} ; rv:ratingContext ${iri(value.context)} ;
          rv:contextRevision ${iri(value.contextRevision)} ;
          rv:work ${iri(value.work)} ; rv:mainVersion ${iri(value.mainVersion)} ;
          rv:targetRelease ${iri(value.release)} ;
          rv:ratingSlot ${iri(value.slot)} ; rv:ratingObservation ${iri(value.observation)} ;
          rv:observationRevision ${iri(value.revision)} ;
          rv:ratingAvailability rv:${availability} ; ${rated}
          ${value.predecessor ? `rv:expectedHead ${iri(value.predecessor)} ;` : ''}
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(value.dataEpoch)} ;
          rv:sequence ${value.sequence} .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(value.batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(value.dataEpoch)} ;
          rv:sequence ${value.sequence} ; rv:eventCount 1 ; rv:event ${iri(value.event)} .
        ${iri(value.event)} a rv:RatingObservationChangedEvent ; rv:ordinal 0 ;
          rv:action "rating.observation.set" ; rv:receipt ${iri(value.receipt)} ;
          rv:operation ${iri(value.operation)} ; rv:ratingContext ${iri(value.context)} ;
          rv:ratingObservation ${iri(value.observation)} .
      }`;
}

/** Exact-head guard for one release slot; the first revision requires an empty slot. */
export function releaseHeadGuard(value: { observation: string; slot: string; context: string;
  release: string; predecessor: string | null }, times?: { evaluatedAt: string; originalSubmissionAt: string }): string {
  return value.predecessor ? `GRAPH ${iri(GRAPHS.current)} {
      ${iri(value.observation)} a rv:ReleaseRatingObservation ; rv:ratingSlot ${iri(value.slot)} ;
        rv:ratingContext ${iri(value.context)} ; rv:targetRelease ${iri(value.release)} ;
        rv:observationHead ${iri(value.predecessor)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(value.predecessor)} a rv:ReleaseRatingObservationRevision,
        rv:RevisionAnchor ; rv:component ${iri(value.observation)}
        ${times ? `; rv:evaluatedAt ${lit(times.evaluatedAt)}^^xsd:dateTime ;
          rv:originalSubmissionAt ${lit(times.originalSubmissionAt)}^^xsd:dateTime` : ''} . }`
    : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
         ?occupied rv:ratingSlot ${iri(value.slot)} . } }
       FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(value.observation)} ?p ?o } }`;
}

/** Replace one Account-principal opinion of one exact release by exact head. */
export async function setReleaseRating(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: SetReleaseRatingInput): Promise<RatingObservationReceipt> {
  const digest = releaseRatingDigest(input);
  if (admission.action !== 'rating.observation.set'
    || admission.scope !== `rating:observe:${input.context}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('release rating admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, standingRatingReceiptIri(admission.id));
  const existing = await readStandingRatingReceipt(env, admission.id);
  if (existing) return checkedReleaseRatingReceipt(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('release rating admission expired');
  }
  const slot = releaseRatingSlotIri(admission.principalId, input.context, input.release);
  const deps = await readDependencies(env, input, slot);
  if ((deps.prior ?? null) !== input.expectedRevisionHead) {
    const stale = await sealRatingObservationTerminal(env, admission, 'stale-head', slot,
      input.expectedRevisionHead);
    if (stale) return checkedReleaseRatingReceipt(stale, admission, input, digest);
    throw new PendingActivation('stale release rating was not sealed');
  }
  const observation = deps.observation ?? ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  if (!admission.registeredAt) {
    throw new RatingObservationUnavailable('server admission time is missing');
  }
  const now = admission.registeredAt;
  const times = { evaluatedAt: deps.evaluatedAt ?? now, submittedAt: now,
    originalSubmissionAt: deps.originalSubmissionAt ?? now, revisedAt: now };
  const binding: ReleaseObservationBinding = { realm: deps.realm, context: input.context,
    work: input.work, mainVersion: input.mainVersion, release: input.release, slot, observation,
    revision, availability: input.value === null ? 'withdrawn' : 'available', value: input.value,
    predecessor: input.expectedRevisionHead };
  const validations = await releaseObservationValidations(env, binding);
  const manifest = prepareComponent(env.objectDirectory, observation,
    { observation, slot, context: input.context, contextRevision: deps.contextRevision,
      realm: deps.realm, work: input.work, mainVersion: input.mainVersion, release: input.release,
      revision, predecessor: input.expectedRevisionHead, availability: binding.availability,
      value: input.value, ...times }, RELEASE_OBSERVATION_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('release rating admission expired');
  }
  const receipt = standingRatingReceiptIri(admission.id);
  const prior = input.expectedRevisionHead;
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
      ${releaseObservationTriples({ ...binding, operation, contextRevision: deps.contextRevision,
        manifest: `urn:rezics:sha256:${manifest}`, receipt, digest, admission,
        batch: `urn:rezics:outbox:${hash(receipt)}`, event: `urn:rezics:event:${hash(operation)}`,
        dataEpoch: env.lineage.dataEpoch, sequence: '?next', times })}
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      ${releaseTargetPattern({ realm: iri(deps.realm), context: iri(input.context), work: iri(input.work),
        main: iri(input.mainVersion), release: iri(input.release), contextRevision: iri(deps.contextRevision) })}
      ${releaseHeadGuard({ observation, slot, context: input.context, release: input.release,
        predecessor: prior })}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') {
      throw new InvalidRatingObservationInput(`Release rating validation ${result.status}`);
    }
  } catch (error) {
    if (error instanceof InvalidRatingObservationInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readStandingRatingReceipt(env, admission.id);
  if (committed) return checkedReleaseRatingReceipt(committed, admission, input, digest);
  const stale = await sealRatingObservationTerminal(env, admission, 'stale-head', slot, prior);
  if (stale) return checkedReleaseRatingReceipt(stale, admission, input, digest);
  throw new PendingActivation(updateError
    ? 'release rating update outcome unknown' : 'release rating guard did not match');
}

export async function setAdmittedReleaseRating(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: SetReleaseRatingInput & { idempotencyKey: string },
): Promise<RatingObservationReceipt & { replayed: boolean }> {
  const digest = releaseRatingDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['rating:submit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `rating:observe:${input.context}`, action: 'rating.observation.set',
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealStandingRatingAdmission(env, admission);
      } else {
        try { await setReleaseRating(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof RatingObservationUnavailable) await sealStandingRatingAdmission(env, admission);
        }
      }
    }
    const terminal = await readStandingRatingReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'rating-observation');
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...checkedReleaseRatingReceipt(terminal, registered, input, digest),
      replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleRatingObservation
      || error instanceof RatingObservationUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'rating-observation');
  }
}

export interface ReleaseRatingRevision {
  observation: string; observationRevision: string; context: string; work: string;
  mainVersion: string; release: string; predecessor: string | null;
  availability: 'available' | 'withdrawn'; value: number | null;
  evaluatedAt: string; submittedAt: string; originalSubmissionAt: string; revisedAt: string;
  profile: typeof RELEASE_OBSERVATION_ID;
}

/** Reads one of the caller's own immutable revisions; the slot binds the private principal. */
export async function readReleaseRatingRevision(env: WorkActivationEnvironment, principalId: string,
  query: { observation: string; revision: string; context: string; release: string },
): Promise<ReleaseRatingRevision | null> {
  const slot = releaseRatingSlotIri(principalId, query.context, query.release);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?manifest ?realm ?work ?main ?availability ?value ?predecessor
      ?evaluatedAt ?submittedAt ?originalSubmissionAt ?revisedAt WHERE {
      ${releaseTargetPattern({ realm: '?realm', context: iri(query.context), work: '?work', main: '?main',
        release: iri(query.release), contextRevision: '?contextRevision' })}
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(query.observation)} a rv:ReleaseRatingObservation ; rv:ratingSlot ${iri(slot)} ;
          rv:ratingContext ${iri(query.context)} ; rv:targetRelease ${iri(query.release)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(query.revision)}
        a rv:ReleaseRatingObservationRevision, rv:RevisionAnchor ;
        rv:component ${iri(query.observation)} ; rv:observation ${iri(query.observation)} ;
        rv:modelRevision ${iri(RELEASE_OBSERVATION_PROFILE)} ;
        rv:manifest ?manifest ; rv:ratingAvailability ?availability ;
        rv:evaluatedAt ?evaluatedAt ; rv:submittedAt ?submittedAt ;
        rv:originalSubmissionAt ?originalSubmissionAt ; rv:revisedAt ?revisedAt .
        OPTIONAL { ${iri(query.revision)} rv:ratingValue ?value }
        OPTIONAL { ${iri(query.revision)} rv:predecessor ?predecessor }
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.manifest || !row.realm || !row.work || !row.main
    || !row.availability || !row.evaluatedAt || !row.submittedAt
    || !row.originalSubmissionAt || !row.revisedAt) return null;
  const state = readComponentState(env.objectDirectory, row.manifest.value,
    query.observation, RELEASE_OBSERVATION_PROFILE);
  const availability = state.availability === 'available' ? 'available'
    : state.availability === 'withdrawn' ? 'withdrawn' : null;
  if (state.observation !== query.observation || state.revision !== query.revision
    || state.slot !== slot || state.context !== query.context || state.release !== query.release
    || state.realm !== row.realm.value || state.work !== row.work.value
    || state.mainVersion !== row.main.value || !availability
    || row.availability.value !== `${RV}${availability === 'available' ? 'Available' : 'Withdrawn'}`
    || state.predecessor !== (row.predecessor?.value ?? null)
    || !sameRatingInstant(state.evaluatedAt, row.evaluatedAt.value)
    || !sameRatingInstant(state.submittedAt, row.submittedAt.value)
    || !sameRatingInstant(state.originalSubmissionAt, row.originalSubmissionAt.value)
    || !sameRatingInstant(state.revisedAt, row.revisedAt.value)
    || (availability === 'available' && (!Number.isInteger(state.value)
      || Number(state.value) < 1 || Number(state.value) > 10 || Number(row.value?.value) !== state.value))
    || (availability === 'withdrawn' && (state.value !== null || row.value))) {
    throw new RatingObservationUnavailable('release rating revision bytes differ');
  }
  return { observation: query.observation, observationRevision: query.revision,
    context: query.context, work: state.work as string, mainVersion: state.mainVersion as string,
    release: query.release, predecessor: state.predecessor as string | null, availability,
    value: state.value as number | null, evaluatedAt: state.evaluatedAt as string,
    submittedAt: state.submittedAt as string, originalSubmissionAt: state.originalSubmissionAt as string,
    revisedAt: state.revisedAt as string, profile: RELEASE_OBSERVATION_ID };
}

export interface ReleaseRatingContext {
  context: string; realm: string; question: string; contextRevision: string;
  targetGrain: 'fixedRelease'; scale: { min: 1; max: 10; step: 1 }; cadence: 'standing';
  population: 'account-principal'; aggregation: 'latest-per-rater-mean';
  profile: typeof RELEASE_CONTEXT_ID;
}

/** Public Context read; the immutable manifest must match the current graph. */
export async function readReleaseRatingContext(env: WorkActivationEnvironment,
  context: string): Promise<ReleaseRatingContext | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?realm ?question ?revision ?manifest WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ; rv:ratingContext ${iri(context)} .
      ${iri(context)} a rv:ReleaseRatingContext ; rv:contextState rv:Active ;
        rv:realm ?realm ; rv:question ?question ; rv:targetGrain rv:FixedRelease ;
        rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
        rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
        rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ; rv:head ?revision .
    }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RevisionAnchor ; rv:component ${iri(context)} ;
      rv:modelRevision ${iri(RELEASE_CONTEXT_PROFILE)} ; rv:manifest ?manifest . }
    FILTER(LANG(?question) = "en")
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.realm || !row.question || !row.revision || !row.manifest) return null;
  const state = readComponentState(env.objectDirectory, row.manifest.value, context, RELEASE_CONTEXT_PROFILE);
  if (state.context !== context || state.realm !== row.realm.value || state.question !== row.question.value
    || state.state !== 'active' || state.targetGrain !== 'FixedRelease'
    || state.scaleMin !== 1 || state.scaleMax !== 10 || state.cadence !== RATING_STANDING_CADENCE
    || state.populationPolicy !== RATING_ACCOUNT_POPULATION
    || state.aggregationPolicy !== RATING_LATEST_MEAN_POLICY) {
    throw new RatingObservationUnavailable('release rating Context bytes differ');
  }
  return { context, realm: row.realm.value, question: row.question.value,
    contextRevision: row.revision.value, targetGrain: 'fixedRelease',
    scale: { min: 1, max: 10, step: 1 }, cadence: 'standing', population: 'account-principal',
    aggregation: 'latest-per-rater-mean', profile: RELEASE_CONTEXT_ID };
}
