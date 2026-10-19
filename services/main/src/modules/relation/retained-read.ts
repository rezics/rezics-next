import type { VerifiedPrincipal } from '../access/admission.ts';
import { PROFILES } from '../semantic/schema.ts';
import { systemDisclosure } from '../target/disclosed-references.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { canonicalCreditValue, creditNativeId, RETAINED_CREDIT_ASSOCIATIONS_PROFILE } from '../work/credit-association-state.ts';
import { openRetainedCreditIdentityRead, openRetainedCreditAssociationRead, readRetainedCreditAssociationView, resolveRetainedCreditAssociationIdentity,
  readSealedRetainedCreditAssociation, RetainedCreditReadUnavailable,
  type RetainedCreditAssociationView, type RetainedCreditSourcePosition } from '../work/credit-association-read.ts';
import { readExactDefinition, type ExactDefinition } from './change.ts';
import { retainedRelationDependencies, type RetainedRelationReadDependencies } from './retained-change.ts';

const unavailable = (message: string): never => { throw new RetainedCreditReadUnavailable(message); };
const equal = (a: unknown, b: unknown) => canonicalCreditValue(a) === canonicalCreditValue(b);
type RetainedRelationIdentity = Awaited<ReturnType<typeof resolveRetainedCreditAssociationIdentity>>;
interface RetainedRelationSelection {
  exact: RetainedRelationIdentity;
  currentPosition: RetainedCreditSourcePosition;
  publicView: RetainedCreditAssociationView | null;
}
export interface RetainedRelationOwner extends RetainedRelationIdentity {
  definition: ExactDefinition;
  currentPosition: RetainedCreditSourcePosition;
  publicView: RetainedCreditAssociationView | null;
}

/** Indexed dispatch only. A bare original credit revision never selects its
 * newer compatibility head, and an absent seal never falls back to legacy rows. */
export async function selectRetainedRelationHead(env: WorkActivationEnvironment, credit: string, revision?: string): Promise<string | null> {
  if (!creditNativeId(credit) || revision !== undefined && !creditNativeId(revision)) return null;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    ${revision ? `VALUES ?head { ${iri(revision)} } GRAPH ${iri(GRAPHS.revisions)} {
      ?head a rv:RetainedCreditAssociationRevision ; rv:component ${iri(credit)} }`
      : `GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} rv:associationHead ?head }`}
  } LIMIT 2`, 4096)).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !creditNativeId(rows[0]?.head?.value)) return unavailable('retained credit association head unavailable or ambiguous');
  return rows[0]!.head!.value;
}

/** These are native owner metadata, never aliases for a credit, revision or
 * admission ID. Older incomplete receipts stay explicitly unavailable. */
export async function retainedRelationOwnerMetadata(env: WorkActivationEnvironment,
  credit: string, revision: string, receipt: string) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?operation ?generation WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RetainedCreditAssociationRevision ;
      rv:component ${iri(credit)} ; rv:modelRevision ${iri(RETAINED_CREDIT_ASSOCIATIONS_PROFILE)} ;
      rv:operation ?operation ; rv:modelGeneration ?generation }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:component ${iri(credit)} ; rv:revision ${iri(revision)} ; rv:operation ?operation }
  } LIMIT 2`, 4096)).results?.bindings ?? [];
  const operation = rows[0]?.operation?.value, modelGeneration = rows[0]?.generation?.value;
  if (rows.length !== 1 || !creditNativeId(operation) || !modelGeneration
    || !/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(modelGeneration))
    return unavailable('retained credit exact operation or model generation unavailable');
  return { operation, modelGeneration };
}

/** The credit owner resolves its immutable seal and current original support.
 * Current selection additionally requires exact public coverage; an exact
 * authenticated revision read grants no adoption to its sealed values. */
export async function readRetainedRelationOwner(work: RetainedRelationReadDependencies, principal: VerifiedPrincipal,
  actingSubject: string, credit: string, associationHead: string, current = false): Promise<RetainedRelationOwner | null> {
  const deps = retainedRelationDependencies(work, actingSubject);
  const read = async (): Promise<RetainedRelationSelection | null> => {
    if (!current) {
      const basis = await openRetainedCreditIdentityRead(deps, principal);
      return { exact: await resolveRetainedCreditAssociationIdentity(deps, { basis, credit, associationHead }),
        currentPosition: { ...basis.sourcePosition }, publicView: null };
    }
    const basis = await openRetainedCreditAssociationRead(deps, principal);
    const sealed = await readSealedRetainedCreditAssociation(work.environment, credit, associationHead);
    // The public owner already resolves the original credit and current field
    // supports. Do not repeat its draft identity read in the same page budget.
    const publicView = await readRetainedCreditAssociationView(deps, { basis, work: sealed.state.work, credit, associationHead });
    if (!publicView) return null;
    return { exact: { occurrence: credit, associationHead, currentAssociationHead: publicView.currentAssociationHead,
      ...sealed, sourceValidation: publicView.sourceValidation, attribution: publicView.attribution,
      headGuarantee: publicView.headGuarantee }, currentPosition: { ...basis.sourcePosition }, publicView };
  };
  const selected = await read();
  if (!selected) return null;
  const { exact, currentPosition, publicView } = selected;
  if (exact.sourceValidation.some(value => value.state !== 'current')
    || exact.attribution.some(value => value.unsupportedFields.length))
    return unavailable('retained credit original or field support withdrawn');
  const definition = await readExactDefinition(work.environment, exact.state.mapping.revision, systemDisclosure);
  const mapping = definition?.retainedCredit, association = definition?.association;
  if (!definition || definition.modelRevision !== PROFILES.definitionV2 || association?.kind !== 'credit'
    || !mapping || definition.definition !== exact.state.mapping.definition
    || definition.workSubjectRole !== association.workRole || association.subjectRoles.length !== 1
    || association.subjectRoles[0] !== mapping.subjectRole
    || exact.state.mapping.workRole !== `${definition.definition}/role/${association.workRole}`
    || exact.state.mapping.subjectRole !== `${definition.definition}/role/${mapping.subjectRole}`
    || mapping.origin !== exact.state.retainedProfile || mapping.storedRole !== exact.state.role
    || !equal(mapping.externalNamespace ?? null, exact.state.mapping.externalNamespace))
    return unavailable('retained credit exact authored mapping unavailable');
  if (current && exact.currentAssociationHead !== associationHead) return unavailable('retained credit current association head changed');
  const metadata = await retainedRelationOwnerMetadata(work.environment, credit, associationHead, exact.receipt);
  if (metadata.operation !== exact.operation || metadata.modelGeneration !== exact.modelGeneration)
    return unavailable('retained credit exact owner command metadata changed');
  return { ...exact, ...metadata, definition, currentPosition, publicView };
}
