import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { readComponentState } from '../work/history.ts';
import { IdempotencyConflict, PendingActivation,
  DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { checkedEventObservation, eventPointRdf, type EventObservationIntent } from './time.ts';

export class EventObservationUnavailable extends Error {}
export class InvalidEventObservation extends Error {}
export class StaleEventObservation extends Error {}

const EVENT_TIME_PROFILE_ID = 'event-time-v1';
const EVENT_TIME_PROFILE = 'https://rezics.com/definition/event-time-v1';
const VALUE_PROFILE = 'value-exact-v1';
const validNative = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EventObservationReceipt {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  event?: string;
  eventTime?: string;
  timeStatus?: 'actual' | 'planned';
  revision?: string;
  predecessor?: string | null;
  recordedAt?: string;
}

export function eventTimeSlotIri(event: string, status: 'actual' | 'planned'): string {
  if (!validNative.test(event) || !['actual', 'planned'].includes(status)) {
    throw new InvalidEventObservation('event time slot is invalid');
  }
  return `urn:rezics:event-time-slot:${hash(JSON.stringify([event, status]))}`;
}

export function contentEvidenceIri(revisionId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(revisionId)) {
    throw new InvalidEventObservation('Content evidence revision is invalid');
  }
  return `urn:rezics:content-revision:${revisionId}`;
}

export function eventObservationDigest(input: EventObservationIntent): string {
  return hash(JSON.stringify(['event-time-observation-v1', input]));
}

export function eventObservationReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0event-time-observation-v1`)}`;
}

function canonicalInstant(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) throw new InvalidEventObservation('server timestamp is invalid');
  return new Date(value).toISOString();
}

function sameInstant(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b))
    && Date.parse(a) === Date.parse(b));
}

export async function readEventObservationReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<EventObservationReceipt | null> {
  const receipt = eventObservationReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?reason ?digest ?id ?epoch ?scope
    ?dataEpoch ?sequence ?event ?eventTime ?status ?revision ?predecessor ?recordedAt WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
      rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ;
      rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:event ?event ; rv:eventTime ?eventTime ; rv:timeStatus ?status ;
        rv:observationRevision ?revision ; rv:recordedAt ?recordedAt .
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?predecessor }
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
  const status = get('status') === `${RV}ActualTime` ? 'actual'
    : get('status') === `${RV}PlannedTime` ? 'planned' : undefined;
  if (rows.length !== 1 || !outcome || !get('digest') || !get('id') || !get('epoch') || !get('scope')
    || !get('dataEpoch') || !/^(0|[1-9][0-9]*)$/.test(get('sequence') ?? '')
    || (get('reason') && !reason)
    || (outcome === 'succeeded' && (!get('event') || !get('eventTime') || !get('status')
      || !get('revision') || !get('recordedAt') || reason
      || !status))
    || (outcome === 'cancelled' && (get('event') || get('eventTime') || get('status')
      || get('revision') || get('predecessor') || get('recordedAt')))) {
    throw new EventObservationUnavailable('event observation receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt, admissionId: get('id')!,
    requestDigest: get('digest')!, authorityEpoch: get('epoch')!, scope: get('scope')!,
    dataEpoch: get('dataEpoch')!, sequence: get('sequence')!,
    ...(outcome === 'succeeded' ? { event: get('event'), eventTime: get('eventTime'),
      timeStatus: status!, revision: get('revision'),
      predecessor: get('predecessor') ?? null, recordedAt: get('recordedAt') } : {}) };
}

function receiptMatches(receipt: EventObservationReceipt, admission: RegisteredAdmission, digest: string) {
  return receipt.admissionId === admission.id && receipt.requestDigest === digest
    && receipt.authorityEpoch === admission.authorityEpoch && receipt.scope === admission.scope;
}

function checkedReceipt(receipt: EventObservationReceipt, admission: RegisteredAdmission,
  input: EventObservationIntent, digest: string): EventObservationReceipt {
  if (!receiptMatches(receipt, admission, digest)) throw new IdempotencyConflict('event receipt differs from admission');
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new StaleEventObservation('event time head changed');
    throw new EventObservationUnavailable('event observation was cancelled');
  }
  if (receipt.event !== input.event || receipt.eventTime !== eventTimeSlotIri(input.event, input.timeStatus)
    || receipt.timeStatus !== input.timeStatus || receipt.predecessor !== input.expectedRevisionHead) {
    throw new IdempotencyConflict('event receipt targets another intent');
  }
  return receipt;
}

