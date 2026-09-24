import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY,
  RATING_STANDING_CADENCE } from './context.ts';

const execFileAsync = promisify(execFile);
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f-]{36}$/;
export const STANDING_RATING_OBSERVATION_PROFILE =
  'https://rezics.com/definition/realm-standing-rating-observation-v1';

export class InvalidRatingObservationInput extends Error {}
export class RatingObservationUnavailable extends Error {}
export class StaleRatingObservation extends Error {}

export interface SetStandingRatingInput {
  context: string;
  work: string;
  mainVersion: string;
  expectedRevisionHead: string | null;
  value: number | null;
  actingSubject: string;
}

export interface RatingObservationReceipt {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head';
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string;
  scope: string; dataEpoch: string; sequence: string;
  operation?: string; realm?: string; context?: string; contextRevision?: string;
  work?: string; mainVersion?: string; slot?: string; observation?: string;
  revision?: string; predecessor?: string | null; value?: number | null;
  availability?: 'available' | 'withdrawn';
}

export function standingRatingDigest(input: SetStandingRatingInput): string {
  if (![input.context, input.work, input.mainVersion, input.actingSubject].every(value => nativeId.test(value))
    || (input.expectedRevisionHead !== null && !nativeId.test(input.expectedRevisionHead))
    || (input.value !== null && (!Number.isInteger(input.value) || input.value < 1 || input.value > 10))
    || (input.value === null && input.expectedRevisionHead === null)) {
    throw new InvalidRatingObservationInput('invalid standing rating request');
  }
  return hash(JSON.stringify({ family: 'realm-standing-rating-observation-v1',
    context: input.context, work: input.work, mainVersion: input.mainVersion,
    expectedRevisionHead: input.expectedRevisionHead, value: input.value,
    actingSubject: input.actingSubject }));
}

/** Access owns the high-entropy counting identity; RDF sees only this opaque slot. */
export function standingRatingSlotIri(principalId: string, context: string,
  mainVersion: string): string {
  if (!uuid.test(principalId) || !nativeId.test(context) || !nativeId.test(mainVersion)) {
    throw new InvalidRatingObservationInput('invalid standing rating slot');
  }
  return `urn:rezics:rating-slot:${hash(JSON.stringify({ principalId, context, mainVersion,
    cadence: RATING_STANDING_CADENCE }))}`;
}

export function standingRatingReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0standing-rating-observation`)}`;
}

