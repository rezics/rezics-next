import { Value } from 'typebox/value';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { admitted, referenceReader } from '../semantic/admitted.ts';
import { familyReceiptIri, readSemanticTerminal, SemanticChangeRejected, type SemanticTerminal } from '../semantic/command.ts';
import { resolvedSemanticCapabilities } from '../semantic/selected-capability.ts';
import { PROFILES } from '../semantic/schema.ts';
import { systemDisclosure } from '../target/disclosed-references.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { CreditOwnerWitness } from '../work/credit-verification.ts';
import { creditAttributionOwner, creditOwnerParticipant, retainedCreditAttributionReader } from '../work/credit-attribution.ts';
import { canonicalCreditValue, RETAINED_CREDIT_ASSOCIATIONS, type RetainedCreditAssociationState,
  type RetainedCreditMapping } from '../work/credit-association-state.ts';
import { openRetainedCreditIdentityRead, resolveRetainedCreditAssociationIdentity,
  RetainedCreditReadUnavailable, type RetainedCreditAssociationReadOwners } from '../work/credit-association-read.ts';
import { loadRetainedCreditBinding, type RetainedCreditOriginLoaders } from '../work/credit-association-origin.ts';
import { bindRetainedCreditAssociation, prepareRetainedCreditBinding, type RetainedCreditBindingDependencies,
  type RetainedCreditBindingInput, type RetainedCreditBindingResult } from '../work/credit-association-write.ts';
import { assertIdentityParticipants, canonicalRelation, readExactDefinition, relationReferences,
  type ExactDefinition, type RelationPublication } from './change.ts';
import { retainedRelationInput, type RetainedRelationInput } from './retained-contract.ts';

/** Source/publication returns exact original values through its existing owner.
 * No caller or transport callback is accepted as a value/receipt witness. */
export type RetainedCreditOriginValue = Pick<RetainedCreditBindingInput,
  'credit' | 'creditRevision' | 'work' | 'workRevision' | 'retainedProfile' | 'role' | 'origin' | 'subject'>;
export interface RetainedRelationOwners {
  /** The same owners used for retained query hydration, without a second registry. */
  reads: RetainedCreditAssociationReadOwners;
  originLoaders?: RetainedCreditOriginLoaders;
  originGuard?: RetainedCreditBindingDependencies['originGuard'];
  /** Optional exact Relation publication settlement, never a request guard or
   * a manufactured Global adoption. An unadopted binding needs no publication. */
  publication?(input: { principal: VerifiedPrincipal; state: RetainedCreditAssociationState;
    actingSubject: string }): Promise<RelationPublication | null>;
}
declare module '../../routes/dependencies.ts' {
  interface MainWorkDependencies {
    retainedCreditRelations?: RetainedRelationOwners;
  }
}

const unavailable = (message: string): never => { throw new RetainedCreditReadUnavailable(message); };
const equal = (left: unknown, right: unknown) => canonicalCreditValue(left) === canonicalCreditValue(right);

/** Relation transport and Statement/evidence composition share the existing
 * credit owner; this adapter only supplies this request's verified reader. */
export type RetainedRelationReadDependencies = Pick<MainWorkDependencies,
  'environment' | 'access' | 'relationAttribution' | 'retainedCreditRelations'>;
export function retainedRelationDependencies(work: RetainedRelationReadDependencies, actingSubject: string): RetainedCreditBindingDependencies {
  const owners = work.retainedCreditRelations;
  if (!owners) return unavailable('retained credit relation owners unavailable');
  const attribution = creditAttributionOwner(work.environment, work.relationAttribution);
  return { environment: work.environment,
    owners: { ...owners.reads, attribution: retainedCreditAttributionReader(work.environment, attribution, actingSubject) },
    canReadWork: (reader, target) => work.access.canReadWork(reader, actingSubject, target),
    canReadReference: (reader, ref) => referenceReader(work.access, reader, actingSubject)(ref),
    ...(work.relationAttribution ? { attribution: work.relationAttribution } : {}),
    ...(owners.originGuard ? { originGuard: owners.originGuard } : {}) };
}

