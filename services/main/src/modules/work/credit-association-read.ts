import type { VerifiedPrincipal } from '../access/admission.ts';
import {
  AccountAssertionDenied,
  type VerifiedAccountAssertion,
} from '../account/verify-assertion.ts';
import { familyReceiptIri, readComponent } from '../semantic/command.ts';
import {
  readActiveModelGeneration,
  type ActiveModelGeneration,
} from '../semantic/generation-guard.ts';
import {
  canonicalCreditValue,
  checkedRetainedCreditAssociationState,
  creditNativeId,
  creditReceiptId,
  retainedCreditAssociationDigest,
  RETAINED_CREDIT_ASSOCIATIONS,
  RETAINED_CREDIT_ASSOCIATIONS_PROFILE,
  type CreditAttributionField,
  type CreditAttributionSupport,
  type RetainedCreditAssociationState,
  type RetainedCreditMapping,
  type RetainedCreditOrigin,
  type RetainedCreditParticipation,
} from './credit-association-state.ts';
import {
  readCreditOwnerHead,
  readCreditOwnerWitness,
  type CreditOwnerWitness,
} from './credit-verification.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, type WorkActivationEnvironment } from './activate.ts';

export class RetainedCreditReadUnavailable extends Error {}
export class RetainedCreditReadMoved extends Error {}
/** A missing concrete origin owner is distinct from an ambiguous legacy ID. */
export class RetainedCreditOriginUnavailable extends RetainedCreditReadUnavailable {
  readonly code = 'retained_credit_origin_unavailable';
  constructor(readonly owner: 'source-credit' | 'source-binding' | 'selected-publication' | 'attribution',
    readonly reference: string) { super(`retained credit ${owner} owner unavailable`); }
}
export interface RetainedCreditSourcePosition {
  datasetId: 'product';
  dataEpoch: string;
  sequence: string;
}
export interface RetainedCreditActivation {
  profile: typeof RETAINED_CREDIT_ASSOCIATIONS;
  generation: string;
  revision: string;
  receipt: string;
  coverageRevision: string;
  coverageReceipt: string;
  complete: true;
}
/** Serializable continuation identity. Live authority and token expiry belong
 * to this request's read basis, never its cursor or returned owner position. */
export interface RetainedCreditIdentityPosition {
  sourcePosition: RetainedCreditSourcePosition;
  generation: ActiveModelGeneration;
  reader: Omit<VerifiedAccountAssertion, 'currentAssertion' | 'accountExpiresAt'>;
}
export interface RetainedCreditIdentityBasis extends RetainedCreditIdentityPosition {
  principal: VerifiedPrincipal;
}
/** Public hydration additionally requires independently completed activation. */
export interface RetainedCreditAssociationReadPosition extends RetainedCreditIdentityPosition {
  activation: RetainedCreditActivation;
}
export interface RetainedCreditAssociationReadBasis extends RetainedCreditAssociationReadPosition {
  principal: VerifiedPrincipal;
}
export interface RetainedCreditSourceValidation {
  basis: CreditAttributionSupport['basis'];
  state: 'current' | 'withdrawn';
  receipt: string;
  validationToken: string;
  /** Actual retained field values, including explicit nulls, resolved by the
   * Source/publication owner. Missing fields never attest null or absence. */
  fields: Partial<Record<CreditAttributionField, unknown>>;
  evidence: string[];
}
export interface RetainedCreditCoverage {
  state: 'covered';
  generation: string;
  revision: string;
  receipt: string;
  adoption: string;
  complete: true;
  statements: { statement: string; revision: string; decisionRevision: string }[];
}
export interface RetainedCreditMappingValidation {
  mapping: RetainedCreditMapping;
  generation: string;
  receipt: string;
  validationToken: string;
}
/** Trusted owner operations, never request-supplied witnesses. Relation owns
 * authored definitions, activation and exact Statement/adoption coverage;
 * Source/publication owns retained bytes, rights and support validation. An
 * absent owner is unavailable, rather than an empty successful collection. */
