import type { RegisteredAdmission } from '../access/admission.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, IdempotencyConflict,
  PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';

const WORK = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ADDRESS_GRAPH = GRAPHS.current;
const FAMILY = 'work-address-claim';
const PROFILE = 'https://rezics.com/definition/work-address-claim-v1';

export class InvalidAddressClaim extends Error {}
export class AddressClaimConflict extends Error {}
export class AddressClaimUnavailable extends Error {}

export interface WorkAddressClaimInput {
  work: string;
  slug: string;
  actingSubject: string;
}

export interface WorkAddressTerminal {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'slug-taken' | 'work-address-exists' | 'target-unavailable';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  address?: string;
  revision?: string;
  work?: string;
  slug?: string;
}

export function normalizedWorkSlug(value: string): string {
  if (typeof value !== 'string' || value.length > 64 || value.length < 1
    || !/^[A-Za-z0-9-]+$/.test(value)) throw new InvalidAddressClaim('invalid work slug');
  const normalized = value.toLowerCase();
  if (!SLUG.test(normalized)) throw new InvalidAddressClaim('invalid work slug');
  return normalized;
}

export function workAddressDigest(input: WorkAddressClaimInput): string {
  if (!WORK.test(input.work) || !WORK.test(input.actingSubject)) {
    throw new InvalidAddressClaim('invalid work address target or actor');
  }
  return hash(JSON.stringify({ family: 'work-address-claim-v1',
    namespace: 'work', normalization: 'ascii-lower-v1',
    work: input.work, slug: normalizedWorkSlug(input.slug),
    actingSubject: input.actingSubject }));
}

export function workAddressReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0${FAMILY}`)}`;
}

export async function readWorkAddressTerminal(env: WorkActivationEnvironment,
  admissionId: string): Promise<WorkAddressTerminal | null> {
  const receipt = workAddressReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?authorityEpoch ?scope ?epoch ?sequence
    ?address ?revision ?work ?slug WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} rv:outcome ?outcome ; rv:requestDigest ?digest ;
        rv:admissionId ?id ; rv:authorityEpoch ?authorityEpoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:routeBinding ?address ;
        rv:routeRevision ?revision ; rv:work ?work ; rv:normalizedSlug ?slug }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = value('reason') === `${RV}SlugTaken` ? 'slug-taken'
    : value('reason') === `${RV}WorkAddressExists` ? 'work-address-exists'
    : value('reason') === `${RV}TargetUnavailable` ? 'target-unavailable' : undefined;
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id')
    || !value('authorityEpoch') || !value('scope') || !value('epoch')
    || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (value('reason') && !reason)
    || (outcome === 'succeeded' && (!value('address') || !value('revision')
      || !value('work') || !value('slug') || reason))
    || (outcome === 'cancelled' && (value('address') || value('revision')
      || value('work') || value('slug')))) {
    throw new AddressClaimUnavailable('address receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
    dataEpoch: value('epoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { address: value('address'),
      revision: value('revision'), work: value('work'), slug: value('slug') } : {}) };
}

function checked(terminal: WorkAddressTerminal, admission: RegisteredAdmission,
  input: WorkAddressClaimInput): WorkAddressTerminal {
  if (terminal.admissionId !== admission.id || terminal.requestDigest !== admission.requestDigest
    || terminal.authorityEpoch !== admission.authorityEpoch || terminal.scope !== admission.scope) {
    throw new IdempotencyConflict('address receipt differs from admission');
  }
  if (terminal.outcome === 'cancelled') {
    if (terminal.reason === 'slug-taken' || terminal.reason === 'work-address-exists') {
      throw new AddressClaimConflict('work address is already claimed');
    }
    throw new AddressClaimUnavailable('work address target is unavailable');
  }
  if (terminal.work !== input.work || terminal.slug !== normalizedWorkSlug(input.slug)) {
    throw new IdempotencyConflict('address receipt targets another intent');
  }
  return terminal;
}

async function seal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  reason?: 'slug-taken' | 'work-address-exists' | 'target-unavailable'): Promise<WorkAddressTerminal> {
  const existing = await readWorkAddressTerminal(env, admission.id);
  if (existing) return existing;
  const receipt = workAddressReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0cancel`)}`;
  const reasonToken = reason === 'slug-taken' ? 'rv:SlugTaken'
    : reason === 'work-address-exists' ? 'rv:WorkAddressExists'
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
  const terminal = await readWorkAddressTerminal(env, admission.id);
  if (!terminal) throw new PendingActivation('address cancellation outcome unknown');
  return terminal;
}

export async function sealWorkAddressAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<WorkAddressTerminal> {
  if (admission.action !== 'address.claim' || !admission.scope.startsWith('address:claim:')) {
    throw new IdempotencyConflict('unsupported address admission');
  }
  return seal(env, admission);
}

