import type { VerifiedPrincipal } from '../access/admission.ts';
import { readExactDefinition } from '../relation/change.ts';
import { SemanticChangeRejected } from '../semantic/command.ts';
import { systemDisclosure } from '../target/disclosed-references.ts';
import { readCreditOwnerHead, readCreditOwnerWitness, type CreditOwnerWitness } from './credit-verification.ts';
import { canonicalCreditValue, creditNativeId, creditReceiptId,
  type CreditAttributionSupport, type RetainedCreditAssociationState,
  type RetainedCreditOrigin, type RetainedCreditParticipation } from './credit-association-state.ts';
import { fenceRetainedCreditIdentityRead, openRetainedCreditIdentityRead,
  retainedCreditIdentityPosition, verifyRetainedCreditAssociationState, RetainedCreditOriginUnavailable, RetainedCreditReadUnavailable,
  type RetainedCreditIdentityPosition, type RetainedCreditIdentityBasis } from './credit-association-read.ts';
import { prepareRetainedCreditBinding, type RetainedCreditBindingDependencies,
  type RetainedCreditBindingInput } from './credit-association-write.ts';

/** The existing closed public selection. No caller-provided Work, participant,
 * role, ordinal, receipt or complete owner witness is accepted here. */
export type RetainedCreditSelection =
  | { profile: 'work-author-credit-v1' | 'native-agent-credit-v1'; credit: string;
      origin: Extract<RetainedCreditOrigin, { kind: 'stored-credit' }> }
  | { profile: 'source-reported-credit-v1'; credit: string;
      origin: Exclude<RetainedCreditOrigin, { kind: 'stored-credit' }> };
export interface RetainedCreditBindingRequest {
  retained: RetainedCreditSelection;
  mappingRevision: string;
  attributionSupports: CreditAttributionSupport[];
  expectedAssociationHead: string | null;
}
type Subject = Omit<RetainedCreditParticipation, 'id' | 'role'>;
type AttributionFields = Pick<Subject, 'creditedName' | 'sourceIdentity'>;
/** Existing Source/publication owners resolve their exact selected tuple and
 * original receipt. The binding writer independently revalidates that origin
 * and its current rights/support guard; this read grants no authority. */
export interface RetainedCreditLoadedOrigin {
  retained: RetainedCreditSelection;
  work: string;
  workRevision: string;
  workHead: string;
  creditRevision: string;
  role: RetainedCreditAssociationState['role'];
  subject: Subject;
  receipt: string;
}
export interface RetainedCreditOriginLoaders {
  sourceBinding?(input: { principal: VerifiedPrincipal; basis: RetainedCreditIdentityPosition;
    retained: Extract<RetainedCreditSelection, { profile: 'source-reported-credit-v1' }> & {
      origin: Extract<RetainedCreditOrigin, { kind: 'source-binding' }> };
    attributionSupports: CreditAttributionSupport[] }): Promise<RetainedCreditLoadedOrigin | null>;
  selectedPublication?(input: { principal: VerifiedPrincipal; basis: RetainedCreditIdentityPosition;
    retained: Extract<RetainedCreditSelection, { profile: 'source-reported-credit-v1' }> & {
      origin: Extract<RetainedCreditOrigin, { kind: 'selected-publication' }> };
    attributionSupports: CreditAttributionSupport[] }): Promise<RetainedCreditLoadedOrigin | null>;
  /** Resolve only fields actually supported by these exact independent
   * citations. A native receipt cannot supply an alias, name or absence. */
  nativeAttribution?(input: { principal: VerifiedPrincipal; basis: RetainedCreditIdentityPosition;
    nativeCredit: CreditOwnerWitness; attributionSupports: CreditAttributionSupport[];
    mappingRevision: string }): Promise<AttributionFields | null>;
}
export interface RetainedCreditOriginDependencies extends RetainedCreditBindingDependencies {
  originLoaders?: RetainedCreditOriginLoaders;
}
export interface LoadedRetainedCreditBinding {
  input: RetainedCreditBindingInput;
  basis: RetainedCreditIdentityBasis;
  workHead: string;
  originalReceipt: string;
}
const equal = (a: unknown, b: unknown) => canonicalCreditValue(a) === canonicalCreditValue(b);

/** Server-only preparation for the single relation-change-v2 route. Native
 * business reads never run a converter. Source/publication selections require
 * their concrete typed owner; missing activation is irrelevant to this read. */