export interface RetainedCreditAssociationReadOwners {
  activation?(input: {
    principal: VerifiedPrincipal;
    sourcePosition: RetainedCreditSourcePosition;
    generation: ActiveModelGeneration;
  }): Promise<RetainedCreditActivation | null>;
  mapping?(input: {
    principal: VerifiedPrincipal;
    mapping: RetainedCreditMapping;
    basis: RetainedCreditAssociationReadPosition;
  }): Promise<RetainedCreditMappingValidation | null>;
  coverage?(input: {
    principal: VerifiedPrincipal;
    view: RetainedCreditAssociationState;
    associationHead: string;
    compatibilityReceipt: string;
    basis: RetainedCreditAssociationReadPosition;
  }): Promise<RetainedCreditCoverage | { state: 'withheld' } | null>;
  attribution?(input: {
    principal: VerifiedPrincipal;
    view: RetainedCreditAssociationState;
    participation: RetainedCreditParticipation;
    support: CreditAttributionSupport;
    basis: RetainedCreditIdentityPosition;
  }): Promise<RetainedCreditSourceValidation | null>;
  /** Selected-publication and source-reported origins require their existing
   * owner; the bounded legacy credit reader must not infer those identities. */
  origin?(input: {
    principal: VerifiedPrincipal;
    view: RetainedCreditAssociationState;
    /** Resolved internally for source-derived stored credits. Its sourceIntent
     * identifies the actual Source support, without changing the public origin. */
    nativeCredit?: CreditOwnerWitness;
    basis: RetainedCreditIdentityPosition;
  }): Promise<{
    credit: string;
    creditRevision: string;
    work: string;
    workRevision: string;
    role: string;
    retainedProfile: string;
    origin: RetainedCreditOrigin;
    receipt: string;
    participations: RetainedCreditParticipation[];
    validation: RetainedCreditSourceValidation[];
  } | null>;
}
export interface RetainedCreditAssociationReadDependencies {
  environment: WorkActivationEnvironment;
  owners: RetainedCreditAssociationReadOwners;
  /** Query's existing disclosure/publication reader; this is not edit authority. */
  canReadWork(principal: VerifiedPrincipal, work: string): Promise<boolean>;
}
export interface RetainedCreditAssociationView {
  profile: typeof RETAINED_CREDIT_ASSOCIATIONS;
  /** Original credit is the occurrence identity, including exact revision reads. */
  occurrence: string;
  associationHead: string;
  currentAssociationHead: string;
  operation: string;
  modelGeneration: string;
  predecessor: string | null;
  compatibilityReceipt: string;
  admission: string;
  state: RetainedCreditAssociationState;
  mappingValidation: RetainedCreditMappingValidation;
  coverage: RetainedCreditCoverage;
  sourceValidation: RetainedCreditSourceValidation[];
  attribution: {
    participation: string;
    currentFields: CreditAttributionField[];
    unsupportedFields: CreditAttributionField[];
  }[];
  position: RetainedCreditAssociationReadPosition;
  headGuarantee: 'verified-before-commit';
}
export interface RetainedCreditAssociationCandidate {
  work: string;
  credit: string;
  associationHead: string;
}
const equal = (a: unknown, b: unknown) => canonicalCreditValue(a) === canonicalCreditValue(b);
function unavailable(message: string): never {
  throw new RetainedCreditReadUnavailable(message);
}
const sha = (value: string | undefined) =>
  !!value && /^urn:rezics:sha256:[0-9a-f]{64}$/.test(value);
const uuid = (value: string | undefined) =>
  !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const validationToken = (value: string) => /^[0-9a-f]{64}$/.test(value);
const keyOf = (item: RetainedCreditAssociationCandidate) => `${item.work}\0${item.credit}`;

function snapshotPrincipal(principal: VerifiedPrincipal): VerifiedAccountAssertion {
  const { currentAssertion, ...data } = principal;
  return { ...structuredClone(data), ...(currentAssertion ? { currentAssertion } : {}) };
}
function readerIdentity(principal: VerifiedAccountAssertion) {
  const { currentAssertion: _verify, accountExpiresAt: _expiry, ...identity } = principal;
  return structuredClone(identity);
}
export function retainedCreditIdentityPosition(
  basis: RetainedCreditIdentityPosition,
): RetainedCreditIdentityPosition {
  return structuredClone({ sourcePosition: basis.sourcePosition, generation: basis.generation, reader: basis.reader });
}
function snapshotIdentityBasis(basis: RetainedCreditIdentityBasis): RetainedCreditIdentityBasis {
  return { ...retainedCreditIdentityPosition(basis), principal: snapshotPrincipal(basis.principal) };
}
function readPosition(
  basis: RetainedCreditAssociationReadPosition,
): RetainedCreditAssociationReadPosition {
  return structuredClone({
    sourcePosition: basis.sourcePosition,
    generation: basis.generation,
    activation: basis.activation,
    reader: basis.reader,
  });
}
function snapshotBasis(
  basis: RetainedCreditAssociationReadBasis,
): RetainedCreditAssociationReadBasis {
  return { ...readPosition(basis), principal: snapshotPrincipal(basis.principal) };
}
function assertUnexpired(principal: VerifiedAccountAssertion) {
  if (
    principal.accountExpiresAt !== undefined &&
    (!Number.isSafeInteger(principal.accountExpiresAt) ||
      principal.accountExpiresAt * 1000 <= Date.now())
  ) {
    throw new AccountAssertionDenied('Account assertion expired during retained credit read');
  }
}
async function currentReader(
  basis: Pick<RetainedCreditAssociationReadBasis, 'reader' | 'principal'>,
): Promise<VerifiedPrincipal> {
  assertUnexpired(basis.principal);
  const current = basis.principal.currentAssertion
    ? await basis.principal.currentAssertion()
    : basis.principal;
  assertUnexpired(basis.principal);
  assertUnexpired(current);
  if (current.issuer !== basis.reader.issuer || current.subject !== basis.reader.subject) {
    throw new AccountAssertionDenied('Account identity changed during retained credit read');
  }
  if (!equal(readerIdentity(current), basis.reader)) {
    throw new RetainedCreditReadMoved(
      'Account consent or disclosure changed during retained credit read',
    );
  }
  // Keep the original token/scope/signal callback when an owner revalidates it.
  return snapshotPrincipal({
    ...current,
    currentAssertion: basis.principal.currentAssertion ?? current.currentAssertion,
  });
}

