import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry, type RegisteredAdmission }
  from '../access/admission.ts';
import { resolveTargets, type TargetReadSession } from '../target/resolve.ts';
import type { Base, ResolvedTarget } from '../target/contract.ts';
import { readComponentState } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent, CancelledActivation,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY, RATING_STANDING_CADENCE,
  ratingContextDigest, ratingContextReceiptIri, readRatingContextReceipt, sealRatingContextAdmission,
  RatingRealmUnavailable, type RatingContextReceipt } from './context.ts';
import { canonicalRatingInstant, sameRatingInstant, InvalidRatingObservationInput, RatingObservationUnavailable,
  StaleRatingObservation, sealStandingRatingAdmission, sealRatingObservationTerminal,
  standingRatingReceiptIri, type RatingObservationReceipt } from './observation.ts';
import { RatingTargetGrainMismatch } from './release.ts';

export const TARGET_CONTEXT_ID = 'realm-target-rating-context-v1';
export const TARGET_OBSERVATION_ID = 'realm-target-rating-observation-v1';
export const TARGET_CONTEXT_PROFILE = `https://rezics.com/definition/${TARGET_CONTEXT_ID}`;
export const TARGET_OBSERVATION_PROFILE = `https://rezics.com/definition/${TARGET_OBSERVATION_ID}`;
export const TARGET_GRAINS = { release: 'Release', realization: 'Realization', occurrence: 'Occurrence',
  resource: 'Resource' } as const;
export type TargetGrain = keyof typeof TARGET_GRAINS;
export const TARGET_RATING_WRITE_COST = { graphCalls: 24, graphBytes: 524_288, commandDeadlineMs: 10_000 } as const;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface TargetContextInput { realm: string; question: string; targetGrain: TargetGrain; actingSubject: string }
export interface TargetRatingInput { context: string; target: string; expectedRevisionHead: string | null;
  value: number | null; actingSubject: string }
export interface TargetRatingReceipt extends RatingObservationReceipt { target?: string }

export function targetContextDigest(input: TargetContextInput): string {
  ratingContextDigest(input);
  if (!Object.hasOwn(TARGET_GRAINS, input.targetGrain)) throw new InvalidRatingObservationInput('Invalid grain');
  return hash(JSON.stringify({ family: TARGET_CONTEXT_ID, realm: input.realm, question: input.question,
    targetGrain: input.targetGrain, actingSubject: input.actingSubject }));
}
export function targetRatingDigest(input: TargetRatingInput): string {
  if (![input.context, input.target, input.actingSubject].every(value => nativeId.test(value))
    || input.expectedRevisionHead !== null && !nativeId.test(input.expectedRevisionHead)
    || input.value !== null && (!Number.isInteger(input.value) || input.value < 1 || input.value > 10)
    || input.value === null && input.expectedRevisionHead === null) {
    throw new InvalidRatingObservationInput('Invalid target rating');
  }
  return hash(JSON.stringify({ family: TARGET_OBSERVATION_ID, context: input.context, target: input.target,
    expectedRevisionHead: input.expectedRevisionHead, value: input.value, actingSubject: input.actingSubject }));
}
export function targetRatingSlotIri(principalId: string, context: string, target: string): string {
  if (!/^[0-9a-f-]{36}$/.test(principalId) || ![context, target].every(value => nativeId.test(value))) {
    throw new InvalidRatingObservationInput('Invalid target slot');
  }
  return `urn:rezics:rating-slot:${hash(JSON.stringify({ family: TARGET_OBSERVATION_ID,
    principalId, context, target, cadence: RATING_STANDING_CADENCE }))}`;
}