/** Only exact authored role keys select the compatibility mapping. Neither
 * resource types, labels nor a provider's free-form role can supply it. */
export function retainedRelationMapping(definition: ExactDefinition, input: RetainedRelationInput,
  original: RetainedCreditOriginValue): RetainedCreditMapping {
  const mapping = definition.retainedCredit, association = definition.association;
  if (definition.revision !== input.mappingRevision || definition.modelRevision !== PROFILES.definitionV2
    || definition.lifecycle !== 'active' || association?.kind !== 'credit' || !mapping
    || definition.workSubjectRole !== association.workRole || association.subjectRoles.length !== 1
    || association.subjectRoles[0] !== mapping.subjectRole
    || mapping.origin !== input.retained.profile || mapping.origin !== original.retainedProfile
    || mapping.storedRole !== original.role) {
    throw new SemanticChangeRejected('invalid-association-binding', 'exact authored retained credit mapping differs');
  }
  const participant = original.subject.participant;
  if (participant.kind === 'external' && (mapping.origin === 'source-reported-credit-v1' && !mapping.externalNamespace
    || mapping.externalNamespace && (mapping.externalNamespace.provider !== participant.provider || mapping.externalNamespace.namespace !== participant.namespace))
    || participant.kind === 'resource' && mapping.externalNamespace) {
    throw new SemanticChangeRejected('invalid-association-binding', 'exact retained credit namespace differs');
  }
  return { definition: definition.definition, revision: definition.revision,
    workRole: `${definition.definition}/role/${association.workRole}`,
    subjectRole: `${definition.definition}/role/${mapping.subjectRole}`, originProfile: mapping.origin,
    originRole: mapping.storedRole, externalNamespace: mapping.externalNamespace ?? null };
}

/** The witness has already been resolved by the native owner, including its
 * actual command receipt. This helper never reads names or invents absences. */
export function storedRetainedCreditOrigin(input: RetainedRelationInput,
  witness: CreditOwnerWitness): RetainedCreditOriginValue {
  const { retained } = input, { value } = witness;
  if (retained.origin.kind !== 'stored-credit' || retained.profile !== witness.profile
    || retained.credit !== value.credit || retained.origin.revision !== value.revision || !value.role) {
    throw new SemanticChangeRejected('unavailable-reference', 'original retained credit is unavailable');
  }
  return { credit: value.credit, creditRevision: value.revision, work: value.work,
    workRevision: value.expectedHead, retainedProfile: witness.profile, role: value.role,
    origin: structuredClone(retained.origin), subject: { participant: creditOwnerParticipant(witness),
      ...(value.agent ? {} : { position: value.nativeOrdinal }), attributionSupports: [] } };
}

export function retainedRelationBindingInput(input: RetainedRelationInput, definition: ExactDefinition,
  original: RetainedCreditOriginValue): RetainedCreditBindingInput {
  if (original.credit !== input.retained.credit || original.retainedProfile !== input.retained.profile
    || !equal(original.origin, input.retained.origin)) {
    throw new SemanticChangeRejected('unavailable-reference', 'retained origin owner returned another occurrence');
  }
  return { ...structuredClone(original), mapping: retainedRelationMapping(definition, input, original),
    expectedAssociationHead: input.expectedAssociationHead,
    subject: { ...structuredClone(original.subject), attributionSupports: structuredClone(input.attributionSupports) } };
}

/** Resolve values before registering authority; rechecks inside the actual
 * writer guard the same owner heads at commit. Never dispatch the generic
 * occurrence writer for this branch. */
