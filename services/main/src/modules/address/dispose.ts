import type { RegisteredAdmission } from '../access/admission.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, IdempotencyConflict,
  PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { AddressClaimConflict, AddressClaimUnavailable, InvalidAddressClaim,
  normalizedWorkSlug } from './claim.ts';

const FAMILY = 'work-address-disposition';
const PROFILE = 'https://rezics.com/definition/work-address-disposition-v1';
const WORK = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export type WorkAddressDispositionInput = {
  work: string; slug: string; expectedRevision: string; actingSubject: string;
} & ({ operation: 'merge'; targetWork: string } | { operation: 'retire' });

export interface WorkAddressDispositionTerminal {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head' | 'target-unavailable';
  receipt: string; admissionId: string; requestDigest: string;
  authorityEpoch: string; scope: string; dataEpoch: string; sequence: string;
  operation?: 'merge' | 'retire'; sourceAddress?: string; revision?: string;
  work?: string; slug?: string; targetWork?: string;
}

export function workAddressDispositionDigest(input: WorkAddressDispositionInput): string {
  const slug = normalizedWorkSlug(input.slug);
  if (!WORK.test(input.work) || !WORK.test(input.actingSubject)
    || !WORK.test(input.expectedRevision)
    || (input.operation === 'merge'
      && (!WORK.test(input.targetWork) || input.targetWork === input.work))) {
    throw new InvalidAddressClaim('invalid Work address disposition');
  }
  return hash(JSON.stringify({ family: 'work-address-disposition-v1',
    operation: input.operation, work: input.work, slug,
    expectedRevision: input.expectedRevision, actingSubject: input.actingSubject,
    ...(input.operation === 'merge' ? { targetWork: input.targetWork } : {}) }));
}

export function workAddressDispositionReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0${FAMILY}`)}`;
}

export async function readWorkAddressDispositionTerminal(env: WorkActivationEnvironment,
  admissionId: string): Promise<WorkAddressDispositionTerminal | null> {
  const receipt = workAddressDispositionReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?authorityEpoch ?scope ?epoch ?sequence
    ?operation ?source ?revision ?work ?slug ?target WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} rv:outcome ?outcome ; rv:requestDigest ?digest ;
        rv:admissionId ?id ; rv:authorityEpoch ?authorityEpoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:operation ?operation ; rv:sourceAddress ?source ;
        rv:sourceRevision ?revision ; rv:work ?work ; rv:normalizedSlug ?slug .
        OPTIONAL { ${iri(receipt)} rv:redirectWork ?target } }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = value('reason') === `${RV}StaleHead` ? 'stale-head'
    : value('reason') === `${RV}TargetUnavailable` ? 'target-unavailable' : undefined;
  const operation = value('operation') === 'merge' ? 'merge'
    : value('operation') === 'retire' ? 'retire' : undefined;
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id')
    || !value('authorityEpoch') || !value('scope') || !value('epoch')
    || !/^[0-9]+$/.test(value('sequence') ?? '') || (value('reason') && !reason)
    || (outcome === 'succeeded' && (!operation || !value('source')
      || !value('revision') || !value('work') || !value('slug') || reason
      || (operation === 'merge' && !value('target'))
      || (operation === 'retire' && value('target'))))
    || (outcome === 'cancelled' && (operation || value('source')
      || value('revision') || value('work') || value('slug') || value('target')))) {
    throw new AddressClaimUnavailable('address disposition receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
    dataEpoch: value('epoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { operation, sourceAddress: value('source'),
      revision: value('revision'), work: value('work'), slug: value('slug'),
      ...(value('target') ? { targetWork: value('target') } : {}) } : {}) };
}

function checked(terminal: WorkAddressDispositionTerminal, admission: RegisteredAdmission,
  input: WorkAddressDispositionInput): WorkAddressDispositionTerminal {
  if (terminal.admissionId !== admission.id || terminal.requestDigest !== admission.requestDigest
    || terminal.authorityEpoch !== admission.authorityEpoch || terminal.scope !== admission.scope) {
    throw new IdempotencyConflict('address disposition receipt differs from admission');
  }
  if (terminal.outcome === 'cancelled') {
    throw new AddressClaimConflict(terminal.reason === 'target-unavailable'
      ? 'merge target has no current address' : 'address disposition head changed');
  }
  if (terminal.work !== input.work || terminal.slug !== normalizedWorkSlug(input.slug)
    || terminal.operation !== input.operation
    || terminal.targetWork !== (input.operation === 'merge' ? input.targetWork : undefined)) {
    throw new IdempotencyConflict('address disposition receipt targets another intent');
  }
  return terminal;
}

async function seal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  reason?: 'stale-head' | 'target-unavailable'): Promise<WorkAddressDispositionTerminal> {
  const existing = await readWorkAddressDispositionTerminal(env, admission.id);
  if (existing) return existing;
  const receipt = workAddressDispositionReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0cancel`)}`;
  const reasonToken = reason === 'stale-head' ? 'rv:StaleHead'
    : reason === 'target-unavailable' ? 'rv:TargetUnavailable' : null;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
        rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
        ${reasonToken ? `rv:reason ${reasonToken} ;` : ''}
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    update, validations: [], deadlineMs: 10_000 }); }
  catch { /* resolve an ambiguous response from the same receipt */ }
  const terminal = await readWorkAddressDispositionTerminal(env, admission.id);
  if (!terminal) throw new PendingActivation('address disposition cancellation outcome unknown');
  return terminal;
}

export async function sealWorkAddressDispositionAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<WorkAddressDispositionTerminal> {
  if (admission.action !== 'address.dispose' || !admission.scope.startsWith('address:dispose:')) {
    throw new IdempotencyConflict('unsupported address disposition admission');
  }
  return seal(env, admission);
}