export function targetContextPattern(context: string, realm = '?realm', revision = '?contextRevision'): string {
  return `GRAPH ${iri(GRAPHS.current)} {
    ?space a rv:Space ; rv:realmCapability ${realm} ; rv:disclosure rv:Public .
    FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
    ${realm} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ; rv:ratingContext ${iri(context)} .
    FILTER NOT EXISTS { ${realm} rv:protectionHead ?realmProtection }
    ${iri(context)} a rv:TargetRatingContext ; rv:contextState rv:Active ; rv:realm ${realm} ;
      rv:targetGrain ?grain ; rv:question ?question ; rv:head ${revision} ;
      rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
      rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
      rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} .
    VALUES ?grain { rv:Release rv:Realization rv:Occurrence rv:Resource }
    FILTER NOT EXISTS { ${iri(context)} rv:protectionHead ?contextProtection }
  }`;
}
export async function readTargetRatingContext(env: WorkActivationEnvironment, context: string) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?realm ?question ?grain ?contextRevision ?manifest WHERE {
    ${targetContextPattern(context)}
    GRAPH ${iri(GRAPHS.revisions)} { ?contextRevision a rv:RevisionAnchor ; rv:component ${iri(context)} ;
      rv:modelRevision ${iri(TARGET_CONTEXT_PROFILE)} ; rv:manifest ?manifest .
      FILTER NOT EXISTS { ?contextRevision a rv:ErasedRevision } }
  } LIMIT 2`)).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.realm || !row.question || !row.grain || !row.contextRevision || !row.manifest) {
    throw new RatingObservationUnavailable('Target Context is ambiguous');
  }
  const grain = Object.entries(TARGET_GRAINS).find(([, value]) => `${RV}${value}` === row.grain!.value)?.[0] as TargetGrain | undefined;
  const state = readComponentState(env.objectDirectory, row.manifest.value, context, TARGET_CONTEXT_PROFILE);
  if (!grain || state.context !== context || state.realm !== row.realm.value || state.question !== row.question.value
    || state.targetGrain !== grain || state.state !== 'active' || state.scaleMin !== 1 || state.scaleMax !== 10
    || state.cadence !== RATING_STANDING_CADENCE || state.populationPolicy !== RATING_ACCOUNT_POPULATION
    || state.aggregationPolicy !== RATING_LATEST_MEAN_POLICY) throw new RatingObservationUnavailable('Target Context bytes differ');
  return { context, realm: row.realm.value, question: row.question.value, contextRevision: row.contextRevision.value,
    targetGrain: grain, scale: { min: 1 as const, max: 10 as const, step: 1 as const }, cadence: 'standing' as const,
    population: 'account-principal' as const, aggregation: 'latest-per-rater-mean' as const, profile: TARGET_CONTEXT_ID };
}

/** Reuse the bounded, owner-authorized target resolver at the command and read boundary. */
export async function resolveRatingTarget(session: TargetReadSession, context: string, target: string) {
  const [resolved] = await resolveTargets(session, [target], 'rating');
  const rows = await session.query(`SELECT ?grain WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(context)} rv:targetGrain ?grain } } LIMIT 2`, 2);
  const grain = rows.length === 1 ? rows[0]?.grain?.value : undefined;
  const expected = TARGET_GRAINS[resolved!.base as TargetGrain];
  if (!expected || grain !== `${RV}${expected}`) throw new RatingTargetGrainMismatch('Context and target grain differ');
  return resolved!;
}

/** Receipt identity is checked on every retry, including terminal cancellations. */
function checked<T extends RatingContextReceipt | TargetRatingReceipt>(receipt: T, admission: RegisteredAdmission): T {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== admission.requestDigest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('Target rating receipt differs from admission');
  }
  if (receipt.outcome === 'cancelled') {
    if ('reason' in receipt && receipt.reason === 'stale-head') throw new StaleRatingObservation('Target rating changed');
    throw new CancelledActivation('Target rating command was cancelled');
  }
  return receipt;
}

async function admitted<T extends RatingContextReceipt | TargetRatingReceipt>(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, intent: { actingSubject: string; idempotencyKey: string }, digest: string,
  scope: string, context: boolean, write: (admission: RegisteredAdmission) => Promise<T>,
  read: (id: string) => Promise<T | null>) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, [context ? 'rating:configure' : 'rating:submit']);
  const registered = await access.register({ principal, actingSubject: intent.actingSubject, scope,
    action: context ? 'rating.context.create' : 'rating.observation.set', idempotencyKey: intent.idempotencyKey,
    requestDigest: digest });
  const kind = context ? 'rating-context' : 'rating-observation';
  try {
    const priorTerminal = await read(registered.id);
    if (priorTerminal) {
      await access.recordGraphOutcome(registered.id, priorTerminal);
      await assertNotInvalidProfileReceipt(env.fuseki, context ? ratingContextReceiptIri(registered.id) : standingRatingReceiptIri(registered.id));
      return { ...checked(priorTerminal, registered), replayed: registered.replayed };
    }
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
    }
    let writeError: unknown;
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        if (context) await sealRatingContextAdmission(env, admission);
        else await sealStandingRatingAdmission(env, admission);
      } else {
        try { await write(admission); } catch (error) { writeError = error; }
      }
    }
    const terminal = await read(registered.id);
    if (!terminal) {
      if (writeError) throw writeError;
      throw new PendingAdmittedWork(registered.id, kind);
    }
    await access.recordGraphOutcome(registered.id, terminal);
    if (writeError instanceof CommandRejected) throw writeError;
    await assertNotInvalidProfileReceipt(env.fuseki, context ? ratingContextReceiptIri(registered.id) : standingRatingReceiptIri(registered.id));
    return { ...checked(terminal, registered), replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleRatingObservation
      || error instanceof CancelledActivation || error instanceof RatingRealmUnavailable
      || error instanceof RatingObservationUnavailable || error instanceof CommandRejected) throw error;
    throw new PendingAdmittedWork(registered.id, kind);
  }
}

export function createAdmittedTargetRatingContext(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: TargetContextInput & { idempotencyKey: string }) {
  return admitted(env, account, access, request, input, targetContextDigest(input), `rating:context:${input.realm}`,
    true, admission => createTargetRatingContext(env, admission, input), id => readRatingContextReceipt(env, id))
    .then(receipt => {
      if (receipt.realm !== input.realm || !receipt.context || !receipt.revision) throw new IdempotencyConflict('Context receipt differs from intent');
      return receipt;
    });
}

async function createTargetRatingContext(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: TargetContextInput): Promise<RatingContextReceipt> {
  const receipt = ratingContextReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  const existing = await readRatingContextReceipt(env, admission.id);
  if (existing) return checked(existing, admission);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Context admission expired');
  const context = ID + Bun.randomUUIDv7(), revision = ID + Bun.randomUUIDv7(), operation = ID + Bun.randomUUIDv7();
  const state = { context, realm: input.realm, question: input.question, targetGrain: input.targetGrain,
    state: 'active', scaleMin: 1, scaleMax: 10, cadence: RATING_STANDING_CADENCE,
    populationPolicy: RATING_ACCOUNT_POPULATION, aggregationPolicy: RATING_LATEST_MEAN_POLICY };
  const manifest = prepareComponent(env.objectDirectory, context, state, TARGET_CONTEXT_PROFILE);
  const validations = await profileValidations(env.fuseki, TARGET_CONTEXT_ID, [
    { shape: `${TARGET_CONTEXT_PROFILE}/realm-shape`, focus: [input.realm], graphs: [GRAPHS.current] },
    { shape: `${TARGET_CONTEXT_PROFILE}/context-shape`, focus: [context], graphs: [GRAPHS.current] },
  ], { realm: input.realm, context, question: input.question, grain: `${RV}${TARGET_GRAINS[input.targetGrain]}` });
  const result = await validatedCommand(env, { receipt, digest: admission.requestDigest, validations, deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.realm)} rv:ratingContext ${iri(context)} .
        ${iri(context)} a rv:TargetRatingContext ; rv:contextState rv:Active ; rv:realm ${iri(input.realm)} ;
          rv:question ${lit(input.question)}@en ; rv:targetGrain rv:${TARGET_GRAINS[input.targetGrain]} ;
          rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
          rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ; rv:head ${iri(revision)} . }
      ${anchor(revision, context, operation, manifest, TARGET_CONTEXT_PROFILE, env.lineage.dataEpoch)}
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptIdentity(receipt, operation, admission, env.lineage.dataEpoch)}
        rv:realm ${iri(input.realm)} ; rv:ratingContext ${iri(context)} ; rv:ratingContextRevision ${iri(revision)} . }
      ${outbox(receipt, operation, env.lineage.dataEpoch, 'RatingContextCreatedEvent', 'rating.context.create',
        `rv:realm ${iri(input.realm)}`)} }
    WHERE { ${controlGuard(env, receipt)}
      GRAPH ${iri(GRAPHS.current)} { ?space a rv:Space ; rv:realmCapability ${iri(input.realm)} ; rv:disclosure rv:Public .
        ${iri(input.realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(context)} ?p ?o } }
      BIND(?n + 1 AS ?next) }` }, admission);
  if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
  const terminal = await readRatingContextReceipt(env, admission.id);
  if (!terminal) throw new PendingActivation('Target Context guard did not match');
  return checked(terminal, admission);
}