export async function admittedRetainedRelationChange(work: MainWorkDependencies, request: Request,
  input: RetainedRelationInput, idempotencyKey: string): Promise<RetainedCreditBindingResult> {
  if (!Value.Check(retainedRelationInput, input)) throw new SemanticChangeRejected('invalid', 'retained credit command is closed');
  await assertGraphAdmissionOpen(work.environment.fuseki, work.environment.lineage);
  const principal = await work.account.verify(request, ['work:edit']);
  const owners = work.retainedCreditRelations;
  if (!owners) return unavailable('retained credit relation owners unavailable');
  const definition = await readExactDefinition(work.environment, input.mappingRevision, systemDisclosure);
  if (!definition) return unavailable('exact retained credit mapping unavailable');
  const deps = retainedRelationDependencies(work, input.actingSubject);
  const loaded = await loadRetainedCreditBinding({ ...deps, originLoaders: owners.originLoaders }, principal, input);
  const binding = retainedRelationBindingInput(input, definition, loaded.input);
  const prepared = await prepareRetainedCreditBinding(work.environment, binding);
  const publication = await owners.publication?.({ principal, state: structuredClone(prepared.state), actingSubject: input.actingSubject });
  if (owners.publication && !publication?.guard?.trim()) return unavailable('retained credit relation settlement owner unavailable');
  const state = canonicalRelation(definition, { profile: 'relation-change-v2', definition: input.mappingRevision,
    participations: prepared.state.participations.map(({ id: _id, role, ...part }) => ({ ...part, role: definition.roleKeys[role]! })) });
  const readable = referenceReader(work.access, principal, input.actingSubject);
  return admitted({ env: work.environment, account: work.account, access: work.access, request,
    actingSubject: input.actingSubject, idempotencyKey, action: 'relation.change', family: RETAINED_CREDIT_ASSOCIATIONS,
    scope: `work:edit:${binding.work}`, digest: prepared.digest, platformAccess: work.platformAccess,
    operationId: 'postV1RelationsChanges', selectedCapabilities: () => resolvedSemanticCapabilities(work.environment,
      [binding.credit, binding.work, definition.definition, ...state.participations.flatMap(part =>
        part.participant.kind === 'resource' ? [part.participant.ref] : [])]),
    references: async reader => {
      if (!await work.access.canReadWork(reader, input.actingSubject, binding.work))
        throw new SemanticChangeRejected('unavailable-reference', 'retained credit Work is unavailable');
      await assertIdentityParticipants(work.environment, state.participations,
        { access: work.access, principal: reader, actingSubject: input.actingSubject });
      return relationReferences(work.environment, definition, state,
        { access: work.access, principal: reader, actingSubject: input.actingSubject });
    },
    dispatch: admission => bindRetainedCreditAssociation(deps, { principal, admission, input: binding,
      actingSubject: input.actingSubject, ...(publication ? { beforeCommit: publication } : {}) }),
    readTerminal: id => readSemanticTerminal(work.environment, familyReceiptIri(id, RETAINED_CREDIT_ASSOCIATIONS)),
    result: async (terminal: SemanticTerminal, dispatched) => {
      if (!terminal.component || !terminal.revision || terminal.component !== binding.credit
        || !await readable(binding.work)) return unavailable('exact retained credit terminal unavailable');
      // A sealed Access reply still resolves the original seal and current
      // owner support. A receipt is never transformed into a new admission.
      const resolve = async (): Promise<RetainedCreditBindingResult> => {
        const basis = await openRetainedCreditIdentityRead(deps, principal);
        const exact = await resolveRetainedCreditAssociationIdentity(deps,
          { basis, credit: terminal.component!, associationHead: terminal.revision! });
        if (!equal(exact.state, prepared.state) || exact.predecessor !== input.expectedAssociationHead)
          return unavailable('retained credit replay differs from its immutable intent');
        await publication?.complete?.(exact.occurrence, exact.receipt);
        return { profile: RETAINED_CREDIT_ASSOCIATIONS, occurrence: exact.occurrence,
          associationHead: exact.associationHead, predecessor: exact.predecessor, compatibilityReceipt: exact.receipt,
          operation: exact.operation, modelGeneration: exact.modelGeneration,
          manifest: exact.manifest, participations: structuredClone(exact.state.participations),
          sourcePosition: exact.sourcePosition, replayed: true };
      };
      const current = dispatched ?? await resolve();
      if (current.occurrence !== terminal.component || current.associationHead !== terminal.revision
        || current.compatibilityReceipt !== terminal.receipt) return unavailable('retained credit terminal differs from owner receipt');
      return current;
    } });
}
