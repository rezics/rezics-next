import type { VerifiedPrincipal } from '../access/admission.ts';
import { canonicalRelation, readExactDefinition, type RelationPublication } from '../relation/change.ts';
import { relationAttributionVerifier, type RelationAttributionOwner } from '../relation/attribution.ts';
import { modelGenerationHeadGuard } from '../semantic/generation-guard.ts';
import { assertSemanticDispatchable, checkedSemanticTerminal, familyReceiptIri, readSemanticTerminal,
  sealComponentState, sealSemanticRejection, sendSemanticWrite, SemanticChangeRejected,
  StaleSemanticHead, type SemanticAdmission, type SemanticTerminal } from '../semantic/command.ts';
import { systemDisclosure } from '../target/disclosed-references.ts';
import { GRAPHS, ID, PendingActivation, hash, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { creditAttributionOwner, creditOwnerGuard } from './credit-attribution.ts';
import { canonicalCreditValue, checkedRetainedCreditAssociationState, creditNativeId,
  retainedCreditAssociationDigest, RETAINED_CREDIT_ASSOCIATIONS, RETAINED_CREDIT_ASSOCIATIONS_PROFILE,
  type RetainedCreditAssociationState, type RetainedCreditParticipation } from './credit-association-state.ts';
import { fenceRetainedCreditIdentityRead, openRetainedCreditIdentityRead,
  readRetainedCreditAssociationHead, readSealedRetainedCreditAssociation,
  verifyRetainedCreditAssociationState, RetainedCreditReadUnavailable, RetainedCreditReadMoved,
  type RetainedCreditAssociationReadDependencies, type RetainedCreditIdentityBasis } from './credit-association-read.ts';
import { readCreditOwnerHead, readCreditOwnerWitness } from './credit-verification.ts';

export interface RetainedCreditBindingInput {
  credit: string;
  creditRevision: string;
  work: string;
  workRevision: string;
  retainedProfile: RetainedCreditAssociationState['retainedProfile'];
  role: RetainedCreditAssociationState['role'];
  origin: RetainedCreditAssociationState['origin'];
  mapping: RetainedCreditAssociationState['mapping'];
  subject: Omit<RetainedCreditParticipation, 'id' | 'role'>;
  expectedAssociationHead: string | null;
}
export interface PreparedRetainedCreditBinding {
  state: RetainedCreditAssociationState;
  expectedAssociationHead: string | null;
  digest: string;
}
export interface RetainedCreditBindingDependencies extends RetainedCreditAssociationReadDependencies {
  canReadReference(principal: VerifiedPrincipal, reference: string): Promise<boolean>;
  /** Actual citation/field/rights owner. The credit adapter adds native identity. */
  attribution?: RelationAttributionOwner;
  /** Source/selected-publication owner guards its precise retained origin and
   * current rights/support in the same graph command. Never request data. */
  originGuard?(input: { principal: VerifiedPrincipal; state: RetainedCreditAssociationState;
    basis: RetainedCreditIdentityBasis }): Promise<string | null>;
}
export interface RetainedCreditBindingIntent {
  principal: VerifiedPrincipal;
  actingSubject: string;
  admission: SemanticAdmission;
  input: RetainedCreditBindingInput;
  /** Relation owns covered Statements, adoption and publication settlement. */
  beforeCommit?: RelationPublication;
}
export interface RetainedCreditBindingResult {
  profile: typeof RETAINED_CREDIT_ASSOCIATIONS;
  occurrence: string;
  associationHead: string;
  operation: string;
  modelGeneration: string;
  predecessor: string | null;
  compatibilityReceipt: string;
  manifest: string;
  participations: RetainedCreditParticipation[];
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  replayed: boolean;
}
export class RetainedCreditOriginConflict extends Error {
  readonly status = 409;
  readonly code = 'retained_credit_origin_ambiguous';
}
const equal = (a: unknown, b: unknown) => canonicalCreditValue(a) === canonicalCreditValue(b);
function allocation(credit: string, role: 'work' | 'subject') {
  const hex = hash(`${RETAINED_CREDIT_ASSOCIATIONS}\0${credit}\0${role}`);
  // Stable occurrence-local allocation; concurrent first admissions cannot mint
  // another set. These are participation IDs, never another credit or Agent.
  return `${ID}${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Deterministic admission input, including allocations from the exact prior
 * seal. This performs no write and grants no authority or current-head proof. */
export async function prepareRetainedCreditBinding(
  env: WorkActivationEnvironment, input: RetainedCreditBindingInput,
): Promise<PreparedRetainedCreditBinding> {
  if (input.expectedAssociationHead !== null && !creditNativeId(input.expectedAssociationHead))
    throw new SemanticChangeRejected('invalid', 'invalid expected retained credit head');
  const prior = input.expectedAssociationHead
    ? await readSealedRetainedCreditAssociation(env, input.credit, input.expectedAssociationHead) : null;
  if (prior && prior.state.work !== input.work)
    throw new SemanticChangeRejected('unavailable-reference', 'retained credit belongs to another Work');
  const workParticipation = prior?.state.workParticipation ?? allocation(input.credit, 'work');
  const subjectParticipation = prior?.state.subjectParticipation ?? allocation(input.credit, 'subject');
  const state = checkedRetainedCreditAssociationState({ profile: RETAINED_CREDIT_ASSOCIATIONS,
    credit: input.credit, creditRevision: input.creditRevision, work: input.work, workRevision: input.workRevision,
    retainedProfile: input.retainedProfile, role: input.role, origin: input.origin, mapping: input.mapping,
    workParticipation, subjectParticipation, participations: [
      { id: workParticipation, role: input.mapping.workRole, participant: { kind: 'resource', ref: input.work }, attributionSupports: [] },
      { ...input.subject, id: subjectParticipation, role: input.mapping.subjectRole },
    ], context: 'global', applicability: [], qualification: 'asserted' });
  return { state, expectedAssociationHead: input.expectedAssociationHead,
    digest: retainedCreditAssociationDigest(state, input.expectedAssociationHead) };
}

function mappingGuard(state: RetainedCreditAssociationState) {
  return `GRAPH ${iri(GRAPHS.current)} { ${iri(state.mapping.definition)} rv:definitionHead ${iri(state.mapping.revision)} }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(state.mapping.revision)} rv:lifecycle rv:Active .
      FILTER NOT EXISTS { ${iri(state.mapping.revision)} a rv:ErasedRevision } }`;
}
async function verifyBinding(deps: RetainedCreditBindingDependencies, intent: RetainedCreditBindingIntent,
  prepared: PreparedRetainedCreditBinding) {
  const { state } = prepared;
  const basis = await openRetainedCreditIdentityRead(deps, intent.principal);
  const principal = basis.principal;
  if (!await deps.canReadWork(principal, state.work)
    || !await deps.canReadReference(principal, state.mapping.definition)
    || !await deps.canReadReference(principal, intent.actingSubject))
    throw new RetainedCreditReadUnavailable('retained credit references unavailable');
  for (const part of state.participations) {
    if (part.participant.kind === 'resource' && !await deps.canReadReference(principal, part.participant.ref))
      throw new RetainedCreditReadUnavailable('retained credit participant unavailable');
  }
  const definition = await readExactDefinition(deps.environment, state.mapping.revision, systemDisclosure);
  const mapping = definition?.retainedCredit, association = definition?.association;
  if (!definition || definition.lifecycle !== 'active' || !mapping || association?.kind !== 'credit'
    || definition.definition !== state.mapping.definition || definition.workSubjectRole !== association.workRole
    || state.mapping.workRole !== `${definition.definition}/role/${association.workRole}`
    || state.mapping.subjectRole !== `${definition.definition}/role/${mapping.subjectRole}`
    || association.subjectRoles.length !== 1 || association.subjectRoles[0] !== mapping.subjectRole
    || mapping.origin !== state.retainedProfile || mapping.storedRole !== state.role
    || !equal(mapping.externalNamespace ?? null, state.mapping.externalNamespace))
    throw new SemanticChangeRejected('invalid-association-binding', 'exact retained credit mapping differs');
  if (!(await deps.environment.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK { ${mappingGuard(state)} }`)).boolean)
    throw new SemanticChangeRejected('retired-definition', 'retained credit mapping is not current');
  const canonical = canonicalRelation(definition, { profile: 'relation-change-v2', definition: definition.revision,
    participations: state.participations.map(({ id: _id, role, ...item }) => ({ ...item, role: definition.roleKeys[role]! })) });
  let nativeGuard = '';
  let requiresOriginGuard = state.origin.kind !== 'stored-credit' || state.retainedProfile === 'source-reported-credit-v1';
  if (state.retainedProfile !== 'source-reported-credit-v1' && state.origin.kind !== 'selected-publication') {
    const native = await readCreditOwnerWitness(deps.environment, state.credit);
    const head = native && await readCreditOwnerHead(deps.environment, native);
    if (!native || !head || native.value.revision !== state.creditRevision)
      throw new RetainedCreditReadUnavailable('original credit owner unavailable');
    requiresOriginGuard ||= native.receipt.sourceIntent !== state.credit;
    nativeGuard = creditOwnerGuard(native, head);
  }
  const supported = await verifyRetainedCreditAssociationState(deps, basis, state);
  if (supported.sourceValidation.some(value => value.state !== 'current'))
    throw new RetainedCreditReadUnavailable('retained credit support is withdrawn');
  const attribution = await relationAttributionVerifier(creditAttributionOwner(deps.environment, deps.attribution),
    principal, intent.actingSubject)(definition, canonical.participations.map(({ iri: _iri, node: _node, ...part }) =>
      ({ ...part, attributionSupports: part.attributionSupports ?? [] })));
  let originGuard = '';
  if (requiresOriginGuard) {
    originGuard = await deps.originGuard?.({ principal, state: structuredClone(state), basis }) ?? '';
    if (!originGuard.trim()) throw new PendingActivation('retained origin owner commit guard unavailable');
  }
  if (intent.beforeCommit && !intent.beforeCommit.guard?.trim())
    throw new PendingActivation('retained credit publication guard unavailable');
  await fenceRetainedCreditIdentityRead(deps, basis);
  return { basis, supported, guard: `${modelGenerationHeadGuard(basis.generation.generation)}
    ${mappingGuard(state)} ${nativeGuard} ${originGuard} ${attribution.guard}
    ${intent.beforeCommit ? `FILTER EXISTS ${intent.beforeCommit.guard}` : ''}` };
}