function anchor(revision: string, component: string, operation: string, manifest: string, profile: string, epoch: string) {
  return `GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(component)} ;
    rv:operation ${iri(operation)} ; rv:manifest <urn:rezics:sha256:${manifest}> ;
    rv:modelRevision ${iri(profile)} ; rv:shapeRevision ${iri(profile)} ; rv:datasetId ${iri(DATASET)} ;
    rv:dataEpoch ${lit(epoch)} ; rv:sequence ?next . }`;
}
function receiptIdentity(receipt: string, operation: string, admission: RegisteredAdmission, epoch: string) {
  return `${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ; rv:outcome rv:Succeeded ;
    rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
    rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
    rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(epoch)} ; rv:sequence ?next ;`;
}
function outbox(receipt: string, operation: string, epoch: string, type: string, action: string, reference: string) {
  const event = `urn:rezics:event:${hash(operation)}`;
  return `GRAPH ${iri(GRAPHS.outbox)} { <urn:rezics:outbox:${hash(receipt)}> a rv:OutboxBatch ;
    rv:dataEpoch ${lit(epoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
    ${iri(event)} a rv:${type} ; rv:ordinal 0 ; rv:action ${lit(action)} ; rv:receipt ${iri(receipt)} ;
      rv:operation ${iri(operation)} ; ${reference} . }`;
}
function controlGuard(env: WorkActivationEnvironment, receipt: string) {
  return `GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
    rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }`;
}

