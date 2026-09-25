import type { RegisteredAdmission } from '../access/admission.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, IdempotencyConflict,
  PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { AddressClaimConflict, AddressClaimUnavailable, InvalidAddressClaim,
  normalizedWorkSlug } from './claim.ts';

const FAMILY = 'work-address-rename';
const CLAIM = 'https://rezics.com/definition/work-address-claim-v1';
const LIFECYCLE = 'https://rezics.com/definition/work-address-lifecycle-v1';
const WORK = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface WorkAddressRenameInput {
  work: string;
  slug: string;
  newSlug: string;
  expectedRevision: string;
  actingSubject: string;
}

export interface WorkAddressRenameTerminal {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'slug-taken' | 'stale-head';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  sourceAddress?: string;
  sourceRevision?: string;
  address?: string;
  revision?: string;
  work?: string;
  slug?: string;
  oldSlug?: string;
}

export function workAddressRenameDigest(input: WorkAddressRenameInput): string {
  const slug = normalizedWorkSlug(input.slug);
  const newSlug = normalizedWorkSlug(input.newSlug);
  if (!WORK.test(input.work) || !WORK.test(input.actingSubject)
    || !WORK.test(input.expectedRevision) || slug === newSlug) {
    throw new InvalidAddressClaim('invalid Work address rename');
  }
  return hash(JSON.stringify({ family: 'work-address-rename-v1', work: input.work,
    slug, newSlug, expectedRevision: input.expectedRevision,
    actingSubject: input.actingSubject }));
}

export function workAddressRenameReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0${FAMILY}`)}`;
}

export async function readWorkAddressRenameTerminal(env: WorkActivationEnvironment,
  admissionId: string): Promise<WorkAddressRenameTerminal | null> {
  const receipt = workAddressRenameReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?authorityEpoch ?scope ?epoch ?sequence
    ?source ?sourceRevision ?address ?revision ?work ?slug ?oldSlug WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} rv:outcome ?outcome ; rv:requestDigest ?digest ;
        rv:admissionId ?id ; rv:authorityEpoch ?authorityEpoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:sourceAddress ?source ;
        rv:sourceRevision ?sourceRevision ; rv:newAddress ?address ;
        rv:newRevision ?revision ; rv:work ?work ;
        rv:normalizedSlug ?slug ; rv:oldSlug ?oldSlug }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = value('reason') === `${RV}SlugTaken` ? 'slug-taken'
    : value('reason') === `${RV}StaleHead` ? 'stale-head' : undefined;
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id')
    || !value('authorityEpoch') || !value('scope') || !value('epoch')
    || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (value('reason') && !reason)
    || (outcome === 'succeeded' && (!value('source') || !value('sourceRevision')
      || !value('address') || !value('revision') || !value('work')
      || !value('slug') || !value('oldSlug') || reason))
    || (outcome === 'cancelled' && (value('source') || value('sourceRevision')
      || value('address') || value('revision') || value('work')
      || value('slug') || value('oldSlug')))) {
    throw new AddressClaimUnavailable('address rename receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
    dataEpoch: value('epoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { sourceAddress: value('source'),
      sourceRevision: value('sourceRevision'), address: value('address'),
      revision: value('revision'), work: value('work'), slug: value('slug'),
      oldSlug: value('oldSlug') } : {}) };
}

function checked(terminal: WorkAddressRenameTerminal, admission: RegisteredAdmission,
  input: WorkAddressRenameInput): WorkAddressRenameTerminal {
  if (terminal.admissionId !== admission.id || terminal.requestDigest !== admission.requestDigest
    || terminal.authorityEpoch !== admission.authorityEpoch || terminal.scope !== admission.scope) {
    throw new IdempotencyConflict('rename receipt differs from admission');
  }
  if (terminal.outcome === 'cancelled') {
    if (terminal.reason === 'slug-taken') throw new AddressClaimConflict('new slug is taken');
    throw new AddressClaimConflict('address rename head changed');
  }
  if (terminal.work !== input.work || terminal.oldSlug !== normalizedWorkSlug(input.slug)
    || terminal.slug !== normalizedWorkSlug(input.newSlug)) {
    throw new IdempotencyConflict('rename receipt targets another intent');
  }
  return terminal;
}

async function seal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  reason?: 'slug-taken' | 'stale-head'): Promise<WorkAddressRenameTerminal> {
  const existing = await readWorkAddressRenameTerminal(env, admission.id);
  if (existing) return existing;
  const receipt = workAddressRenameReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0cancel`)}`;
  const reasonToken = reason === 'slug-taken' ? 'rv:SlugTaken'
    : reason === 'stale-head' ? 'rv:StaleHead' : null;
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
  const terminal = await readWorkAddressRenameTerminal(env, admission.id);
  if (!terminal) throw new PendingActivation('address rename cancellation outcome unknown');
  return terminal;
}

export async function sealWorkAddressRenameAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<WorkAddressRenameTerminal> {
  if (admission.action !== 'address.rename' || !admission.scope.startsWith('address:rename:')) {
    throw new IdempotencyConflict('unsupported address rename admission');
  }
  return seal(env, admission);
}

