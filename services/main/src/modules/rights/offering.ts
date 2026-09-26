import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, CancelledActivation,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';

const profile = 'https://rezics.com/definition/rights-offering-v1';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const instrumentId = /^https?:\/\/[^\s<>"{}|\\^`]{1,500}$/;
const externalIri = (value: string): string => {
  if (!instrumentId.test(value)) throw new RightsOfferingInvalid('invalid rights instrument');
  return `<${value}>`;
};
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
const actions = {
  create: 'rights.offer-create', end: 'rights.offer-end',
  recognize: 'rights.offer-recognize', invalidate: 'rights.offer-invalidate',
} as const;
const eventKinds = {
  create: 'RightsOfferingCreatedEvent', end: 'RightsOfferingEndedEvent',
  recognize: 'RightsOfferingRecognizedEvent', invalidate: 'RightsOfferingInvalidatedEvent',
} as const;

export class RightsOfferingInvalid extends Error {}
export class RightsOfferingDenied extends Error {}
export class RightsOfferingStale extends Error {}
export class RightsOfferingUnavailable extends Error {}

export interface CreateOffering {
  target: string; instrument: string; actingSubject: string; idempotencyKey: string;
}
export interface ChangeOffering {
  offering: string; action: 'end' | 'recognize' | 'invalidate'; actingSubject: string;
  expectedOfferingHead: string; expectedRecognitionHead: string | null; idempotencyKey: string;
}
export interface OfferingView {
  offering: string; target: string; instrument: string; declaration: string; slot: string;
  offeringHead: string; state: 'open' | 'ended'; recognitionHead: string | null;
  recognition: 'recognized' | 'invalidated' | null;
}
export interface OfferingRevisionView {
  offering: string; revision: string; kind: 'offering' | 'recognition';
  state: 'open' | 'ended' | 'recognized' | 'invalidated'; predecessor: string | null;
  actor: string; dataEpoch: string; sequence: string;
}
export interface OfferingReceipt {
  receipt: string; outcome: 'succeeded' | 'cancelled'; admissionId: string; requestDigest: string;
  authorityEpoch: string; scope: string; dataEpoch: string; sequence: string;
  offering?: string; revision?: string; action?: string;
}

export function offeringReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0rights-offering-v1`)}`;
}

function offeringSlot(target: string, instrument: string): string {
  return `urn:rezics:rights-slot:${hash(`${target}\0${instrument}`)}`;
}

function digestOf(value: Record<string, unknown>): string {
  return hash(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))));
}

export async function readOfferingReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<OfferingReceipt | null> {
  const receipt = offeringReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?digest ?id ?epoch ?scope
    ?dataEpoch ?sequence ?offering ?revision ?action WHERE { GRAPH ${iri(GRAPHS.receipts)} {
    ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ; rv:requestDigest ?digest ;
      rv:admissionId ?id ; rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ;
      rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
    OPTIONAL { ${iri(receipt)} rv:rightsOffering ?offering ; rv:rightsRevision ?revision ; rv:action ?action }
  } }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const value = (name: string) => row[name]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id') || !value('epoch')
    || !value('scope') || !value('dataEpoch') || !/^[1-9][0-9]*$/.test(value('sequence') ?? '')
    || (outcome === 'succeeded' && (!value('offering') || !value('revision') || !value('action')))) {
    throw new RightsOfferingUnavailable('rights offering receipt is incomplete');
  }
  return { receipt, outcome, admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!, dataEpoch: value('dataEpoch')!,
    sequence: value('sequence')!, ...(outcome === 'succeeded' ? {
      offering: value('offering'), revision: value('revision'), action: value('action') } : {}) };
}

function checked(receipt: OfferingReceipt, admission: RegisteredAdmission, action: string): OfferingReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== admission.requestDigest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope
    || receipt.outcome === 'succeeded' && receipt.action !== action) {
    throw new IdempotencyConflict('rights offering receipt differs from admission');
  }
  if (receipt.outcome === 'cancelled') throw new RightsOfferingStale('rights offering state changed');
  return receipt;
}