async function currentNativeCredit(env: WorkActivationEnvironment, credit: string) {
  let witness: CreditOwnerWitness | null;
  try {
    witness = await readCreditOwnerWitness(env, credit);
    if (!witness) return null;
    const head = await readCreditOwnerHead(env, witness);
    return head ? { witness, head } : null;
  } catch {
    return unavailable('retained native credit owner unavailable');
  }
}

async function position(env: WorkActivationEnvironment): Promise<RetainedCreditSourcePosition> {
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?epoch ?routing ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
  } LIMIT 2`,
        4096,
      )
    ).results?.bindings ?? [];
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.epoch?.value !== env.lineage.dataEpoch ||
    row.routing?.value !== env.lineage.routingEpoch ||
    !row.sequence ||
    !/^[0-9]+$/.test(row.sequence.value)
  )
    unavailable('retained credit graph position unavailable');
  return { datasetId: 'product', dataEpoch: row.epoch.value, sequence: row.sequence.value };
}
function checkedActivation(
  value: RetainedCreditActivation | null,
  generation: ActiveModelGeneration,
) {
  if (
    !value ||
    value.profile !== RETAINED_CREDIT_ASSOCIATIONS ||
    value.generation !== generation.generation ||
    !creditNativeId(value.revision) ||
    !creditReceiptId(value.receipt) ||
    !creditNativeId(value.coverageRevision) ||
    !creditReceiptId(value.coverageReceipt) ||
    value.complete !== true
  )
    unavailable('retained credit activation or coverage unavailable');
  return structuredClone(value);
}

/** Write and exact-identity reads fence real authority/model/source positions.
 * They do not assert public activation, coverage or Global adoption. */
export async function openRetainedCreditIdentityRead(
  deps: RetainedCreditAssociationReadDependencies,
  principal: VerifiedPrincipal,
): Promise<RetainedCreditIdentityBasis> {
  const authority = snapshotPrincipal(principal);
  const reader = readerIdentity(authority);
  await currentReader({ reader, principal: authority });
  const sourcePosition = await position(deps.environment);
  let generation: ActiveModelGeneration;
  try { generation = await readActiveModelGeneration(deps.environment.fuseki); }
  catch { return unavailable('retained credit model generation unavailable'); }
  const basis = { sourcePosition, generation, reader, principal: authority };
  await fenceRetainedCreditIdentityRead(deps, basis);
  return snapshotIdentityBasis(basis);
}

export async function fenceRetainedCreditIdentityRead(
  deps: RetainedCreditAssociationReadDependencies,
  supplied: RetainedCreditIdentityBasis,
): Promise<void> {
  const basis = snapshotIdentityBasis(supplied);
  await currentReader(basis);
  const currentPosition = await position(deps.environment);
  let generation: ActiveModelGeneration;
  try { generation = await readActiveModelGeneration(deps.environment.fuseki); }
  catch { return unavailable('retained credit model generation unavailable'); }
  if (!equal(currentPosition, basis.sourcePosition) || !equal(generation, basis.generation))
    throw new RetainedCreditReadMoved('retained credit source position or generation changed');
  await currentReader(basis);
}

export async function openRetainedCreditAssociationRead(
  deps: RetainedCreditAssociationReadDependencies,
  principal: VerifiedPrincipal,
): Promise<RetainedCreditAssociationReadBasis> {
  const identity = await openRetainedCreditIdentityRead(deps, principal);
  if (!deps.owners.activation) unavailable('retained credit activation owner unavailable');
  const activation = checkedActivation(await deps.owners.activation({
    principal: await currentReader(identity),
    ...structuredClone({ sourcePosition: identity.sourcePosition, generation: identity.generation }),
  }), identity.generation);
  const basis = { ...identity, activation };
  await fenceRetainedCreditAssociationRead(deps, basis);
  return snapshotBasis(basis);
}

/** Register this fence with the query-owned witness page. A continuation binds
 * these exact positions; recovery, source writes and generation changes restart
 * the read instead of looking like exhaustion. */
export async function fenceRetainedCreditAssociationRead(
  deps: RetainedCreditAssociationReadDependencies,
  supplied: RetainedCreditAssociationReadBasis,
): Promise<void> {
  const basis = snapshotBasis(supplied);
  await fenceRetainedCreditIdentityRead(deps, basis);
  if (!deps.owners.activation) unavailable('retained credit activation owner unavailable');
  const activation = checkedActivation(await deps.owners.activation({
    principal: await currentReader(basis),
    ...structuredClone({ sourcePosition: basis.sourcePosition, generation: basis.generation }),
  }), basis.generation);
  if (!equal(activation, basis.activation))
    throw new RetainedCreditReadMoved('retained credit activation or coverage changed');
  await fenceRetainedCreditIdentityRead(deps, basis);
}

/** Server-only ordered candidates, not public witnesses. Hydration applies
 * disclosure, exact origin, mapping and coverage checks. No legacy row fallback. */
export async function readRetainedCreditAssociationCandidates(
  deps: RetainedCreditAssociationReadDependencies,
  input: {
    basis: RetainedCreditAssociationReadBasis;
    works?: string[];
    after?: Pick<RetainedCreditAssociationCandidate, 'work' | 'credit'>;
    limit: number;
  },
): Promise<{ items: RetainedCreditAssociationCandidate[]; more: boolean }> {
  const basis = snapshotBasis(input.basis);
  const { works, after, limit } = structuredClone({
    works: input.works,
    after: input.after,
    limit: input.limit,
  });
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 256 ||
    (works &&
      (works.length < 1 ||
        works.length > 64 ||
        works.some((work) => !creditNativeId(work)) ||
        new Set(works).size !== works.length)) ||
    (after && (!creditNativeId(after.work) || !creditNativeId(after.credit)))
  )
    unavailable('invalid retained credit candidate selection');
  await fenceRetainedCreditAssociationRead(deps, basis);
  const rows =
    (
      await deps.environment.fuseki.query(
        `PREFIX rv: <${RV}>
    SELECT ?work ?credit ?associationHead WHERE {
      ${works ? `VALUES ?work { ${works.map(iri).join(' ')} }` : ''}
      GRAPH ${iri(GRAPHS.current)} { ?credit rv:work ?work ; rv:associationHead ?associationHead }
      ${after ? `FILTER(STR(?work) > ${lit(after.work)} || (STR(?work) = ${lit(after.work)} && STR(?credit) > ${lit(after.credit)}))` : ''}
    } ORDER BY ?work ?credit ?associationHead LIMIT ${limit + 1}`,
        256 * 1024,
      )
    ).results?.bindings ?? [];
  if (rows.length > limit + 1) unavailable('retained credit candidate bound exceeded');
  const items: RetainedCreditAssociationCandidate[] = [];
  for (const row of rows) {
    const work = row.work?.value,
      credit = row.credit?.value,
      associationHead = row.associationHead?.value;
    if (!creditNativeId(work) || !creditNativeId(credit) || !creditNativeId(associationHead))
      unavailable('invalid retained credit candidate');
    const item = { work, credit, associationHead };
    if (
      (works && !works.includes(work)) ||
      (after && keyOf(item) <= keyOf({ ...after, associationHead })) ||
      (items.length && keyOf(items.at(-1)!) >= keyOf(item))
    )
      unavailable('ambiguous or unordered retained credit candidates');
    items.push(item);
  }
  await fenceRetainedCreditAssociationRead(deps, basis);
  return { items: items.slice(0, limit), more: items.length > limit };
}

/** Server-only current compatibility head. Absence is valid only for a writer
 * preparing the first binding; public reads still require an installed view. */
export async function readRetainedCreditAssociationHead(env: WorkActivationEnvironment, credit: string, work: string): Promise<string | null> {
  if (![credit, work].every(creditNativeId)) unavailable('invalid retained credit head selection');
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?associationHead WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} rv:work ${iri(work)} ; rv:associationHead ?associationHead .
      FILTER NOT EXISTS { ${iri(credit)} rv:retiredBy ?retirement }
      FILTER NOT EXISTS { ${iri(credit)} rv:protectionHead ?protection } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?associationHead a rv:ErasedRevision } }
  } LIMIT 2`,
        4096,
      )
    ).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !creditNativeId(rows[0]?.associationHead?.value))
    unavailable('retained credit view head unavailable or ambiguous');
  return rows[0]!.associationHead!.value;
}