export async function renameWorkAddress(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: WorkAddressRenameInput): Promise<WorkAddressRenameTerminal> {
  const digest = workAddressRenameDigest(input);
  if (admission.action !== 'address.rename' || admission.scope !== `address:rename:${input.work}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('address rename admission differs from intent');
  }
  const existing = await readWorkAddressRenameTerminal(env, admission.id);
  if (existing) return checked(existing, admission, input);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('address rename admission expired');
  }
  const oldSlug = normalizedWorkSlug(input.slug);
  const newSlug = normalizedWorkSlug(input.newSlug);
  const source = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?address WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?address a rv:RouteBinding ;
      rv:routeNamespace "work" ; rv:normalizedSlug ${lit(oldSlug)} ;
      rv:targetWork ${iri(input.work)} ; rv:routeState rv:Current ;
      rv:routeRevision ${iri(input.expectedRevision)} . }
  } LIMIT 2`);
  const sourceRows = source.results?.bindings ?? [];
  if (sourceRows.length !== 1 || !sourceRows[0]?.address) {
    return checked(await seal(env, admission, 'stale-head'), admission, input);
  }
  const sourceAddress = sourceRows[0].address.value;
  const sourceRevision = ID + Bun.randomUUIDv7();
  const address = ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const receipt = workAddressRenameReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0rename`)}`;
  const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(sourceAddress)} rv:routeState rv:Current ;
        rv:routeRevision ${iri(input.expectedRevision)} . }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(sourceAddress)} rv:routeState rv:Redirected ;
          rv:routeRevision ${iri(sourceRevision)} ; rv:redirectWork ${iri(input.work)} .
        ${iri(address)} a rv:RouteBinding ; rv:routeNamespace "work" ;
          rv:normalizedSlug ${lit(newSlug)} ; rv:targetWork ${iri(input.work)} ;
          rv:routeState rv:Current ; rv:routeRevision ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(sourceRevision)} a rv:RevisionAnchor ; rv:component ${iri(sourceAddress)} ;
          rv:targetWork ${iri(input.work)} ; rv:normalizedSlug ${lit(oldSlug)} ;
          rv:previousRevision ${iri(input.expectedRevision)} ;
          rv:redirectWork ${iri(input.work)} ; rv:routeState rv:Redirected ;
          rv:routeChangeKind rv:Renamed ;
          rv:modelRevision ${iri(LIFECYCLE)} ; rv:shapeRevision ${iri(LIFECYCLE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(address)} ;
          rv:targetWork ${iri(input.work)} ; rv:normalizedSlug ${lit(newSlug)} ;
          rv:modelRevision ${iri(CLAIM)} ; rv:shapeRevision ${iri(CLAIM)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
        rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
        rv:sourceAddress ${iri(sourceAddress)} ; rv:sourceRevision ${iri(sourceRevision)} ;
        rv:newAddress ${iri(address)} ; rv:newRevision ${iri(revision)} ;
        rv:work ${iri(input.work)} ; rv:oldSlug ${lit(oldSlug)} ;
        rv:normalizedSlug ${lit(newSlug)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
        rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:AddressRenamedEvent ; rv:ordinal 0 ;
          rv:action "address.rename" ; rv:receipt ${iri(receipt)} ;
          rv:sourceAddress ${iri(sourceAddress)} ; rv:newAddress ${iri(address)} ;
          rv:work ${iri(input.work)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(sourceAddress)} a rv:RouteBinding ; rv:routeNamespace "work" ;
          rv:normalizedSlug ${lit(oldSlug)} ; rv:targetWork ${iri(input.work)} ;
          rv:routeState rv:Current ; rv:routeRevision ${iri(input.expectedRevision)} .
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ?main .
        ?main a rv:MainVersion ; rv:work ${iri(input.work)} . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ?occupied rv:routeNamespace "work" ; rv:normalizedSlug ${lit(newSlug)} . } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const validations = await Promise.all([
    profileValidations(env.fuseki, 'work-address-lifecycle-v1', [
      { shape: `${LIFECYCLE}/redirect-shape`, focus: [sourceAddress], graphs: [GRAPHS.current] },
      { shape: `${LIFECYCLE}/revision-shape`, focus: [sourceRevision], graphs: [GRAPHS.revisions] },
    ]),
    profileValidations(env.fuseki, 'work-address-claim-v1', [
      { shape: `${CLAIM}/binding-shape`, focus: [address], graphs: [GRAPHS.current] },
      { shape: `${CLAIM}/revision-shape`, focus: [revision], graphs: [GRAPHS.revisions] },
    ]),
  ]).then(groups => groups.flat());
  let status: 'committed' | 'guard-unmatched' | 'conflict' | 'invalid'
    | 'unknown-profile' | 'deadline';
  try { status = (await env.fuseki.commandWithReceipt({ receipt, digest,
    update, validations, deadlineMs: 10_000 })).status; }
  catch {
    const uncertain = await readWorkAddressRenameTerminal(env, admission.id);
    if (uncertain) return checked(uncertain, admission, input);
    throw new PendingActivation('address rename outcome unknown');
  }
  const committed = await readWorkAddressRenameTerminal(env, admission.id);
  if (committed) return checked(committed, admission, input);
  if (status === 'conflict') throw new IdempotencyConflict('address rename receipt conflict');
  if (status === 'invalid' || status === 'unknown-profile') {
    throw new AddressClaimUnavailable('address rename profile rejected');
  }
  if (status !== 'guard-unmatched') throw new PendingActivation('address rename outcome unknown');
  const occupied = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ?address rv:routeNamespace "work" ;
      rv:normalizedSlug ${lit(newSlug)} . } }`);
  return checked(await seal(env, admission,
    occupied.boolean ? 'slug-taken' : 'stale-head'), admission, input);
}