export async function readStandingRatingReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<RatingObservationReceipt | null> {
  const receipt = standingRatingReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?epoch ?scope ?dataEpoch ?sequence ?operation
    ?realm ?context ?contextRevision ?work ?main ?slot ?observation ?revision
    ?predecessor ?value ?availability WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:operation ?operation ; rv:realm ?realm ;
        rv:ratingContext ?context ; rv:contextRevision ?contextRevision ;
        rv:work ?work ; rv:mainVersion ?main ; rv:ratingSlot ?slot ;
        rv:ratingObservation ?observation ; rv:observationRevision ?revision ;
        rv:ratingAvailability ?availability .
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?predecessor }
        OPTIONAL { ${iri(receipt)} rv:ratingValue ?value }
      }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const get = (name: string) => row[name]?.value;
  const outcome = get('outcome') === `${RV}Succeeded` ? 'succeeded'
    : get('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = get('reason') === `${RV}StaleHead` ? 'stale-head' : undefined;
  const availability = get('availability') === `${RV}Available` ? 'available'
    : get('availability') === `${RV}Withdrawn` ? 'withdrawn' : undefined;
  const success = ['operation', 'realm', 'context', 'contextRevision', 'work', 'main',
    'slot', 'observation', 'revision'];
  if (rows.length !== 1 || !outcome || !get('digest') || !get('id') || !get('epoch')
    || !get('scope') || !get('dataEpoch') || !/^[0-9]+$/.test(get('sequence') ?? '')
    || (get('reason') && !reason)
    || (outcome === 'succeeded' && (success.some(name => !get(name)) || reason
      || !availability || (availability === 'available' && !/^(?:[1-9]|10)$/.test(get('value') ?? ''))
      || (availability === 'withdrawn' && get('value'))))
    || (outcome === 'cancelled' && (success.some(name => get(name)) || get('predecessor')
      || get('value') || get('availability')))) {
    throw new Error('standing rating receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: get('id')!, requestDigest: get('digest')!, authorityEpoch: get('epoch')!,
    scope: get('scope')!, dataEpoch: get('dataEpoch')!, sequence: get('sequence')!,
    ...(outcome === 'succeeded' ? {
      operation: get('operation'), realm: get('realm'), context: get('context'),
      contextRevision: get('contextRevision'), work: get('work'), mainVersion: get('main'),
      slot: get('slot'), observation: get('observation'), revision: get('revision'),
      predecessor: get('predecessor') ?? null, availability,
      value: availability === 'available' ? Number(get('value')) : null,
    } : {}) };
}

function matches(receipt: RatingObservationReceipt, admission: RegisteredAdmission,
  digest: string): boolean {
  return receipt.admissionId === admission.id && receipt.requestDigest === digest
    && receipt.authorityEpoch === admission.authorityEpoch && receipt.scope === admission.scope;
}

export function checkedStandingRatingReceipt(receipt: RatingObservationReceipt,
  admission: RegisteredAdmission, input: SetStandingRatingInput, digest: string,
): RatingObservationReceipt {
  if (!matches(receipt, admission, digest)) {
    throw new IdempotencyConflict('standing rating receipt differs from admission');
  }
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new StaleRatingObservation('standing rating revision is stale');
    throw new RatingObservationUnavailable('standing rating was cancelled');
  }
  if (receipt.context !== input.context || receipt.work !== input.work
    || receipt.mainVersion !== input.mainVersion
    || receipt.predecessor !== input.expectedRevisionHead || receipt.value !== input.value
    || receipt.slot !== standingRatingSlotIri(admission.principalId, input.context,
      input.mainVersion)) {
    throw new IdempotencyConflict('standing rating receipt targets another intent');
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

async function readDependencies(env: WorkActivationEnvironment, input: SetStandingRatingInput,
  slot: string): Promise<Dependencies> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?realm ?contextRevision ?observation ?prior WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      ?realm a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
        rv:ratingContext ${iri(input.context)} .
      ${iri(input.context)} a rv:RatingContext ; rv:contextState rv:Active ;
        rv:realm ?realm ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ;
        rv:ratingScaleMax 10 ; rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
        rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
        rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ; rv:head ?contextRevision .
      ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
      ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
      OPTIONAL { ?observation a rv:RatingObservation ; rv:ratingSlot ${iri(slot)} ;
        rv:ratingContext ${iri(input.context)} ;
        rv:targetMainVersion ${iri(input.mainVersion)} ; rv:observationHead ?prior . }
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?contextRevision a rv:RevisionAnchor ; rv:component ${iri(input.context)} . }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.realm || !rows[0]?.contextRevision
    || (rows[0].observation && !rows[0].prior)) {
    throw new RatingObservationUnavailable('rating Context, target or slot is unavailable');
  }
  const row = rows[0]!;
  let times: { evaluatedAt: string; originalSubmissionAt: string } | undefined;
  if (row.prior) {
    const prior = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?evaluatedAt ?originalSubmissionAt WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(row.prior.value)}
        a rv:RatingObservationRevision, rv:RevisionAnchor ;
        rv:component ${iri(row.observation!.value)} ; rv:evaluatedAt ?evaluatedAt ;
        rv:originalSubmissionAt ?originalSubmissionAt . }
    }`);
    const priorRows = prior.results?.bindings ?? [];
    if (priorRows.length !== 1 || !priorRows[0]?.evaluatedAt
      || !priorRows[0]?.originalSubmissionAt) {
      throw new RatingObservationUnavailable('standing rating prior revision is unavailable');
    }
    times = { evaluatedAt: priorRows[0].evaluatedAt.value,
      originalSubmissionAt: priorRows[0].originalSubmissionAt.value };
  }
  return { realm: row.realm!.value, contextRevision: row.contextRevision!.value,
    ...(row.observation ? { observation: row.observation.value, prior: row.prior!.value,
      ...times } : {}) };
}

async function validateCandidate(env: WorkActivationEnvironment, input: SetStandingRatingInput,
  deps: Dependencies, slot: string,
  observation: string, revision: string, evaluatedAt: string,
  submittedAt: string, originalSubmissionAt: string): Promise<void> {
  mkdirSync(env.candidateDirectory, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(env.candidateDirectory, 'rating-observation-'));
  try {
    const data = join(temp, 'candidate.ttl');
    const prior = input.expectedRevisionHead;
    writeFileSync(data, `@prefix rv: <${RV}> .\n` +
      '@prefix schema: <https://schema.org/> .\n' +
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n' +
      `${iri(deps.realm)} a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext ${iri(input.context)} .\n` +
      `${iri(input.context)} a rv:RatingContext ; rv:contextState rv:Active ; ` +
      `rv:realm ${iri(deps.realm)} ; rv:targetGrain rv:MainVersion ; ` +
      `rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; ` +
      `rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ; ` +
      `rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ; ` +
      `rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} .\n` +
      `${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .\n` +
      `${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .\n` +
      `${iri(observation)} a rv:RatingObservation ; rv:ratingContext ${iri(input.context)} ; ` +
      `rv:targetMainVersion ${iri(input.mainVersion)} ; rv:ratingSlot ${iri(slot)} ; ` +
      `rv:observationHead ${iri(revision)} .\n` +
      `${iri(revision)} a rv:RatingObservationRevision ; rv:observation ${iri(observation)} ; ` +
      `rv:ratingAvailability rv:${input.value === null ? 'Withdrawn' : 'Available'} ; ` +
      `rv:evaluatedAt ${lit(evaluatedAt)}^^xsd:dateTime ; ` +
      `rv:submittedAt ${lit(submittedAt)}^^xsd:dateTime ; ` +
      `rv:originalSubmissionAt ${lit(originalSubmissionAt)}^^xsd:dateTime ; ` +
      `rv:revisedAt ${lit(submittedAt)}^^xsd:dateTime` +
      (input.value === null ? '' : ` ; rv:ratingValue ${input.value}`) +
      (prior ? ` ; rv:predecessor ${iri(prior)}` : '') + ' .\n' +
      (prior ? `${iri(prior)} a rv:RatingObservationRevision .\n` : ''), { mode: 0o600 });
    const args = [join(env.repositoryRoot, 'model/tools/validate_realm_standing_rating_observation.py'),
      '--data', data, '--realm', deps.realm, '--context', input.context,
      '--work', input.work, '--main', input.mainVersion, '--slot', slot,
      '--observation', observation, '--revision', revision,
      '--availability', input.value === null ? 'withdrawn' : 'available',
      ...(input.value === null ? [] : ['--value', String(input.value)]),
      ...(prior ? ['--predecessor', prior] : []),
      '--jena-home', env.jenaHome, '--java-home', env.javaHome,
      '--temp-root', env.candidateDirectory];
    const { stdout } = await execFileAsync(env.python, args,
      { cwd: env.repositoryRoot, timeout: 20_000, maxBuffer: 128 * 1024 });
    const report = JSON.parse(stdout) as { conforms: boolean; profile_sha256: string };
    if (report.conforms !== true || !report.profile_sha256) {
      throw new Error('standing rating candidate validation incomplete');
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

async function sealTerminal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  reason?: 'stale-head', slot?: string, expectedHead?: string | null,
): Promise<RatingObservationReceipt | null> {
  const receipt = standingRatingReceiptIri(admission.id);
  const suffix = hash(`${receipt}\0${reason ? 'stale' : 'cancel'}`);
  const batch = `urn:rezics:outbox:${suffix}`;
  const event = `urn:rezics:event:${suffix}`;
  const staleGuard = reason && slot ? (expectedHead
    ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
         ?observation rv:ratingSlot ${iri(slot)} ; rv:observationHead ${iri(expectedHead)} . } }`
    : `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
         ?observation rv:ratingSlot ${iri(slot)} ; rv:observationHead ?prior . } }`) : '';
  try { await env.fuseki.update(`PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
          ${reason ? 'rv:reason rv:StaleHead ;' : ''}
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:${reason ? 'RatingObservationStaleEvent' : 'RatingObservationCancelledEvent'} ;
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
    }`); } catch { /* resolve ambiguous update through receipt */ }
  return readStandingRatingReceipt(env, admission.id);
}