export async function claimWorkAddress(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: WorkAddressClaimInput): Promise<WorkAddressTerminal> {
  const digest = workAddressDigest(input);
  if (admission.action !== 'address.claim' || admission.scope !== `address:claim:${input.work}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('address admission differs from intent');
  }
  const existing = await readWorkAddressTerminal(env, admission.id);
  if (existing) return checked(existing, admission, input);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('address admission expired');
  }
  const slug = normalizedWorkSlug(input.slug);
  const address = ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const receipt = workAddressReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0address`)}`;
  const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(ADDRESS_GRAPH)} { ${iri(address)} a rv:RouteBinding ;
        rv:routeNamespace "work" ; rv:normalizedSlug ${lit(slug)} ;
        rv:targetWork ${iri(input.work)} ; rv:routeState rv:Current ;
        rv:routeRevision ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ;
        rv:component ${iri(address)} ; rv:targetWork ${iri(input.work)} ;
        rv:normalizedSlug ${lit(slug)} ;
        rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
        rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
        rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
        rv:routeBinding ${iri(address)} ; rv:routeRevision ${iri(revision)} ;
        rv:work ${iri(input.work)} ; rv:normalizedSlug ${lit(slug)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
        rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:AddressClaimedEvent ; rv:ordinal 0 ;
          rv:action "address.claim" ; rv:receipt ${iri(receipt)} ;
          rv:routeBinding ${iri(address)} ; rv:work ${iri(input.work)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} a schema:CreativeWork ;
        rv:mainVersion ?main . ?main a rv:MainVersion ; rv:work ${iri(input.work)} . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(ADDRESS_GRAPH)} {
        ?claimed rv:routeNamespace "work" ; rv:normalizedSlug ${lit(slug)} . } }
      FILTER NOT EXISTS { GRAPH ${iri(ADDRESS_GRAPH)} {
        ?current rv:routeNamespace "work" ; rv:targetWork ${iri(input.work)} ;
          rv:routeState rv:Current . } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const validations = await profileValidations(env.fuseki, 'work-address-claim-v1', [
    { shape: `${PROFILE}/binding-shape`, focus: [address], graphs: [GRAPHS.current] },
    { shape: `${PROFILE}/revision-shape`, focus: [revision], graphs: [GRAPHS.revisions] },
  ]);
  let status: 'committed' | 'guard-unmatched' | 'conflict' | 'invalid'
    | 'unknown-profile' | 'deadline';
  try {
    const result = await env.fuseki.commandWithReceipt({ receipt, digest,
      update, validations, deadlineMs: 10_000 });
    status = result.status;
  } catch {
    const uncertain = await readWorkAddressTerminal(env, admission.id);
    if (uncertain) return checked(uncertain, admission, input);
    throw new PendingActivation('address command outcome unknown');
  }
  const committed = await readWorkAddressTerminal(env, admission.id);
  if (committed) return checked(committed, admission, input);
  if (status === 'conflict') throw new IdempotencyConflict('address command receipt conflict');
  if (status === 'invalid' || status === 'unknown-profile') {
    throw new AddressClaimUnavailable('address profile rejected');
  }
  if (status !== 'guard-unmatched') throw new PendingActivation('address command outcome unknown');
  const occupied = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(ADDRESS_GRAPH)} { ?address rv:routeNamespace "work" ;
      rv:normalizedSlug ${lit(slug)} . } }`);
  const alreadyAddressed = occupied.boolean ? false : (await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(ADDRESS_GRAPH)} { ?address rv:routeNamespace "work" ;
      rv:targetWork ${iri(input.work)} ; rv:routeState rv:Current . } }`)).boolean;
  return checked(await seal(env, admission,
    occupied.boolean ? 'slug-taken' : alreadyAddressed ? 'work-address-exists'
      : 'target-unavailable'), admission, input);
}

export async function resolveWorkAddress(env: WorkActivationEnvironment, rawSlug: string) {
  const slug = normalizedWorkSlug(rawSlug);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX schema: <https://schema.org/>
    SELECT ?address ?revision ?work ?main WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(ADDRESS_GRAPH)} { ?address a rv:RouteBinding ;
        rv:routeNamespace "work" ; rv:normalizedSlug ${lit(slug)} ;
        rv:targetWork ?work ; rv:routeState rv:Current ; rv:routeRevision ?revision . }
      GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork ; rv:mainVersion ?main .
        ?main a rv:MainVersion ; rv:work ?work . }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]?.address || !rows[0].revision
    || !rows[0].work || !rows[0].main) {
    throw new AddressClaimUnavailable('work address resolution is ambiguous');
  }
  return { profile: 'work-address-v1' as const, namespace: 'work' as const,
    slug, normalization: 'ascii-lower-v1' as const,
    address: rows[0].address.value, revision: rows[0].revision.value,
    work: rows[0].work.value, mainVersion: rows[0].main.value };
}