/** Resolve an immutable owner seal, never an inferred view of a legacy row.
 * This internal identity read does not grant disclosure or Statement coverage. */
export async function readSealedRetainedCreditAssociation(env: WorkActivationEnvironment, credit: string, head: string) {
  if (![credit, head].every(creditNativeId)) unavailable('invalid retained credit seal selection');
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}>
    SELECT ?manifest ?predecessor ?receipt ?admission ?digest ?work ?creditRevision ?epoch ?sequence ?scope ?operation ?receiptOperation ?modelGeneration WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} a rv:RetainedCreditAssociationRevision, rv:RevisionAnchor ;
        rv:component ${iri(credit)} ; rv:manifest ?manifest ; rv:work ?work ; rv:creditRevision ?creditRevision ;
        rv:modelRevision ${iri(RETAINED_CREDIT_ASSOCIATIONS_PROFILE)} ; rv:shapeRevision ${iri(RETAINED_CREDIT_ASSOCIATIONS_PROFILE)} ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(head)} rv:predecessor ?predecessor }
        OPTIONAL { ${iri(head)} rv:operation ?operation }
        OPTIONAL { ${iri(head)} rv:modelGeneration ?modelGeneration }
        FILTER NOT EXISTS { ${iri(head)} a rv:ErasedRevision } }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:component ${iri(credit)} ; rv:revision ${iri(head)} ;
        rv:compatibilityProfile ${iri(RETAINED_CREDIT_ASSOCIATIONS_PROFILE)} ; rv:requestDigest ?digest ;
        rv:admissionId ?admission ; rv:admittedScope ?scope ; rv:outcome rv:Succeeded ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ?receipt rv:operation ?receiptOperation } }
    } LIMIT 2`,
        8192,
      )
    ).results?.bindings ?? [];
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !sha(row?.manifest?.value) ||
    !uuid(row?.admission?.value) ||
    !creditReceiptId(row?.receipt?.value) ||
    row.receipt.value !== familyReceiptIri(row.admission.value, RETAINED_CREDIT_ASSOCIATIONS) ||
    !creditNativeId(row.work?.value) ||
    !creditNativeId(row.creditRevision?.value) ||
    row.scope?.value !== `work:edit:${row.work.value}` ||
    !row.epoch ||
    !row.sequence ||
    !/^[0-9]+$/.test(row.sequence.value) ||
    !row.digest ||
    !/^[0-9a-f]{64}$/.test(row.digest.value) ||
    (row.predecessor && (!creditNativeId(row.predecessor.value) || row.predecessor.value === head))
  )
    unavailable('retained credit compatibility receipt unavailable or ambiguous');
  // Historical views cannot borrow a revision/admission ID as an operation or
  // the currently active generation as their original command generation.
  if (!creditNativeId(row.operation?.value) || row.receiptOperation?.value !== row.operation.value
    || [credit, head, `${ID}${row.admission.value}`].includes(row.operation.value)
    || !/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(row.modelGeneration?.value ?? ''))
    unavailable('retained credit compatibility command metadata unavailable');
  let state: RetainedCreditAssociationState;
  try {
    state = checkedRetainedCreditAssociationState(
      await readComponent(env, row.manifest!.value, credit, RETAINED_CREDIT_ASSOCIATIONS_PROFILE),
    );
  } catch {
    return unavailable('retained credit immutable view unavailable');
  }
  const predecessor = row.predecessor?.value ?? null;
  if (
    state.credit !== credit ||
    state.work !== row.work.value ||
    state.creditRevision !== row.creditRevision.value ||
    row.digest.value !== retainedCreditAssociationDigest(state, predecessor)
  )
    unavailable('retained credit view differs from its receipt');
  return { state, predecessor, receipt: row.receipt.value, admission: row.admission.value,
    operation: row.operation.value, modelGeneration: row.modelGeneration!.value,
    manifest: row.manifest!.value, sourcePosition: { datasetId: 'product' as const,
      dataEpoch: row.epoch.value, sequence: row.sequence.value } };
}

async function originalCredit(
  deps: RetainedCreditAssociationReadDependencies,
  basis: RetainedCreditIdentityBasis,
  state: RetainedCreditAssociationState,
  principal: VerifiedPrincipal,
): Promise<RetainedCreditSourceValidation[]> {
  if (
    state.retainedProfile === 'source-reported-credit-v1' ||
    state.origin.kind === 'selected-publication'
  ) {
    if (!deps.owners.origin) unavailable('retained credit origin owner unavailable');
    const origin = await deps.owners.origin({
      principal: snapshotPrincipal(principal),
      view: structuredClone(state),
      basis: retainedCreditIdentityPosition(basis),
    });
    if (
      !origin ||
      origin.credit !== state.credit ||
      origin.creditRevision !== state.creditRevision ||
      origin.work !== state.work ||
      origin.workRevision !== state.workRevision ||
      origin.role !== state.role ||
      origin.retainedProfile !== state.retainedProfile ||
      !equal(origin.origin, state.origin) ||
      !creditReceiptId(origin.receipt) ||
      !equal(origin.participations, state.participations)
    )
      unavailable('retained credit original occurrence differs');
    return origin.validation;
  }
  const original = await currentNativeCredit(deps.environment, state.credit);
  const witness = original?.witness;
  if (
    !witness ||
    witness.profile !== state.retainedProfile ||
    witness.value.revision !== state.creditRevision ||
    witness.value.work !== state.work ||
    witness.value.expectedHead !== state.workRevision ||
    witness.value.role !== state.role
  )
    unavailable('retained credit original owner unavailable');
  const native = witness.value;
  const subject = state.participations.find((item) => item.id === state.subjectParticipation)!;
  const participant = native.agent
    ? { kind: 'resource', ref: native.agent }
    : {
        kind: 'external',
        provider: native.provider,
        namespace: native.namespace,
        key: native.sourceKey,
      };
  if (
    state.participations.length !== 2 ||
    state.context !== 'global' ||
    state.applicability.length ||
    state.qualification !== 'asserted' ||
    !equal(subject.participant, participant) ||
    subject.position !== (native.agent ? undefined : native.nativeOrdinal)
  ) {
    unavailable('retained credit original qualifications differ');
  }
  if (state.origin.kind === 'stored-credit' && witness.receipt.sourceIntent === state.credit) return [];
  // The Source owner revalidates the retained tuple and rights, including every
  // coordinate and original intent/correspondence; no provider defaults here.
  if (!deps.owners.origin) throw new RetainedCreditOriginUnavailable('source-credit', witness.receipt.sourceIntent);
  const origin = await deps.owners.origin({
    principal: snapshotPrincipal(principal),
    view: structuredClone(state),
    nativeCredit: structuredClone(witness),
    basis: retainedCreditIdentityPosition(basis),
  });
  if (
    !origin ||
    origin.credit !== state.credit ||
    origin.creditRevision !== state.creditRevision ||
    origin.work !== state.work ||
    origin.workRevision !== state.workRevision ||
    origin.role !== state.role ||
    origin.retainedProfile !== state.retainedProfile ||
    !equal(origin.origin, state.origin) ||
    origin.receipt !== witness.receipt.receipt ||
    !origin.validation.length ||
    (state.origin.kind === 'stored-credit' && !origin.validation.some(value =>
      value.basis.kind === 'source-credit' && value.basis.support === witness.receipt.sourceIntent)) ||
    !equal(origin.participations, state.participations)
  )
    unavailable('retained source binding differs');
  return origin.validation;
}

function checkedSourceValidation(
  value: RetainedCreditSourceValidation,
  support?: CreditAttributionSupport,
) {
  if (
    !value ||
    !['current', 'withdrawn'].includes(value.state) ||
    !creditReceiptId(value.receipt) ||
    !validationToken(value.validationToken) ||
    !value.fields ||
    typeof value.fields !== 'object' ||
    Array.isArray(value.fields) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 64 ||
    value.evidence.some((item) => typeof item !== 'string') ||
    (support && (!equal(value.basis, support.basis) || !equal(value.evidence, support.evidence)))
  )
    unavailable('retained attribution validation unavailable');
  return structuredClone(value);
}
async function attributions(
  deps: RetainedCreditAssociationReadDependencies,
  basis: RetainedCreditIdentityBasis,
  state: RetainedCreditAssociationState,
  principal: VerifiedPrincipal,
) {
  const validation: RetainedCreditSourceValidation[] = [];
  const attribution: RetainedCreditAssociationView['attribution'] = [];
  for (const participation of state.participations) {
    const current = new Set<CreditAttributionField>(),
      supplied = new Set<CreditAttributionField>();
    for (const support of participation.attributionSupports) {
      let result: RetainedCreditSourceValidation | null;
      if (support.basis.kind === 'native-credit') {
        const original = await currentNativeCredit(deps.environment, support.basis.credit);
        const native = original?.witness,
          head = original?.head;
        if (
          !native ||
          !head ||
          native.value.credit !== state.credit ||
          native.value.revision !== support.basis.revision ||
          native.value.work !== state.work ||
          participation.id !== state.subjectParticipation ||
          !equal(participation.participant, native.value.agent
            ? { kind: 'resource', ref: native.value.agent }
            : { kind: 'external', provider: native.value.provider, namespace: native.value.namespace, key: native.value.sourceKey }) ||
          participation.position !== (native.value.agent ? undefined : native.value.nativeOrdinal)
        )
          unavailable('native attribution basis unavailable');
        // The native receipt proves identity and its qualified tuple. Citation
        // fields and rights are a separate owner proof, including withdrawal.
        if (support.evidence.length) {
          if (!deps.owners.attribution) unavailable('native citation attribution owner unavailable');
          result = await deps.owners.attribution({ principal: snapshotPrincipal(principal),
            ...structuredClone({ view: state, participation, support }), basis: retainedCreditIdentityPosition(basis) });
        } else result = {
          basis: support.basis,
          state: 'current',
          receipt: native.receipt.receipt,
          validationToken: hash(
            canonicalCreditValue({ value: native.value, head, receipt: native.receipt }),
          ),
          fields: native.value.agent
            ? {}
            : {
                provider: native.value.provider,
                namespace: native.value.namespace,
                key: native.value.sourceKey,
              },
          evidence: [],
        };
      } else {
        if (!deps.owners.attribution) unavailable('retained attribution owner unavailable');
        result = await deps.owners.attribution({
          principal: snapshotPrincipal(principal),
          ...structuredClone({ view: state, participation, support }),
          basis: retainedCreditIdentityPosition(basis),
        });
      }
      if (!result) unavailable('retained attribution evidence unavailable');
      const proof = checkedSourceValidation(result, support);
      for (const field of support.fields) {
        const expected =
          field === 'creditedName'
            ? participation.creditedName
            : participation.sourceIdentity?.[field];
        if (!Object.hasOwn(proof.fields, field) || !equal(proof.fields[field], expected))
          unavailable('retained attribution differs from exact supported field');
        supplied.add(field);
        if (proof.state === 'current') current.add(field);
      }
      validation.push(proof);
    }
    attribution.push({
      participation: participation.id,
      currentFields: [...current].sort(),
      unsupportedFields: [...supplied].filter((field) => !current.has(field)).sort(),
    });
  }
  return { validation, attribution };
}

/** Validate the original owner and exact participation support before a bind.
 * Coverage is intentionally a separate Relation/Statement owner operation. */
export async function verifyRetainedCreditAssociationState(
  deps: RetainedCreditAssociationReadDependencies,
  basis: RetainedCreditIdentityBasis,
  supplied: RetainedCreditAssociationState,
) {
  const state = checkedRetainedCreditAssociationState(supplied);
  await fenceRetainedCreditIdentityRead(deps, basis);
  const check = async () => {
    const principal = await currentReader(basis);
    if (!await deps.canReadWork(principal, state.work)) unavailable('retained credit Work unavailable');
    const source = await originalCredit(deps, basis, state, principal);
    const supported = await attributions(deps, basis, state, principal);
    return { sourceValidation: [...source.map(value => checkedSourceValidation(value)), ...supported.validation],
      attribution: supported.attribution };
  };
  const result = await check();
  if (!equal(result, await check())) throw new RetainedCreditReadMoved('retained credit origin or support changed');
  await fenceRetainedCreditIdentityRead(deps, basis);
  return result;
}

/** Exact compatibility-head to original-credit identity for trusted Relation
 * composition/evidence reads. Public disclosure and coverage use the full view. */
export async function resolveRetainedCreditAssociationIdentity(
  deps: RetainedCreditAssociationReadDependencies,
  input: { basis: RetainedCreditIdentityBasis; credit: string; associationHead: string },
) {
  const { credit, associationHead } = input;
  const seal = await readSealedRetainedCreditAssociation(deps.environment, credit, associationHead);
  const currentAssociationHead = await readRetainedCreditAssociationHead(deps.environment, credit, seal.state.work);
  if (!currentAssociationHead) unavailable('retained credit compatibility head unavailable');
  const currentSeal = currentAssociationHead === associationHead ? seal
    : await readSealedRetainedCreditAssociation(deps.environment, credit, currentAssociationHead);
  if (currentSeal.state.work !== seal.state.work) unavailable('retained credit current head target differs');
  const validation = await verifyRetainedCreditAssociationState(deps, input.basis, seal.state);
  if (currentAssociationHead !== await readRetainedCreditAssociationHead(deps.environment, credit, seal.state.work))
    throw new RetainedCreditReadMoved('retained credit compatibility head changed');
  return { occurrence: credit, associationHead, currentAssociationHead, ...seal, ...validation,
    headGuarantee: 'verified-before-commit' as const };
}

/** Query hydrates this sealed owner view into its own AssociationWitness. It
 * must not synthesize a view from legacy rows, select a newer binding for an
 * exact read, or use withdrawal of one support to delete the native credit. */
export async function readRetainedCreditAssociationView(
  deps: RetainedCreditAssociationReadDependencies,
  input: {
    basis: RetainedCreditAssociationReadBasis;
    work: string;
    credit: string;
    associationHead?: string;
  },
): Promise<RetainedCreditAssociationView | null> {
  const basis = snapshotBasis(input.basis);
  const { work, credit, associationHead } = structuredClone({
    work: input.work,
    credit: input.credit,
    associationHead: input.associationHead,
  });
  if (
    ![work, credit].every(creditNativeId) ||
    (associationHead !== undefined && !creditNativeId(associationHead))
  )
    unavailable('invalid retained credit view selection');
  await fenceRetainedCreditAssociationRead(deps, basis);
  if (!(await deps.canReadWork(await currentReader(basis), work))) {
    await fenceRetainedCreditAssociationRead(deps, basis);
    return null;
  }
  const currentAssociationHead = await readRetainedCreditAssociationHead(deps.environment, credit, work);
  if (!currentAssociationHead) unavailable('retained credit view head unavailable');
  const head = associationHead ?? currentAssociationHead;
  const sealed = await readSealedRetainedCreditAssociation(deps.environment, credit, head);
  const { state } = sealed;
  if (state.work !== work) unavailable('retained credit target differs');
  const readOwners = async () => {
    const principal = await currentReader(basis);
    const source = await originalCredit(deps, basis, state, principal);
    if (!deps.owners.mapping || !deps.owners.coverage)
      unavailable('retained credit mapping or coverage owner unavailable');
    const mapping = await deps.owners.mapping({
      principal: snapshotPrincipal(principal),
      mapping: structuredClone(state.mapping),
      basis: readPosition(basis),
    });
    if (
      !mapping ||
      !equal(mapping.mapping, state.mapping) ||
      mapping.generation !== basis.generation.generation ||
      !creditReceiptId(mapping.receipt) ||
      !validationToken(mapping.validationToken)
    )
      unavailable('retained credit exact mapping unavailable');
    const coverage = await deps.owners.coverage({
      principal: snapshotPrincipal(principal),
      ...structuredClone({
        view: state,
        associationHead: head,
        compatibilityReceipt: sealed.receipt,
      }),
      basis: readPosition(basis),
    });
    if (coverage?.state === 'withheld') return null;
    if (
      !coverage ||
      coverage.state !== 'covered' ||
      coverage.generation !== basis.generation.generation ||
      coverage.complete !== true ||
      !creditNativeId(coverage.revision) ||
      !creditReceiptId(coverage.receipt) ||
      !creditNativeId(coverage.adoption) ||
      !Array.isArray(coverage.statements) ||
      coverage.statements.length < 1 ||
      coverage.statements.length > 512 ||
      coverage.statements.some(
        (item) => ![item.statement, item.revision, item.decisionRevision].every(creditNativeId),
      ) ||
      new Set(coverage.statements.map((item) => item.statement)).size !== coverage.statements.length
    )
      unavailable('retained credit exact Statement coverage or adoption unavailable');
    const supported = await attributions(deps, basis, state, principal);
    return {
      mappingValidation: structuredClone(mapping),
      coverage: structuredClone(coverage),
      sourceValidation: [
        ...source.map((item) => checkedSourceValidation(item)),
        ...supported.validation,
      ],
      attribution: supported.attribution,
    };
  };
  const verified = await readOwners();
  if (!verified) {
    await fenceRetainedCreditAssociationRead(deps, basis);
    return null;
  }
  // Source supports and publication/rights state may change independently of
  // the graph counter. Re-read their owner validations as well as graph heads.
  const current = await readOwners();
  if (
    !current ||
    !(await deps.canReadWork(await currentReader(basis), work)) ||
    !equal(verified, current) ||
    (await readRetainedCreditAssociationHead(deps.environment, credit, work)) !== currentAssociationHead
  ) {
    throw new RetainedCreditReadMoved('retained credit head, support, rights or coverage changed');
  }
  await fenceRetainedCreditAssociationRead(deps, basis);
  return structuredClone({
    profile: RETAINED_CREDIT_ASSOCIATIONS,
    occurrence: credit,
    associationHead: head,
    currentAssociationHead,
    operation: sealed.operation,
    modelGeneration: sealed.modelGeneration,
    predecessor: sealed.predecessor,
    compatibilityReceipt: sealed.receipt,
    admission: sealed.admission,
    state,
    ...verified,
    position: readPosition(basis),
    headGuarantee: 'verified-before-commit',
  });
}