export async function sealStandingRatingAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<RatingObservationReceipt> {
  if (admission.action !== 'rating.observation.set'
    || !admission.scope.startsWith('rating:observe:')) {
    throw new IdempotencyConflict('unsupported standing rating admission');
  }
  const existing = await readStandingRatingReceipt(env, admission.id);
  if (existing) {
    if (!matches(existing, admission, admission.requestDigest)) {
      throw new IdempotencyConflict('standing rating receipt differs from admission');
    }
    return existing;
  }
  const terminal = await sealTerminal(env, admission);
  if (!terminal || !matches(terminal, admission, admission.requestDigest)) {
    throw new PendingActivation('standing rating cancellation outcome unknown');
  }
  return terminal;
}

/** Replace one Account-principal opinion by exact head; prior revisions remain immutable. */
export async function setStandingRating(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: SetStandingRatingInput,
): Promise<RatingObservationReceipt> {
  const digest = standingRatingDigest(input);
  if (admission.action !== 'rating.observation.set'
    || admission.scope !== `rating:observe:${input.context}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('standing rating admission differs from intent');
  }
  const existing = await readStandingRatingReceipt(env, admission.id);
  if (existing) return checkedStandingRatingReceipt(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('standing rating admission expired');
  }
  const slot = standingRatingSlotIri(admission.principalId, input.context, input.mainVersion);
  const deps = await readDependencies(env, input, slot);
  if ((deps.prior ?? null) !== input.expectedRevisionHead) {
    const stale = await sealTerminal(env, admission, 'stale-head', slot,
      input.expectedRevisionHead);
    if (stale) return checkedStandingRatingReceipt(stale, admission, input, digest);
    throw new PendingActivation('stale standing rating was not sealed');
  }
  const observation = deps.observation ?? ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const now = new Date().toISOString();
  const evaluatedAt = deps.evaluatedAt ?? now;
  const originalSubmissionAt = deps.originalSubmissionAt ?? now;
  await validateCandidate(env, input, deps, slot, observation,
    revision, evaluatedAt, now, originalSubmissionAt);
  const manifest = prepareComponent(env.objectDirectory, observation,
    { observation, slot, context: input.context, contextRevision: deps.contextRevision,
      realm: deps.realm, work: input.work, mainVersion: input.mainVersion,
      revision, predecessor: input.expectedRevisionHead,
      availability: input.value === null ? 'withdrawn' : 'available', value: input.value,
      evaluatedAt, submittedAt: now, originalSubmissionAt, revisedAt: now },
    STANDING_RATING_OBSERVATION_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('standing rating admission expired');
  }
  const receipt = standingRatingReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  const prior = input.expectedRevisionHead;
  const headGuard = prior ? `GRAPH ${iri(GRAPHS.current)} {
      ${iri(observation)} a rv:RatingObservation ; rv:ratingSlot ${iri(slot)} ;
        rv:ratingContext ${iri(input.context)} ; rv:targetMainVersion ${iri(input.mainVersion)} ;
        rv:observationHead ${iri(prior)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(prior)} a rv:RatingObservationRevision,
        rv:RevisionAnchor ; rv:component ${iri(observation)} . }`
    : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
         ?occupied rv:ratingSlot ${iri(slot)} . } }
       FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(observation)} ?p ?o } }`;
  let updateError: unknown;
  try { await env.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${prior ? `GRAPH ${iri(GRAPHS.current)} {
        ${iri(observation)} rv:observationHead ${iri(prior)} }` : ''}
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(observation)} a rv:RatingObservation ; rv:ratingContext ${iri(input.context)} ;
          rv:targetMainVersion ${iri(input.mainVersion)} ; rv:ratingSlot ${iri(slot)} ;
          rv:observationHead ${iri(revision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:RatingObservationRevision, rv:RevisionAnchor ;
          rv:component ${iri(observation)} ; rv:observation ${iri(observation)} ;
          rv:operation ${iri(operation)} ;
          rv:ratingAvailability rv:${input.value === null ? 'Withdrawn' : 'Available'} ;
          ${input.value === null ? '' : `rv:ratingValue ${input.value} ;`}
          ${prior ? `rv:predecessor ${iri(prior)} ;` : ''}
          rv:evaluatedAt ${lit(evaluatedAt)}^^xsd:dateTime ;
          rv:submittedAt ${lit(now)}^^xsd:dateTime ;
          rv:originalSubmissionAt ${lit(originalSubmissionAt)}^^xsd:dateTime ;
          rv:revisedAt ${lit(now)}^^xsd:dateTime ;
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(STANDING_RATING_OBSERVATION_PROFILE)} ;
          rv:shapeRevision ${iri(STANDING_RATING_OBSERVATION_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:realm ${iri(deps.realm)} ; rv:ratingContext ${iri(input.context)} ;
          rv:contextRevision ${iri(deps.contextRevision)} ;
          rv:work ${iri(input.work)} ; rv:mainVersion ${iri(input.mainVersion)} ;
          rv:ratingSlot ${iri(slot)} ; rv:ratingObservation ${iri(observation)} ;
          rv:observationRevision ${iri(revision)} ;
          rv:ratingAvailability rv:${input.value === null ? 'Withdrawn' : 'Available'} ;
          ${input.value === null ? '' : `rv:ratingValue ${input.value} ;`}
          ${prior ? `rv:expectedHead ${iri(prior)} ;` : ''}
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
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
        ?space a rv:Space ; rv:realmCapability ${iri(deps.realm)} ; rv:disclosure rv:Public .
        ${iri(deps.realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:ratingContext ${iri(input.context)} .
        ${iri(input.context)} a rv:RatingContext ; rv:contextState rv:Active ;
          rv:realm ${iri(deps.realm)} ; rv:targetGrain rv:MainVersion ;
          rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
          rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
          rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} ;
          rv:head ${iri(deps.contextRevision)} .
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
      }
      ${headGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`); } catch (error) { updateError = error; }
  const committed = await readStandingRatingReceipt(env, admission.id);
  if (committed) return checkedStandingRatingReceipt(committed, admission, input, digest);
  const stale = await sealTerminal(env, admission, 'stale-head', slot,
    input.expectedRevisionHead);
  if (stale) return checkedStandingRatingReceipt(stale, admission, input, digest);
  throw new PendingActivation(updateError
    ? 'standing rating update outcome unknown' : 'standing rating guard did not match');
}