async function result(env: WorkActivationEnvironment, prepared: PreparedRetainedCreditBinding,
  intent: RetainedCreditBindingIntent, terminal: SemanticTerminal, replayed: boolean): Promise<RetainedCreditBindingResult> {
  checkedSemanticTerminal(terminal, intent.admission, prepared.digest);
  if (terminal.component !== prepared.state.credit || !creditNativeId(terminal.revision)
    || (terminal.expectedHead ?? null) !== prepared.expectedAssociationHead)
    throw new PendingActivation('retained credit receipt target differs');
  const sealed = await readSealedRetainedCreditAssociation(env, terminal.component, terminal.revision);
  if (!equal(sealed.state, prepared.state) || sealed.receipt !== terminal.receipt
    || !equal(sealed.sourcePosition, { datasetId: 'product', dataEpoch: terminal.dataEpoch, sequence: terminal.sequence }))
    throw new PendingActivation('retained credit receipt differs from immutable view');
  return { profile: RETAINED_CREDIT_ASSOCIATIONS, occurrence: terminal.component,
    associationHead: terminal.revision, predecessor: sealed.predecessor, compatibilityReceipt: terminal.receipt,
    operation: sealed.operation, modelGeneration: sealed.modelGeneration,
    manifest: sealed.manifest, participations: structuredClone(sealed.state.participations),
    sourcePosition: sealed.sourcePosition, replayed };
}