export async function readOffering(env: WorkActivationEnvironment, offering: string): Promise<OfferingView | null> {
  if (!nativeId.test(offering)) throw new RightsOfferingInvalid('invalid rights offering identity');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?slot ?target ?instrument ?declaration
    ?head ?state ?recognitionHead ?recognition WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(offering)} a rv:RightsOffering ; rv:slot ?slot ; rv:declaration ?declaration ;
        rv:offeringHead ?head .
      ?slot a rv:RightsOfferingSlot ; rv:target ?target ; rv:instrument ?instrument .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?head a rv:RightsOfferingRevision ; rv:offeringState ?state .
    }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(offering)} rv:recognitionHead ?recognitionHead }
      GRAPH ${iri(GRAPHS.revisions)} { ?recognitionHead a rv:RightsRecognitionRevision ;
        rv:recognitionState ?recognition } }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const value = (name: string) => row[name]?.value;
  const state = value('state') === `${RV}Open` ? 'open' : value('state') === `${RV}Ended` ? 'ended' : null;
  const recognition = value('recognition') === `${RV}Recognized` ? 'recognized'
    : value('recognition') === `${RV}Invalidated` ? 'invalidated' : null;
  if (rows.length !== 1 || !state || !value('slot') || !value('target') || !value('instrument')
    || !value('declaration') || !value('head') || Boolean(value('recognitionHead')) !== Boolean(recognition)) {
    throw new RightsOfferingUnavailable('rights offering state is incomplete');
  }
  return { offering, target: value('target')!, instrument: value('instrument')!, declaration: value('declaration')!,
    slot: value('slot')!, offeringHead: value('head')!, state,
    recognitionHead: value('recognitionHead') ?? null, recognition };
}