async function readCurrentHead(env: WorkActivationEnvironment, eventTime: string) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(eventTime)} rv:eventTimeHead ?head }
  }`)).results?.bindings ?? [];
  if (rows.length > 1) throw new EventObservationUnavailable('event time head is not unique');
  return rows[0]?.head?.value ?? null;
}

async function sealTerminal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  reason?: 'stale-head', eventTime?: string, expectedHead?: string | null): Promise<EventObservationReceipt | null> {
  const receipt = eventObservationReceiptIri(admission.id);
  const suffix = hash(`${receipt}\0${reason ? 'stale' : 'cancel'}`);
  const batch = `urn:rezics:outbox:${suffix}`, event = `urn:rezics:event:${suffix}`;
  const staleGuard = reason && eventTime ? expectedHead
    ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(eventTime)} rv:eventTimeHead ${iri(expectedHead)} } }`
    : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(eventTime)} rv:eventTimeHead ?head } }` : '';
  try {
    await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest, validations: [], deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}>
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
            ${iri(event)} a rv:${reason ? 'EventTimeStaleEvent' : 'EventTimeCancelledEvent'} ;
              rv:ordinal 0 ; rv:action "event.observation.set" ; rv:receipt ${iri(receipt)} . }
        }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          ${staleGuard}
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          BIND(?n + 1 AS ?next) }` });
  } catch { /* resolve an ambiguous response through its durable receipt */ }
  return readEventObservationReceipt(env, admission.id);
}

export async function sealEventObservationAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<EventObservationReceipt> {
  if (admission.action !== 'event.observation.set' || !admission.scope.startsWith('event:observe:')) {
    throw new IdempotencyConflict('unsupported event observation admission');
  }
  const existing = await readEventObservationReceipt(env, admission.id);
  if (existing) {
    if (!receiptMatches(existing, admission, admission.requestDigest)) throw new IdempotencyConflict('event receipt differs from admission');
    return existing;
  }
  const cancelled = await sealTerminal(env, admission);
  if (!cancelled || !receiptMatches(cancelled, admission, admission.requestDigest)) {
    throw new PendingActivation('event observation cancellation outcome unknown');
  }
  return cancelled;
}

function pointTriples(point: ReturnType<typeof eventPointRdf>): string {
  const pointTriples = `${iri(point.iri)} a rv:EventTimePoint ; rv:pointState rv:${point.state === 'known' ? 'KnownPoint'
    : point.state === 'unknown' ? 'UnknownPoint' : 'OpenPoint'} ;
    ${point.temporalNode ? `rv:temporalValue ${iri(point.temporalNode)} .`
      : `rv:unknownLexical ${lit(point.lexical)} .`}`;
  return point.temporalTriples.length
    ? `${pointTriples}\n${point.temporalTriples.join(' .\n')} .` : pointTriples;
}