/** Called by the existing admitted relation-change-v2 route. The registered
 * work:edit admission and applicable Source owners are prerequisites;
 * request-supplied receipts, guards and witnesses are never accepted. */
async function bind(deps: RetainedCreditBindingDependencies,
  intent: RetainedCreditBindingIntent): Promise<RetainedCreditBindingResult> {
  const prepared = await prepareRetainedCreditBinding(deps.environment, intent.input);
  const { state, digest, expectedAssociationHead } = prepared;
  if (intent.admission.scope !== `work:edit:${state.work}` || intent.admission.action !== 'relation.change'
    || !creditNativeId(intent.actingSubject)) throw new SemanticChangeRejected('invalid', 'retained credit admission scope differs');
  const receipt = familyReceiptIri(intent.admission.id, RETAINED_CREDIT_ASSOCIATIONS);
  const existing = await assertSemanticDispatchable(deps.environment, intent.admission, receipt, digest);
  const verified = await verifyBinding(deps, intent, prepared);
  if (existing) {
    const committed = await result(deps.environment, prepared, intent, existing, true);
    await intent.beforeCommit?.complete?.(state.credit, receipt);
    return committed;
  }
  const stale = async (): Promise<never> => {
    const observed = await readRetainedCreditAssociationHead(deps.environment, state.credit, state.work);
    const refused = await sealSemanticRejection(deps.environment, receipt, digest, intent.admission, 'stale-head',
      observed ? `GRAPH ${iri(GRAPHS.current)} { ${iri(state.credit)} rv:associationHead ${iri(observed)} }
        FILTER(${expectedAssociationHead ? `${iri(observed)} != ${iri(expectedAssociationHead)}` : 'true'})`
        : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(state.credit)} rv:associationHead ?missingHead } }`,
      `rv:component ${iri(state.credit)} ; ${observed ? `rv:currentHead ${iri(observed)} ;` : ''}`);
    if (refused) {
      // The same admission may have won while this dispatch observed its new
      // head. Never abandon the winner's already sealed publication.
      if (refused.outcome === 'cancelled') await intent.beforeCommit?.abandon?.(receipt);
      checkedSemanticTerminal(refused, intent.admission, digest);
    }
    throw new StaleSemanticHead('expected retained credit head is stale', observed ?? undefined);
  };
  if (await readRetainedCreditAssociationHead(deps.environment, state.credit, state.work) !== expectedAssociationHead) return stale();
  // An admission has one immutable revision identity even across concurrent
  // dispatch and a lost response. Different admissions still compete on head.
  const revision = allocation(`${ID}${intent.admission.id}`, 'subject');
  const operation = `${ID}${Bun.randomUUIDv7()}`;
  const manifest = await sealComponentState(deps.environment, state.credit, RETAINED_CREDIT_ASSOCIATIONS_PROFILE, state);
  await intent.beforeCommit?.(state.credit, receipt);
  const current = await verifyBinding(deps, intent, prepared);
  if (!equal(current.supported, verified.supported) || !equal(current.basis.generation, verified.basis.generation))
    throw new RetainedCreditReadUnavailable('retained credit authority or support changed before commit');
  await sendSemanticWrite(deps.environment, { receipt, digest, admission: intent.admission,
    // This compatibility view refines an existing admitted credit. It is not a
    // second RelationOccurrence or an unregistered semantic profile mutation.
    validations: [], event: 'RetainedCreditAssociationChangedEvent',
    deletes: expectedAssociationHead ? `GRAPH ${iri(GRAPHS.current)} { ${iri(state.credit)} rv:associationHead ${iri(expectedAssociationHead)} }` : '',
    inserts: `GRAPH ${iri(GRAPHS.current)} { ${iri(state.credit)} rv:associationHead ${iri(revision)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RetainedCreditAssociationRevision, rv:RevisionAnchor ;
        rv:component ${iri(state.credit)} ; rv:work ${iri(state.work)} ; rv:creditRevision ${iri(state.creditRevision)} ;
        ${expectedAssociationHead ? `rv:predecessor ${iri(expectedAssociationHead)} ;` : ''}
        rv:operation ${iri(operation)} ; rv:manifest ${iri(manifest)} ; rv:modelGeneration ${iri(current.basis.generation.generation)} ;
        rv:modelRevision ${iri(RETAINED_CREDIT_ASSOCIATIONS_PROFILE)} ; rv:shapeRevision ${iri(RETAINED_CREDIT_ASSOCIATIONS_PROFILE)} ;
        rv:participation ${iri(state.workParticipation)}, ${iri(state.subjectParticipation)} ;
        rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch ${lit(deps.environment.lineage.dataEpoch)} ; rv:sequence ?next .
        ${state.participations.map(part => `${iri(part.id)} a rv:RetainedCreditParticipation ; rv:occurrence ${iri(state.credit)} .`).join('\n')} }`,
    where: `${current.guard}
      ${expectedAssociationHead ? `GRAPH ${iri(GRAPHS.current)} { ${iri(state.credit)} rv:associationHead ${iri(expectedAssociationHead)} }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(state.credit)} rv:associationHead ?otherAssociationHead . FILTER(?otherAssociationHead != ${iri(expectedAssociationHead)}) } }`
        : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(state.credit)} rv:associationHead ?existingAssociationHead } }`}
      ${state.participations.map(part => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(part.id)} rv:occurrence ?otherOccurrence . FILTER(?otherOccurrence != ${iri(state.credit)}) } }`).join('\n')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?revisionP ?revisionO } }`,
    receiptFields: `rv:operation ${iri(operation)} ; rv:component ${iri(state.credit)} ; rv:revision ${iri(revision)} ;
      rv:compatibilityProfile ${iri(RETAINED_CREDIT_ASSOCIATIONS_PROFILE)} ;
      ${expectedAssociationHead ? `rv:expectedHead ${iri(expectedAssociationHead)} ;` : ''}` });
  const terminal = await readSemanticTerminal(deps.environment, receipt);
  if (terminal) {
    const committed = await result(deps.environment, prepared, intent, terminal, false);
    await intent.beforeCommit?.complete?.(state.credit, receipt);
    return committed;
  }
  if (await readRetainedCreditAssociationHead(deps.environment, state.credit, state.work) !== expectedAssociationHead) return stale();
  await verifyBinding(deps, intent, prepared);
  throw new PendingActivation('retained credit compatibility receipt is not sealed');
}

export async function bindRetainedCreditAssociation(deps: RetainedCreditBindingDependencies,
  intent: RetainedCreditBindingIntent): Promise<RetainedCreditBindingResult> {
  try { return await bind(deps, intent); }
  catch (error) {
    // A concurrent dispatch of this exact admission can advance the graph
    // during a read fence or win the head race. Reconcile its actual receipt,
    // then revalidate live authority/support; never turn an authority change
    // into a successful replay merely because a historical receipt exists.
    if (!(error instanceof RetainedCreditReadMoved || error instanceof StaleSemanticHead || error instanceof PendingActivation)) throw error;
    const prepared = await prepareRetainedCreditBinding(deps.environment, intent.input);
    const receipt = familyReceiptIri(intent.admission.id, RETAINED_CREDIT_ASSOCIATIONS);
    const terminal = await readSemanticTerminal(deps.environment, receipt);
    if (!terminal || terminal.outcome !== 'succeeded') throw error;
    checkedSemanticTerminal(terminal, intent.admission, prepared.digest);
    await verifyBinding(deps, intent, prepared);
    const committed = await result(deps.environment, prepared, intent, terminal, true);
    await intent.beforeCommit?.complete?.(prepared.state.credit, receipt);
    return committed;
  }
}
