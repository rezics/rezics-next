import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, CancelledActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const REALM_STANDING_RATING_CONTEXT_PROFILE =
  'https://rezics.com/definition/realm-standing-rating-context-v1';
export const RATING_STANDING_CADENCE = 'https://rezics.com/definition/rating-standing-v1';
export const RATING_ACCOUNT_POPULATION =
  'https://rezics.com/definition/rating-account-principal-population-v1';
export const RATING_LATEST_MEAN_POLICY =
  'https://rezics.com/definition/rating-latest-per-rater-mean-v1';

export class InvalidRatingContextInput extends Error {}
export class RatingRealmUnavailable extends Error {}

export interface CreateRatingContextInput {
  realm: string;
  question: string;
  actingSubject: string;
}

export interface RatingContextReceipt {
  outcome: 'succeeded' | 'cancelled';
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string;
  scope: string; dataEpoch: string; sequence: string;
  context?: string; realm?: string; revision?: string;
}

export function ratingContextDigest(input: CreateRatingContextInput): string {
  if (!nativeId.test(input.realm) || !nativeId.test(input.actingSubject)
    || typeof input.question !== 'string' || input.question.length < 3
    || input.question.length > 120 || input.question !== input.question.normalize('NFC')
    || /[\u0000-\u001f\u007f]/u.test(input.question)
    || input.question.trim() !== input.question) {
    throw new InvalidRatingContextInput('invalid standing rating context request');
  }
  return hash(JSON.stringify({ family: 'realm-standing-rating-context-v1',
    realm: input.realm, question: input.question, actingSubject: input.actingSubject,
    targetGrain: 'MainVersion', scale: [1, 10], cadence: RATING_STANDING_CADENCE,
    population: RATING_ACCOUNT_POPULATION, aggregation: RATING_LATEST_MEAN_POLICY }));
}

export function ratingContextReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0rating-context-create`)}`;
}

export async function readRatingContextReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<RatingContextReceipt | null> {
  const receipt = ratingContextReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?digest ?id ?epoch ?scope ?dataEpoch ?sequence ?context ?realm ?revision WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:ratingContext ?context ; rv:realm ?realm ;
        rv:ratingContextRevision ?revision }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const value = (name: string) => row[name]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id') || !value('epoch')
    || !value('scope') || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (outcome === 'succeeded' && (!value('context') || !value('realm') || !value('revision')))
    || (outcome === 'cancelled' && (value('context') || value('realm') || value('revision')))) {
    throw new Error('rating context receipt is incomplete');
  }
  return { outcome, receipt, admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!,
    dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { context: value('context'), realm: value('realm'),
      revision: value('revision') } : {}) };
}

function checked(receipt: RatingContextReceipt, admission: RegisteredAdmission,
  input: CreateRatingContextInput, digest: string): RatingContextReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== digest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('rating context admission differs from receipt');
  }
  if (receipt.outcome === 'cancelled') throw new CancelledActivation('rating context creation was cancelled');
  if (receipt.realm !== input.realm) throw new IdempotencyConflict('rating Realm differs');
  return receipt;
}

async function validateCandidate(env: WorkActivationEnvironment, realm: string,
  context: string, question: string): Promise<CommandValidation[]> {
  iri(realm); iri(context);
  if (!question) throw new InvalidRatingContextInput('rating question is empty');
  const profile = REALM_STANDING_RATING_CONTEXT_PROFILE;
  return profileValidations(env.fuseki, 'realm-standing-rating-context-v1', [
    { shape: `${profile}/realm-shape`, focus: [realm], graphs: [GRAPHS.current] },
    { shape: `${profile}/context-shape`, focus: [context], graphs: [GRAPHS.current] },
  ]);
}

export async function createRatingContext(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: CreateRatingContextInput,
): Promise<RatingContextReceipt> {
  const digest = ratingContextDigest(input);
  if (admission.action !== 'rating.context.create'
    || admission.scope !== `rating:context:${input.realm}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('rating context admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, ratingContextReceiptIri(admission.id));
  const existing = await readRatingContextReceipt(env, admission.id);
  if (existing) return checked(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('rating context admission expired');
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
  const validations = await validateCandidate(env, input.realm, context, input.question);
  const manifest = prepareComponent(env.objectDirectory, context,
    { context, realm: input.realm, question: input.question, state: 'active',
      targetGrain: 'MainVersion', scaleMin: 1, scaleMax: 10,
      cadence: RATING_STANDING_CADENCE, populationPolicy: RATING_ACCOUNT_POPULATION,
      aggregationPolicy: RATING_LATEST_MEAN_POLICY }, REALM_STANDING_RATING_CONTEXT_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('rating context admission expired');
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
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.realm)} rv:ratingContext ${iri(context)} .
        ${iri(context)} a rv:RatingContext ; rv:contextState rv:Active ;
          rv:realm ${iri(input.realm)} ; rv:question ${lit(input.question)}@en ;
          rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
          rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
          rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
          rv:head ${iri(revision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(context)} ;
          rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(REALM_STANDING_RATING_CONTEXT_PROFILE)} ;
          rv:shapeRevision ${iri(REALM_STANDING_RATING_CONTEXT_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:ratingContext ${iri(context)} ; rv:realm ${iri(input.realm)} ;
          rv:ratingContextRevision ${iri(revision)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:RatingContextCreatedEvent ; rv:ordinal 0 ;
          rv:action "rating.context.create" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:realm ${iri(input.realm)} .
      }
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
      throw new InvalidRatingContextInput(`Rating context validation ${result.status}`);
    }
  } catch (error) {
    if (error instanceof InvalidRatingContextInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readRatingContextReceipt(env, admission.id);
  if (committed) return checked(committed, admission, input, digest);
  throw new PendingActivation(updateError
    ? 'rating context update outcome unknown' : 'rating context guard did not match');
}

export async function sealRatingContextAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<RatingContextReceipt> {
  if (admission.action !== 'rating.context.create'
    || !admission.scope.startsWith('rating:context:')) {
    throw new IdempotencyConflict('unsupported rating context admission');
  }
  const existing = await readRatingContextReceipt(env, admission.id);
  if (existing) return existing;
  const receipt = ratingContextReceiptIri(admission.id);
  const digest = hash(`${receipt}\0cancel`);
  const event = `urn:rezics:event:${digest}`;
  const batch = `urn:rezics:outbox:${digest}`;
  let updateError: unknown;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:RatingContextCancelledEvent ; rv:ordinal 0 ;
          rv:action "rating.context.create" ; rv:receipt ${iri(receipt)} ;
          rv:admissionId ${lit(admission.id)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch (error) { updateError = error; }
  const committed = await readRatingContextReceipt(env, admission.id);
  if (!committed || committed.requestDigest !== admission.requestDigest
    || committed.admissionId !== admission.id
    || committed.authorityEpoch !== admission.authorityEpoch
    || committed.scope !== admission.scope) {
    throw new PendingActivation(updateError
      ? 'rating context cancellation outcome unknown' : 'rating context cancellation guard did not match');
  }
  return committed;
}