export async function loadRetainedCreditBinding(
  deps: RetainedCreditOriginDependencies,
  principal: VerifiedPrincipal,
  supplied: RetainedCreditBindingRequest,
): Promise<LoadedRetainedCreditBinding> {
  const request = structuredClone(supplied);
  const { retained } = request;
  if (!creditNativeId(retained.credit) || !creditNativeId(request.mappingRevision)
    || (retained.profile === 'source-reported-credit-v1') === (retained.origin.kind === 'stored-credit'))
    throw new SemanticChangeRejected('invalid', 'invalid retained credit selection');
  const basis = await openRetainedCreditIdentityRead(deps, principal);
  let original: RetainedCreditLoadedOrigin;
  if (retained.profile !== 'source-reported-credit-v1') {
    const native = await readCreditOwnerWitness(deps.environment, retained.credit);
    const head = native && await readCreditOwnerHead(deps.environment, native);
    if (!native || !head || head.creditHead !== native.value.revision || native.profile !== retained.profile
      || native.value.revision !== retained.origin.revision)
      throw new RetainedCreditReadUnavailable('exact stored credit origin unavailable');
    const fields = request.attributionSupports.length
      ? await deps.originLoaders?.nativeAttribution?.({ principal: basis.principal,
        basis: retainedCreditIdentityPosition(basis), nativeCredit: structuredClone(native),
        attributionSupports: request.attributionSupports, mappingRevision: request.mappingRevision }) : {};
    if (!fields) throw new RetainedCreditOriginUnavailable('attribution', retained.credit);
    original = { retained, work: native.value.work, workRevision: native.value.expectedHead,
      workHead: head.workHead, creditRevision: native.value.revision, role: native.value.role!,
      receipt: native.receipt.receipt, subject: { ...fields,
        participant: native.value.agent ? { kind: 'resource', ref: native.value.agent }
          : { kind: 'external', provider: native.value.provider!, namespace: native.value.namespace!, key: native.value.sourceKey },
        ...(native.value.agent ? {} : { position: native.value.nativeOrdinal }),
        attributionSupports: request.attributionSupports } };
  } else {
    const loader = deps.originLoaders;
    const selected = retained.origin.kind === 'source-binding'
      ? await loader?.sourceBinding?.({ principal: basis.principal, basis: retainedCreditIdentityPosition(basis),
        retained: { ...retained, origin: retained.origin }, attributionSupports: request.attributionSupports })
      : await loader?.selectedPublication?.({ principal: basis.principal, basis: retainedCreditIdentityPosition(basis),
        retained: { ...retained, origin: retained.origin }, attributionSupports: request.attributionSupports });
    if (!selected) throw new RetainedCreditOriginUnavailable(retained.origin.kind,
      retained.origin.kind === 'source-binding' ? retained.origin.binding : retained.origin.decision);
    if (!equal(selected.retained, retained) || !creditReceiptId(selected.receipt)
      || !creditNativeId(selected.workHead) || !equal(selected.subject.attributionSupports, request.attributionSupports))
      throw new RetainedCreditReadUnavailable('retained origin owner returned a different selection');
    original = selected;
  }
  if (!await deps.canReadWork(basis.principal, original.work)
    || !await deps.canReadReference(basis.principal, request.mappingRevision))
    throw new RetainedCreditReadUnavailable('retained credit references unavailable');
  const definition = await readExactDefinition(deps.environment, request.mappingRevision, systemDisclosure);
  const mapping = definition?.retainedCredit, association = definition?.association;
  if (!definition || definition.lifecycle !== 'active' || !mapping || association?.kind !== 'credit'
    || mapping.origin !== retained.profile || mapping.storedRole !== original.role
    || definition.workSubjectRole !== association.workRole || association.subjectRoles.length !== 1
    || association.subjectRoles[0] !== mapping.subjectRole)
    throw new SemanticChangeRejected('invalid-association-binding', 'exact retained credit mapping differs');
  const input: RetainedCreditBindingInput = {
    credit: retained.credit, creditRevision: original.creditRevision,
    work: original.work, workRevision: original.workRevision, role: original.role,
    retainedProfile: retained.profile, origin: retained.origin, subject: original.subject,
    mapping: { definition: definition.definition, revision: definition.revision,
      workRole: `${definition.definition}/role/${association.workRole}`,
      subjectRole: `${definition.definition}/role/${mapping.subjectRole}`,
      originProfile: retained.profile, originRole: original.role, externalNamespace: mapping.externalNamespace ?? null },
    expectedAssociationHead: request.expectedAssociationHead,
  };
  // Reuse the existing closed state validation and stable prior allocations.
  const prepared = await prepareRetainedCreditBinding(deps.environment, input);
  await verifyRetainedCreditAssociationState(deps, basis, prepared.state);
  await fenceRetainedCreditIdentityRead(deps, basis);
  return { input, basis, workHead: original.workHead, originalReceipt: original.receipt };
}