export async function setEventObservation(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, rawInput: EventObservationIntent): Promise<EventObservationReceipt> {
  let input: EventObservationIntent;
  try { input = checkedEventObservation(rawInput); }
  catch (error) { if (error instanceof InvalidEventObservation) throw error; throw new InvalidEventObservation('event observation is invalid'); }
  const digest = eventObservationDigest(input);
  if (admission.action !== 'event.observation.set'
    || admission.scope !== `event:observe:${input.event}` || admission.actingSubject !== input.actingSubject
    || admission.requestDigest !== digest) throw new IdempotencyConflict('event observation admission differs from intent');
  const existing = await readEventObservationReceipt(env, admission.id);
  if (existing) return checkedReceipt(existing, admission, input, digest);
  if (!admission.registeredAt || Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('event observation admission expired');
  }
  const eventTime = eventTimeSlotIri(input.event, input.timeStatus);
  const prior = await readCurrentHead(env, eventTime);
  if (prior !== input.expectedRevisionHead) {
    const stale = await sealTerminal(env, admission, 'stale-head', eventTime, input.expectedRevisionHead);
    if (stale) return checkedReceipt(stale, admission, input, digest);
    throw new PendingActivation('stale event observation was not sealed');
  }
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const recordedAt = canonicalInstant(admission.registeredAt);
  const start = eventPointRdf(input.start, () => ID + Bun.randomUUIDv7());
  const end = input.end ? eventPointRdf(input.end, () => ID + Bun.randomUUIDv7()) : undefined;
  const state = { event: input.event, eventTime, timeStatus: input.timeStatus, temporalKind: input.temporalKind,
    start: input.start, ...(input.end ? { end: input.end } : {}), timeEvidence: input.timeEvidence ?? null,
    startPoint: start.iri, startValue: start.temporalNode ?? null,
    ...(end ? { endPoint: end.iri, endValue: end.temporalNode ?? null } : {}),
    revision, predecessor: prior, recordedAt };
  const manifest = prepareComponent(env.objectDirectory, eventTime, state, EVENT_TIME_PROFILE);
  const eventProfileChecks = await profileValidations(env.fuseki, EVENT_TIME_PROFILE_ID, [
    { shape: 'https://rezics.com/definition/event-time-v1/event-shape', focus: [input.event], graphs: [GRAPHS.current] },
    { shape: 'https://rezics.com/definition/event-time-v1/slot-shape', focus: [eventTime],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: 'https://rezics.com/definition/event-time-v1/revision-shape', focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: 'https://rezics.com/definition/event-time-v1/point-shape', focus: [start.iri], graphs: [GRAPHS.revisions] },
    ...(end ? [{ shape: 'https://rezics.com/definition/event-time-v1/point-shape', focus: [end.iri], graphs: [GRAPHS.revisions] }] : []),
  ]);
  const values = [start, ...(end ? [end] : [])].filter(point => point.temporalNode);
  const valueChecks = values.length ? await profileValidations(env.fuseki, VALUE_PROFILE,
    values.map(point => ({ shape: 'https://rezics.com/definition/value-exact-v1/temporal-shape',
      focus: [point.temporalNode!], graphs: [GRAPHS.revisions] }))) : [];
  const validations = [...eventProfileChecks, ...valueChecks];
  const receipt = eventObservationReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  const eventTimeStatus = input.timeStatus === 'actual' ? 'ActualTime' : 'PlannedTime';
  const headGuard = prior
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(eventTime)} a rv:EventTime ; rv:event ${iri(input.event)} ;
        rv:timeStatus rv:${eventTimeStatus} ; rv:eventTimeHead ${iri(prior)} . }
       GRAPH ${iri(GRAPHS.revisions)} { ${iri(prior)} a rv:EventTimeRevision, rv:RevisionAnchor ; rv:component ${iri(eventTime)} . }`
    : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(eventTime)} ?p ?o } }`;
  let updateError: unknown;
  try {
    const result = await env.fuseki.commandWithReceipt({ receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
          ${prior ? `GRAPH ${iri(GRAPHS.current)} { ${iri(eventTime)} rv:eventTimeHead ${iri(prior)} }` : ''} }
        INSERT {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} {
            ${iri(input.event)} a rv:Event ; rv:eventTime ${iri(eventTime)} .
            ${iri(eventTime)} a rv:EventTime ; rv:event ${iri(input.event)} ;
              rv:timeStatus rv:${eventTimeStatus} ; rv:eventTimeHead ${iri(revision)} . }
          GRAPH ${iri(GRAPHS.revisions)} {
            ${iri(revision)} a rv:EventTimeRevision, rv:RevisionAnchor ; rv:component ${iri(eventTime)} ;
              rv:eventTime ${iri(eventTime)} ; rv:timeAvailability rv:Available ;
              rv:temporalKind rv:${input.temporalKind === 'instant' ? 'InstantTime' : 'IntervalTime'} ;
              rv:eventStart ${iri(start.iri)} ; ${end ? `rv:eventEnd ${iri(end.iri)} ;` : ''}
              ${input.timeEvidence ? `rv:timeEvidence ${iri(contentEvidenceIri(input.timeEvidence))} ;` : ''}
              rv:recordedAt ${lit(recordedAt)}^^xsd:dateTime ;
              rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
              rv:modelRevision ${iri(EVENT_TIME_PROFILE)} ; rv:shapeRevision ${iri(EVENT_TIME_PROFILE)} ;
              rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              ${prior ? `rv:predecessor ${iri(prior)} ;` : ''} rv:sequence ?next .
            ${pointTriples(start)}
            ${end ? pointTriples(end) : ''}
          }
          GRAPH ${iri(GRAPHS.receipts)} {
            ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
              rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
              rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
              rv:outcome rv:Succeeded ; rv:event ${iri(input.event)} ; rv:eventTime ${iri(eventTime)} ;
              rv:timeStatus rv:${eventTimeStatus} ; rv:observationRevision ${iri(revision)} ;
              rv:recordedAt ${lit(recordedAt)}^^xsd:dateTime ;
              ${prior ? `rv:expectedHead ${iri(prior)} ;` : ''}
              rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
          }
          GRAPH ${iri(GRAPHS.outbox)} {
            ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
            ${iri(event)} a rv:EventTimeChangedEvent ; rv:ordinal 0 ;
              rv:action "event.observation.set" ; rv:receipt ${iri(receipt)} ;
              rv:operation ${iri(operation)} ; rv:eventTime ${iri(eventTime)} ; rv:event ${iri(input.event)} .
          }
        }
        WHERE {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          ${headGuard}
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
          BIND(?n + 1 AS ?next)
        }` });
    if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'conflict') throw new IdempotencyConflict('event command receipt conflicts with another intent');
  } catch (error) {
    if (error instanceof CommandRejected) throw new InvalidEventObservation('event time failed reviewed shape validation');
    if (error instanceof IdempotencyConflict) throw error;
    updateError = error;
  }
  const committed = await readEventObservationReceipt(env, admission.id);
  if (committed) return checkedReceipt(committed, admission, input, digest);
  const afterFailureHead = await readCurrentHead(env, eventTime);
  if (afterFailureHead !== input.expectedRevisionHead) {
    const stale = await sealTerminal(env, admission, 'stale-head', eventTime, input.expectedRevisionHead);
    if (stale) return checkedReceipt(stale, admission, input, digest);
  }
  throw new PendingActivation(updateError ? 'event observation outcome unknown' : 'event observation guard did not match');
}

export async function verifyEventObservationManifest(env: WorkActivationEnvironment,
  revision: string, manifest: string, eventTime: string): Promise<Record<string, unknown>> {
  try {
    const state = readComponentState(env.objectDirectory, manifest, eventTime, EVENT_TIME_PROFILE);
    if (state.eventTime !== eventTime || state.revision !== revision) throw new Error('manifest binding differs');
    return state;
  } catch { throw new EventObservationUnavailable('event time source manifest is unavailable'); }
}