/** The caller has already authorized and resolved this exact target through G-506. */
export function setAdmittedTargetRating(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: TargetRatingInput & { idempotencyKey: string }, target: ResolvedTarget) {
  return admitted(env, account, access, request, input, targetRatingDigest(input), `rating:observe:${input.context}`,
    false, admission => setTargetRating(env, admission, input, target), id => readTargetRatingReceipt(env, id))
    .then(receipt => {
      if (receipt.context !== input.context || receipt.target !== input.target || !receipt.observation || !receipt.revision
        || receipt.predecessor !== input.expectedRevisionHead || receipt.value !== input.value) {
        throw new IdempotencyConflict('Target receipt differs from intent');
      }
      return receipt;
    });
}

async function setTargetRating(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: TargetRatingInput, target: ResolvedTarget): Promise<TargetRatingReceipt> {
  const receipt = standingRatingReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  const existing = await readTargetRatingReceipt(env, admission.id);
  if (existing) return checked(existing, admission);
  const context = await readTargetRatingContext(env, input.context);
  if (!context) throw new RatingObservationUnavailable('Target Context unavailable');
  if (target.resource !== input.target || target.base !== context.targetGrain) throw new RatingTargetGrainMismatch();
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Target admission expired');
  const slot = targetRatingSlotIri(admission.principalId, input.context, input.target);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?observation ?prior ?evaluatedAt WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?observation a rv:TargetRatingObservation ; rv:ratingContext ${iri(input.context)} ;
      rv:target ${iri(input.target)} ; rv:ratingSlot ${iri(slot)} ; rv:observationHead ?prior . }
    GRAPH ${iri(GRAPHS.revisions)} { ?prior a rv:TargetRatingObservationRevision ; rv:evaluatedAt ?evaluatedAt }
  } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length > 1) throw new RatingObservationUnavailable('Ambiguous target slot');
  const row = rows[0];
  if ((row?.prior?.value ?? null) !== input.expectedRevisionHead) {
    await sealRatingObservationTerminal(env, admission, 'stale-head', slot, input.expectedRevisionHead);
    throw new StaleRatingObservation('Target rating changed');
  }
  const observation = row?.observation?.value ?? ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7(), operation = ID + Bun.randomUUIDv7();
  if (!admission.registeredAt) throw new RatingObservationUnavailable('Admission time missing');
  const evaluatedAt = row?.evaluatedAt ? canonicalRatingInstant(row.evaluatedAt.value) : admission.registeredAt;
  const availability = input.value === null ? 'withdrawn' : 'available';
  const state = { observation, revision, slot, context: input.context, target: input.target,
    targetRevision: target.revision, targetGrain: context.targetGrain, contextRevision: context.contextRevision,
    realm: context.realm, predecessor: input.expectedRevisionHead, availability, value: input.value,
    evaluatedAt, submittedAt: admission.registeredAt, originalSubmissionAt: evaluatedAt, revisedAt: admission.registeredAt };
  const manifest = prepareComponent(env.objectDirectory, observation, state, TARGET_OBSERVATION_PROFILE);
  const validations = await profileValidations(env.fuseki, TARGET_OBSERVATION_ID,
    ['realm', 'context', 'observation', 'revision'].map(role => ({ shape: `${TARGET_OBSERVATION_PROFILE}/${role}-shape`,
      focus: [role === 'realm' ? context.realm : role === 'context' ? input.context : role === 'observation' ? observation : revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] })),
    { realm: context.realm, context: input.context, target: input.target, slot, observation, revision, availability,
      ...(input.value === null ? {} : { value: String(input.value) }),
      ...(input.expectedRevisionHead ? { predecessor: input.expectedRevisionHead } : {}) });
  const prior = input.expectedRevisionHead;
  const rated = input.value === null ? '' : `rv:ratingValue ${input.value} ;`;
  const result = await validatedCommand(env, { receipt, digest: admission.requestDigest, validations, deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${prior ? `GRAPH ${iri(GRAPHS.current)} { ${iri(observation)} rv:observationHead ${iri(prior)} }` : ''} }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(observation)} a rv:TargetRatingObservation ; rv:ratingContext ${iri(input.context)} ;
        rv:target ${iri(input.target)} ; rv:ratingSlot ${iri(slot)} ; rv:observationHead ${iri(revision)} . }
      ${anchor(revision, observation, operation, manifest, TARGET_OBSERVATION_PROFILE, env.lineage.dataEpoch)}
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:TargetRatingObservationRevision ;
        rv:observation ${iri(observation)} ; rv:ratingAvailability rv:${input.value === null ? 'Withdrawn' : 'Available'} ; ${rated}
        ${prior ? `rv:predecessor ${iri(prior)} ;` : ''}
        rv:evaluatedAt ${lit(evaluatedAt)}^^xsd:dateTime ; rv:submittedAt ${lit(admission.registeredAt)}^^xsd:dateTime ;
        rv:originalSubmissionAt ${lit(evaluatedAt)}^^xsd:dateTime ; rv:revisedAt ${lit(admission.registeredAt)}^^xsd:dateTime . }
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptIdentity(receipt, operation, admission, env.lineage.dataEpoch)}
        rv:realm ${iri(context.realm)} ; rv:ratingContext ${iri(input.context)} ; rv:contextRevision ${iri(context.contextRevision)} ;
        rv:target ${iri(input.target)} ; rv:ratingSlot ${iri(slot)} ; rv:ratingObservation ${iri(observation)} ;
        rv:observationRevision ${iri(revision)} ; ${rated}
        ${prior ? `rv:expectedHead ${iri(prior)} ;` : ''}
        rv:ratingAvailability rv:${input.value === null ? 'Withdrawn' : 'Available'} . }
      ${outbox(receipt, operation, env.lineage.dataEpoch, 'RatingObservationChangedEvent', 'rating.observation.set',
        `rv:ratingContext ${iri(input.context)} ; rv:ratingObservation ${iri(observation)}`)} }
    WHERE { ${controlGuard(env, receipt)}
      ${targetContextPattern(input.context, iri(context.realm), iri(context.contextRevision))}
      FILTER(?grain = rv:${TARGET_GRAINS[context.targetGrain]})
      ${targetRevisionGuard(target)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.target)} rv:protectionHead ?targetProtection } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(target.revision)} a rv:ErasedRevision } }
      ${target.work ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(target.work)} rv:protectionHead ?workProtection } }` : ''}
      ${prior ? `GRAPH ${iri(GRAPHS.current)} { ${iri(observation)} rv:ratingSlot ${iri(slot)} ; rv:observationHead ${iri(prior)} }`
        : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?occupied rv:ratingSlot ${iri(slot)} } }`}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
      BIND(?n + 1 AS ?next) }` }, admission);
  if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
  const terminal = await readTargetRatingReceipt(env, admission.id);
  if (terminal) return checked(terminal, admission);
  await sealRatingObservationTerminal(env, admission, 'stale-head', slot, prior);
  throw new PendingActivation('Target rating guard did not match');
}

/** G-506 supplies a retained owner revision; match its live pointer at commit. */
function targetRevisionGuard(target: ResolvedTarget) {
  const resource = iri(target.resource), revision = iri(target.revision);
  if (target.base === 'release' && target.resource === target.revision) {
    return `GRAPH ${iri(GRAPHS.revisions)} { ${resource} a rv:FixedRelease }`;
  }
  const pointers: Record<Base, string> = { work: 'rv:head', realization: 'rv:head', release: 'rv:releaseHead',
    occurrence: 'rv:structureHead', resource: 'rv:semanticHead' };
  if (target.base === 'realization') return `{ GRAPH ${iri(GRAPHS.current)} { ${resource} rv:head ${revision} } }
    UNION { GRAPH ${iri(GRAPHS.current)} { ${resource} rv:publicationHead ?publication }
      GRAPH ${iri(GRAPHS.revisions)} { ?publication rv:component ${resource} ; rv:selectedDraft ${revision} } }`;
  if (target.base === 'occurrence') return `GRAPH ${iri(GRAPHS.current)} {
    ${resource} rv:structure ?targetStructure . ?targetStructure rv:structureHead ${revision} ; rv:selectedGeneration ?targetGeneration .
    ?targetPlacement a rv:OccurrencePlacement ; rv:generation ?targetGeneration ; rv:occurrence ${resource} .
    FILTER NOT EXISTS { ?targetPlacement rv:removedBy ?targetRemoved } }`;
  return `GRAPH ${iri(GRAPHS.current)} { ${resource} ${pointers[target.base]} ${revision} }`;
}

export async function readTargetRatingReceipt(env: WorkActivationEnvironment, id: string): Promise<TargetRatingReceipt | null> {
  const receipt = standingRatingReceiptIri(id);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?digest ?epoch ?scope ?dataEpoch ?sequence
    ?operation ?realm ?context ?contextRevision ?target ?slot ?observation ?revision ?value ?availability ?predecessor ?reason WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:admissionId ${lit(id)} ;
      rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ;
      rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:operation ?operation ; rv:realm ?realm ; rv:ratingContext ?context ;
        rv:contextRevision ?contextRevision ; rv:target ?target ; rv:ratingSlot ?slot ;
        rv:ratingObservation ?observation ; rv:observationRevision ?revision ; rv:ratingAvailability ?availability }
      OPTIONAL { ${iri(receipt)} rv:ratingValue ?value } OPTIONAL { ${iri(receipt)} rv:expectedHead ?predecessor }
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
    } } LIMIT 2`)).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const outcome = row.outcome?.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome?.value === `${RV}Cancelled` ? 'cancelled' : null;
  const availability = row.availability?.value === `${RV}Available` ? 'available'
    : row.availability?.value === `${RV}Withdrawn` ? 'withdrawn' : undefined;
  if (rows.length !== 1 || !outcome || !row.digest || !row.epoch || !row.scope || !row.dataEpoch || !row.sequence
    || outcome === 'succeeded' && (!row.target || !row.context || !row.realm || !row.contextRevision
      || !row.operation || !row.slot || !row.observation || !row.revision || !availability
      || availability === 'available' && !/^(?:[1-9]|10)$/.test(row.value?.value ?? '')
      || availability === 'withdrawn' && !!row.value)) throw new RatingObservationUnavailable('Target receipt incomplete');
  return { receipt, admissionId: id, outcome, requestDigest: row.digest.value, authorityEpoch: row.epoch.value,
    scope: row.scope.value, dataEpoch: row.dataEpoch.value, sequence: row.sequence.value,
    ...(row.reason?.value === `${RV}StaleHead` ? { reason: 'stale-head' as const } : {}),
    ...(outcome === 'succeeded' ? { operation: row.operation!.value, realm: row.realm!.value, context: row.context!.value,
      contextRevision: row.contextRevision!.value, target: row.target!.value, slot: row.slot!.value,
      observation: row.observation!.value, revision: row.revision!.value, predecessor: row.predecessor?.value ?? null,
      availability, value: availability === 'available' ? Number(row.value!.value) : null } : {}) };
}