/** Exact immutable history read; the caller's current target authority is checked at the route. */
export async function readOfferingRevision(env: WorkActivationEnvironment, offering: string,
  revision: string): Promise<OfferingRevisionView | null> {
  if (!nativeId.test(offering) || !nativeId.test(revision)) {
    throw new RightsOfferingInvalid('invalid rights offering revision identity');
  }
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?kind ?state ?predecessor ?actor
    ?dataEpoch ?sequence WHERE { GRAPH ${iri(GRAPHS.revisions)} {
    VALUES ?kind { rv:RightsOfferingRevision rv:RightsRecognitionRevision }
    ${iri(revision)} a ?kind ; rv:offering ${iri(offering)} ; rv:modelRevision ${iri(profile)} ;
      rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
    OPTIONAL { ${iri(revision)} rv:offeringState ?offeringState }
    OPTIONAL { ${iri(revision)} rv:recognitionState ?recognitionState }
    OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
    OPTIONAL { ${iri(revision)} rv:changedBy ?changedBy }
    OPTIONAL { ${iri(revision)} rv:decidedBy ?decidedBy }
    BIND(COALESCE(?offeringState, ?recognitionState) AS ?state)
    BIND(COALESCE(?changedBy, ?decidedBy) AS ?actor)
  } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const value = (name: string) => row[name]?.value;
  const kind = value('kind') === `${RV}RightsOfferingRevision` ? 'offering'
    : value('kind') === `${RV}RightsRecognitionRevision` ? 'recognition' : null;
  const state = value('state') === `${RV}Open` ? 'open' : value('state') === `${RV}Ended` ? 'ended'
    : value('state') === `${RV}Recognized` ? 'recognized'
      : value('state') === `${RV}Invalidated` ? 'invalidated' : null;
  if (rows.length !== 1 || !kind || !state || !value('actor') || !value('dataEpoch')
    || !/^[1-9][0-9]*$/.test(value('sequence') ?? '')
    || (kind === 'offering') !== (state === 'open' || state === 'ended')) {
    throw new RightsOfferingUnavailable('rights offering revision is incomplete');
  }
  return { offering, revision, kind, state, predecessor: value('predecessor') ?? null,
    actor: value('actor')!, dataEpoch: value('dataEpoch')!, sequence: value('sequence')! };
}

async function sealStale(env: WorkActivationEnvironment, admission: RegisteredAdmission): Promise<OfferingReceipt> {
  const receipt = offeringReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0stale`)}`;
  await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest, validations: [], deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:outcome rv:Cancelled ; rv:reason rv:StaleHead ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` });
  const result = await readOfferingReceipt(env, admission.id);
  if (!result) throw new PendingActivation('rights offering cancellation needs reconciliation');
  return result;
}

function receiptTriples(admission: RegisteredAdmission, receipt: string, operation: string,
  offering: string, revision: string, action: string, epoch: string): string {
  return `${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
    rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
    rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
    rv:outcome rv:Succeeded ; rv:action ${lit(action)} ; rv:rightsOffering ${iri(offering)} ;
    rv:rightsRevision ${iri(revision)} ; rv:datasetId ${iri(DATASET)} ;
    rv:dataEpoch ${lit(epoch)} ; rv:sequence ?next .`;
}

function eventTriples(kind: string, action: string, receipt: string, offering: string,
  revision: string, operation: string): string {
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  return `${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ?epoch ; rv:sequence ?next ;
      rv:eventCount 1 ; rv:event ${iri(event)} .
    ${iri(event)} a rv:${kind} ; rv:ordinal 0 ; rv:action ${lit(action)} ;
      rv:receipt ${iri(receipt)} ; rv:rightsOffering ${iri(offering)} ; rv:rightsRevision ${iri(revision)} .`;
}

async function createGraph(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: CreateOffering): Promise<OfferingReceipt | null> {
  const receipt = offeringReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  const existing = await readOfferingReceipt(env, admission.id);
  if (existing) return existing;
  const slot = offeringSlot(input.target, input.instrument);
  const offering = ID + Bun.randomUUIDv7();
  const declaration = ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await profileValidations(env.fuseki, 'rights-offering-v1', [
    { shape: `${profile}/declaration-shape`, focus: [declaration], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${profile}/slot-shape`, focus: [slot], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${profile}/offering-shape`, focus: [offering], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${profile}/offering-revision-shape`, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const action = actions.create;
  const event = eventTriples(eventKinds.create, action, receipt, offering, revision, operation)
    .replace('rv:dataEpoch ?epoch', `rv:dataEpoch ${lit(env.lineage.dataEpoch)}`);
  const result = await validatedCommand(env, { receipt, digest: admission.requestDigest, validations,
    deadlineMs: 10_000, update: `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(slot)} a rv:RightsOfferingSlot ; rv:target ${iri(input.target)} ;
          rv:instrument ${externalIri(input.instrument)} ; rv:openOffering ${iri(offering)} .
        ${iri(offering)} a rv:RightsOffering ; rv:slot ${iri(slot)} ;
          rv:declaration ${iri(declaration)} ; rv:offeringHead ${iri(revision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(declaration)} a rv:RightsDeclaration, rv:RevisionAnchor ; rv:target ${iri(input.target)} ;
          rv:declarationScope ${iri(input.target)} ; rv:instrument ${externalIri(input.instrument)} ;
          rv:grantorKnowledge rv:Known ; rv:declaredBy ${iri(input.actingSubject)} ;
          rv:provenance ${iri(operation)} ; rv:declarationOrigin rv:NativeDeclaration ;
          rv:operation ${iri(operation)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:modelRevision ${iri(profile)} .
        ${iri(revision)} a rv:RightsOfferingRevision, rv:RevisionAnchor ;
          rv:offering ${iri(offering)} ; rv:offeringState rv:Open ;
          rv:changedBy ${iri(input.actingSubject)} ; rv:operation ${iri(operation)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
          rv:modelRevision ${iri(profile)} .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${receiptTriples(admission, receipt, operation, offering, revision, action, env.lineage.dataEpoch)}
      }
      GRAPH ${iri(GRAPHS.outbox)} { ${event} }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.target)} a schema:CreativeWork ; rv:head ?targetHead } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:openOffering ?open } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
  if (result.status === 'unknown-profile') throw new CommandRejected(result);
  if (result.status === 'invalid') throw new RightsOfferingInvalid('rights offering shape is invalid');
  return readOfferingReceipt(env, admission.id);
}

async function changeGraph(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: ChangeOffering): Promise<OfferingReceipt | null> {
  const receipt = offeringReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, receipt);
  const existing = await readOfferingReceipt(env, admission.id);
  if (existing) return existing;
  const current = await readOffering(env, input.offering);
  if (!current || current.offeringHead !== input.expectedOfferingHead
    || current.recognitionHead !== input.expectedRecognitionHead || current.state !== 'open'
    || input.action === 'invalidate' && current.recognition !== 'recognized') return null;
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const action = actions[input.action];
  const offered = input.action === 'end';
  const validations = await profileValidations(env.fuseki, 'rights-offering-v1', [
    { shape: `${profile}/${offered ? 'offering' : 'recognition'}-revision-shape`,
      focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${profile}/offering-shape`, focus: [input.offering], graphs: [GRAPHS.current, GRAPHS.revisions] },
    ...(offered ? [{ shape: `${profile}/slot-shape`, focus: [current.slot],
      graphs: [GRAPHS.current, GRAPHS.revisions] }] : []),
  ]);
  const recognitionGuard = input.expectedRecognitionHead
    ? `${iri(input.offering)} rv:recognitionHead ${iri(input.expectedRecognitionHead)} .`
    : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.offering)} rv:recognitionHead ?recognition } }`;
  const event = eventTriples(eventKinds[input.action], action, receipt, input.offering, revision, operation)
    .replace('rv:dataEpoch ?epoch', `rv:dataEpoch ${lit(env.lineage.dataEpoch)}`);
  const result = await validatedCommand(env, { receipt, digest: admission.requestDigest, validations,
    deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.offering)} ${offered ? 'rv:offeringHead' : 'rv:recognitionHead'}
          ${iri(offered ? input.expectedOfferingHead : input.expectedRecognitionHead ?? revision)} .
        ${offered ? `${iri(current.slot)} rv:openOffering ${iri(input.offering)} .` : ''}
      }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.offering)} ${offered ? 'rv:offeringHead' : 'rv:recognitionHead'} ${iri(revision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:${offered ? 'RightsOfferingRevision' : 'RightsRecognitionRevision'}, rv:RevisionAnchor ;
          rv:offering ${iri(input.offering)} ;
          rv:${offered ? 'offeringState rv:Ended' : `recognitionState rv:${input.action === 'recognize' ? 'Recognized' : 'Invalidated'}`} ;
          ${offered ? 'rv:changedBy' : 'rv:decidedBy'} ${iri(input.actingSubject)} ;
          ${offered || input.expectedRecognitionHead ? `rv:predecessor ${iri(offered
            ? input.expectedOfferingHead : input.expectedRecognitionHead!)} ;` : ''}
          rv:operation ${iri(operation)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:modelRevision ${iri(profile)} .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${receiptTriples(admission, receipt, operation, input.offering, revision, action, env.lineage.dataEpoch)}
      }
      GRAPH ${iri(GRAPHS.outbox)} { ${event} }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.offering)} a rv:RightsOffering ; rv:offeringHead ${iri(input.expectedOfferingHead)} .
        ${iri(current.slot)} rv:openOffering ${iri(input.offering)} .
        ${input.expectedRecognitionHead ? recognitionGuard : ''}
      }
      ${input.expectedRecognitionHead ? '' : recognitionGuard}
      ${input.action === 'invalidate' ? `GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.expectedRecognitionHead!)} rv:recognitionState rv:Recognized . }` : ''}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
  if (result.status === 'unknown-profile') throw new CommandRejected(result);
  if (result.status === 'invalid') throw new RightsOfferingInvalid('rights offering shape is invalid');
  return readOfferingReceipt(env, admission.id);
}

type Access = Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>;

async function admitted(env: WorkActivationEnvironment, account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Access, request: Request, operation: { action: keyof typeof actions; scope: string;
    actingSubject: string; idempotencyKey: string; digest: string },
  write: (admission: RegisteredAdmission) => Promise<OfferingReceipt | null>): Promise<OfferingReceipt & {
    replayed: boolean }> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, [operation.action === 'recognize' || operation.action === 'invalidate'
    ? 'rights:decide' : 'rights:offer']);
  const registered = await access.register({ principal, actingSubject: operation.actingSubject,
    scope: operation.scope, action: actions[operation.action], idempotencyKey: operation.idempotencyKey,
    requestDigest: operation.digest });
  let receipt: OfferingReceipt | null = null;
  try {
    if (registered.state === 'sealed') receipt = await readOfferingReceipt(env, registered.id);
    else {
      let claim = registered;
      if (registered.dispatchEligible) {
        try { claim = await access.claim(registered.id, operation.digest); }
        catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
      }
      if (claim.state === 'claimed') {
        try { receipt = await write(claim); }
        catch (error) {
          receipt = await readOfferingReceipt(env, registered.id);
          if (!receipt) throw error;
        }
      }
      if (!receipt) receipt = await sealStale(env, claim);
    }
    if (!receipt) throw new PendingActivation('rights offering receipt needs reconciliation');
    await access.recordGraphOutcome(registered.id, receipt);
    return { ...checked(receipt, registered, actions[operation.action]), replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof RightsOfferingStale
      || error instanceof RightsOfferingInvalid || error instanceof CancelledActivation) throw error;
    throw new PendingActivation('rights offering outcome needs reconciliation with the same key');
  }
}

export function createAdmittedOffering(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>, access: Access, request: Request,
  input: CreateOffering): Promise<OfferingReceipt & { replayed: boolean }> {
  if (!nativeId.test(input.target) || !nativeId.test(input.actingSubject)
    || !instrumentId.test(input.instrument) || !keyPattern.test(input.idempotencyKey)) {
    throw new RightsOfferingInvalid('invalid rights offering request');
  }
  return admitted(env, account, access, request, { action: 'create', scope: `rights:offer:${input.target}`,
    actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey,
    digest: digestOf({ target: input.target, instrument: input.instrument, actingSubject: input.actingSubject }) },
  admission => createGraph(env, admission, input));
}

export function changeAdmittedOffering(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>, access: Access, request: Request,
  input: ChangeOffering): Promise<OfferingReceipt & { replayed: boolean }> {
  if (!nativeId.test(input.offering) || !nativeId.test(input.actingSubject)
    || !nativeId.test(input.expectedOfferingHead)
    || input.expectedRecognitionHead !== null && !nativeId.test(input.expectedRecognitionHead)
    || !['end', 'recognize', 'invalidate'].includes(input.action) || !keyPattern.test(input.idempotencyKey)) {
    throw new RightsOfferingInvalid('invalid rights offering change');
  }
  const scope = input.action === 'end' ? `rights:offer:${input.offering}`
    : `rights:recognize:${input.offering}`;
  return admitted(env, account, access, request, { action: input.action, scope,
    actingSubject: input.actingSubject, idempotencyKey: input.idempotencyKey,
    digest: digestOf({ offering: input.offering, action: input.action,
      expectedOfferingHead: input.expectedOfferingHead,
      expectedRecognitionHead: input.expectedRecognitionHead, actingSubject: input.actingSubject }) },
  admission => changeGraph(env, admission, input));
}