export async function disposeWorkAddress(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: WorkAddressDispositionInput): Promise<WorkAddressDispositionTerminal> {
  const digest = workAddressDispositionDigest(input);
  if (admission.action !== 'address.dispose' || admission.scope !== `address:dispose:${input.work}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('address disposition admission differs from intent');
  }
  const existing = await readWorkAddressDispositionTerminal(env, admission.id);
  if (existing) return checked(existing, admission, input);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('address disposition admission expired');
  }
  const slug = normalizedWorkSlug(input.slug);
  const source = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?address WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?address a rv:RouteBinding ;
      rv:routeNamespace "work" ; rv:normalizedSlug ${lit(slug)} ;
      rv:targetWork ${iri(input.work)} ; rv:routeState rv:Current ;
      rv:routeRevision ${iri(input.expectedRevision)} . }
  } LIMIT 2`);
  const sourceRows = source.results?.bindings ?? [];
  if (sourceRows.length !== 1 || !sourceRows[0]?.address) {
    return checked(await seal(env, admission, 'stale-head'), admission, input);
  }
  const sourceAddress = sourceRows[0].address.value;
  const revision = ID + Bun.randomUUIDv7();
  const receipt = workAddressDispositionReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0dispose`)}`;
  const merging = input.operation === 'merge';
  const disposition = merging ? 'rv:Merged' : 'rv:Retired';
  const state = merging ? 'rv:Redirected' : 'rv:Retired';
  const target = merging ? iri(input.targetWork) : null;
  const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(sourceAddress)} rv:routeState rv:Current ;
        rv:routeRevision ${iri(input.expectedRevision)} . }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(sourceAddress)} rv:routeState ${state} ;
        rv:routeRevision ${iri(revision)} ; rv:routeDisposition ${disposition}
        ${target ? `; rv:redirectWork ${target}` : ''} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ;
        rv:component ${iri(sourceAddress)} ; rv:targetWork ${iri(input.work)} ;
        rv:normalizedSlug ${lit(slug)} ;
        rv:previousRevision ${iri(input.expectedRevision)} ;
        rv:routeState ${state} ; rv:routeDisposition ${disposition} ;
        ${target ? `rv:redirectWork ${target} ;` : ''}
        rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
        rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
        rv:operation ${lit(input.operation)} ; rv:sourceAddress ${iri(sourceAddress)} ;
        rv:sourceRevision ${iri(revision)} ; rv:work ${iri(input.work)} ;
        rv:normalizedSlug ${lit(slug)} ;
        ${target ? `rv:redirectWork ${target} ;` : ''}
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
        rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a ${merging ? 'rv:AddressMergedEvent' : 'rv:AddressRetiredEvent'} ;
          rv:ordinal 0 ; rv:action "address.dispose" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${lit(input.operation)} ; rv:sourceAddress ${iri(sourceAddress)} ;
          rv:work ${iri(input.work)} ${target ? `; rv:redirectWork ${target}` : ''} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(sourceAddress)} a rv:RouteBinding ; rv:routeNamespace "work" ;
          rv:normalizedSlug ${lit(slug)} ; rv:targetWork ${iri(input.work)} ;
          rv:routeState rv:Current ; rv:routeRevision ${iri(input.expectedRevision)} .
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ?main .
        ?main a rv:MainVersion ; rv:work ${iri(input.work)} .
        ${merging ? `${target} a schema:CreativeWork ; rv:mainVersion ?targetMain .
          ?targetMain a rv:MainVersion ; rv:work ${target} .
          ?targetAddress a rv:RouteBinding ; rv:routeNamespace "work" ;
            rv:targetWork ${target} ; rv:routeState rv:Current .` : ''}
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const role = merging ? 'merged' : 'retired';
  const validations = await profileValidations(env.fuseki, 'work-address-disposition-v1', [
    { shape: `${PROFILE}/${role}-route-shape`, focus: [sourceAddress], graphs: [GRAPHS.current] },
    { shape: `${PROFILE}/${role}-revision-shape`, focus: [revision], graphs: [GRAPHS.revisions] },
  ]);
  let status: 'committed' | 'guard-unmatched' | 'conflict' | 'invalid'
    | 'unknown-profile' | 'deadline';
  try { status = (await env.fuseki.commandWithReceipt({ receipt, digest,
    update, validations, deadlineMs: 10_000 })).status; }
  catch {
    const uncertain = await readWorkAddressDispositionTerminal(env, admission.id);
    if (uncertain) return checked(uncertain, admission, input);
    throw new PendingActivation('address disposition outcome unknown');
  }
  const committed = await readWorkAddressDispositionTerminal(env, admission.id);
  if (committed) return checked(committed, admission, input);
  if (status === 'conflict') throw new IdempotencyConflict('address disposition receipt conflict');
  if (status === 'invalid' || status === 'unknown-profile') {
    throw new AddressClaimUnavailable('address disposition profile rejected');
  }
  if (status !== 'guard-unmatched') throw new PendingActivation('address disposition outcome unknown');
  let reason: 'stale-head' | 'target-unavailable' = 'stale-head';
  if (merging) {
    const targetCurrent = await env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/> ASK { GRAPH ${iri(GRAPHS.current)} {
      ${target} a schema:CreativeWork ; rv:mainVersion ?main .
      ?main a rv:MainVersion ; rv:work ${target} .
      ?address a rv:RouteBinding ; rv:routeNamespace "work" ;
        rv:targetWork ${target} ; rv:routeState rv:Current . } }`);
    if (!targetCurrent.boolean) reason = 'target-unavailable';
  }
  return checked(await seal(env, admission, reason), admission, input);
}