export async function readTargetRatingRevision(env: WorkActivationEnvironment, principalId: string,
  input: { context: string; target: string; observation: string; revision: string }) {
  const slot = targetRatingSlotIri(principalId, input.context, input.target);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?availability ?value ?predecessor ?evaluatedAt ?submittedAt WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.observation)} a rv:TargetRatingObservation ;
      rv:ratingSlot ${iri(slot)} ; rv:ratingContext ${iri(input.context)} ; rv:target ${iri(input.target)} }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(input.revision)} a rv:TargetRatingObservationRevision, rv:RevisionAnchor ;
      rv:component ${iri(input.observation)} ; rv:modelRevision ${iri(TARGET_OBSERVATION_PROFILE)} ;
      rv:manifest ?manifest ; rv:ratingAvailability ?availability ; rv:evaluatedAt ?evaluatedAt ; rv:submittedAt ?submittedAt .
      FILTER NOT EXISTS { ${iri(input.revision)} a rv:ErasedRevision }
      OPTIONAL { ${iri(input.revision)} rv:ratingValue ?value } OPTIONAL { ${iri(input.revision)} rv:predecessor ?predecessor }
    } } LIMIT 2`)).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.manifest) throw new RatingObservationUnavailable('Target revision ambiguous');
  const state = readComponentState(env.objectDirectory, row.manifest.value, input.observation, TARGET_OBSERVATION_PROFILE);
  if (state.slot !== slot || state.observation !== input.observation || state.revision !== input.revision
    || state.context !== input.context || state.target !== input.target || state.predecessor !== (row.predecessor?.value ?? null)
    || state.availability !== (row.availability?.value === `${RV}Available` ? 'available' : 'withdrawn')
    || state.value !== (row.value ? Number(row.value.value) : null)
    || !sameRatingInstant(state.evaluatedAt, row.evaluatedAt?.value) || !sameRatingInstant(state.submittedAt, row.submittedAt?.value)) {
    throw new RatingObservationUnavailable('Target revision bytes differ');
  }
  return { profile: TARGET_OBSERVATION_ID, context: input.context, target: input.target,
    observation: input.observation, observationRevision: input.revision, predecessor: state.predecessor,
    value: state.value, availability: state.availability, evaluatedAt: state.evaluatedAt,
    submittedAt: state.submittedAt, originalSubmissionAt: state.originalSubmissionAt, revisedAt: state.revisedAt };
}
