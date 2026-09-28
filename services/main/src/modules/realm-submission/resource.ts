import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, prepareComponent, type WorkActivationEnvironment } from '../work/activate.ts';
import { unerased } from '../work/public-patterns.ts';
import { acknowledgeSubmission, readSubmissionReceipt } from './graph.ts';
import { SubmissionMissing, SubmissionUnavailable, type ResourceSubmissionInput } from './schema.ts';

export const RESOURCE_SUBMISSION_PROFILE = 'https://rezics.com/definition/realm-submission-selection-v1';
export interface ResourceAdoption {
  kind: 'resource'; admission: RegisteredAdmission;
  input: { realm: string; target: ResourceSubmissionInput; selection: string;
    expectedHead: string | null; policy: { revision: string; mode: string } | null };
}
export const resourceSlot = (realm: string, target: ResourceSubmissionInput) =>
  `urn:rezics:realm-resource:${hash(`${realm}\0${target.kind}\0${target.kind === 'work' ? target.work : target.variant}`)}`;

/** A whole Work is a continuing relationship. An individual publication pins
 * exact bytes. Neither grants disclosure to a private draft or future chapter. */
export function resourceCandidatePattern(realm: string, target: ResourceSubmissionInput) {
  return `GRAPH ${iri(GRAPHS.current)} {
    ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
    ?space rv:realmCapability ${iri(realm)} .
    ${iri(target.work)} a <https://schema.org/CreativeWork> ; rv:head ${iri(target.workRevision)} ;
      rv:mainVersion ${iri(target.mainVersion)} .
    ${iri(target.mainVersion)} a rv:MainVersion ; rv:work ${iri(target.work)} .
    ${target.kind === 'content-publication' ? `${iri(target.variant)} a rv:ContentVariant ;
      rv:resource ${iri(target.work)} ; rv:contentPublicationHead ${iri(target.publicationDecision)} ;
      rv:publicSearchEligibilityHead ?eligibility .` : ''}
  }
  ${target.kind === 'content-publication' ? `GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(target.publicationDecision)} a rv:ContentPublicationDecision ; rv:resource ${iri(target.work)} ;
      rv:component ${iri(target.variant)} ; rv:contentRevision <urn:rezics:content:revision:${target.contentRevision}> .
    ?eligibility a rv:ContentSearchEligibilityDecision ; rv:publicationDecision ${iri(target.publicationDecision)} ;
      rv:disclosure rv:Public .
    FILTER NOT EXISTS { <urn:rezics:content:revision:${target.contentRevision}> a rv:ErasedRevision }
  }` : ''}
  ${unerased(iri(target.work))}`;
}

export async function requireResourceCandidate(env: WorkActivationEnvironment, realm: string,
  target: ResourceSubmissionInput) {
  if ((await env.fuseki.query(`PREFIX rv: <${RV}> ASK { ${resourceCandidatePattern(realm, target)} }`, 1024)).boolean !== true) {
    throw new SubmissionMissing('Exact Work or public Content publication is unavailable');
  }
}

/** One slot CAS and immutable profiled selection share the ordinary admission
 * receipt. The Access reservation is committed before this command; transport
 * loss resolves by receipt, never by repeating an unreserved side effect. */
export async function adoptResource(env: WorkActivationEnvironment, adoption: ResourceAdoption) {
  const { admission, input } = adoption;
  const existing = await readSubmissionReceipt(env, admission);
  if (existing) return existing;
  const slot = resourceSlot(input.realm, input.target);
  const guard = `${resourceCandidatePattern(input.realm, input.target)}
    GRAPH ${iri(GRAPHS.current)} { OPTIONAL { ${iri(slot)} rv:selectionHead ?prior } }
    FILTER(COALESCE(?prior, <urn:rezics:none>) = ${iri(input.expectedHead ?? 'urn:rezics:none')})
    ${input.policy ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.realm)} rv:realmPolicyHead ${iri(input.policy.revision)} ;
      rv:reviewMode ${lit(input.policy.mode)} }` : ''}`;
  if (Date.parse(admission.expiresAt) <= Date.now() || !admission.dispatchEligible) {
    return acknowledgeSubmission(env, admission, 'cancelled');
  }
  if ((await env.fuseki.query(`PREFIX rv: <${RV}> ASK { ${guard} }`, 1024)).boolean !== true) {
    return acknowledgeSubmission(env, admission, 'cancelled', { insert: '', remove: '', validations: [],
      where: `FILTER NOT EXISTS { ${guard} }` });
  }
  const manifest = prepareComponent(env.objectDirectory, slot, input, RESOURCE_SUBMISSION_PROFILE);
  const validations = await profileValidations(env.fuseki, 'realm-submission-selection-v1', [
    { shape: `${RESOURCE_SUBMISSION_PROFILE}/slot-shape`, focus: [slot], graphs: [GRAPHS.current] },
    { shape: `${RESOURCE_SUBMISSION_PROFILE}/selection-shape`, focus: [input.selection],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const target = input.target;
  return acknowledgeSubmission(env, admission, 'succeeded', { validations, where: guard,
    event: { kind: 'RealmResourceSelectedEvent', fields: `rv:component ${iri(slot)} ; rv:revision ${iri(input.selection)}` },
    receiptFields: `rv:selection ${iri(input.selection)} ; rv:slot ${iri(slot)} ; rv:realm ${iri(input.realm)} ;
      rv:work ${iri(target.work)} ; rv:mainVersion ${iri(target.mainVersion)} ;
      ${input.expectedHead ? `rv:expectedHead ${iri(input.expectedHead)} ;` : ''}`,
    remove: `GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:selectionHead ?prior }`,
    insert: `GRAPH ${iri(GRAPHS.current)} {
      ${iri(slot)} a rv:RealmResourceSlot ; rv:realm ${iri(input.realm)} ; rv:work ${iri(target.work)} ;
        rv:mainVersion ${iri(target.mainVersion)} ; rv:submissionKind ${lit(target.kind)} ;
        rv:selectionHead ${iri(input.selection)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.selection)} a rv:RealmSubmissionSelection, rv:RevisionAnchor ; rv:component ${iri(slot)} ;
          rv:context ${iri(input.realm)} ; rv:work ${iri(target.work)} ; rv:mainVersion ${iri(target.mainVersion)} ;
          rv:workRevision ${iri(target.workRevision)} ; rv:submissionKind ${lit(target.kind)} ;
          rv:selectionMode rv:${target.kind === 'work' ? 'Following' : 'Fixed'} ;
          ${target.kind === 'content-publication' ? `rv:variant ${iri(target.variant)} ;
            rv:publicationDecision ${iri(target.publicationDecision)} ;
            rv:contentRevision <urn:rezics:content:revision:${target.contentRevision}> ;` : ''}
          rv:recordedBy ${iri(admission.actingSubject)} ; rv:submittingAgent ${iri(target.actingSubject)} ;
          ${input.expectedHead ? `rv:predecessor ${iri(input.expectedHead)} ;` : ''}
          ${input.policy ? `rv:realmPolicyHead ${iri(input.policy.revision)} ;` : ''}
          rv:selectionBasis rv:${input.policy ? 'RealmPolicy' : 'RealmManagerReview'} ;
          rv:modelRevision ${iri(RESOURCE_SUBMISSION_PROFILE)} ; rv:shapeRevision ${iri(RESOURCE_SUBMISSION_PROFILE)} ;
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }` });
}

export async function resourceSelectionHead(env: WorkActivationEnvironment, realm: string, target: ResourceSubmissionInput) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(resourceSlot(realm, target))} rv:selectionHead ?head }
  } LIMIT 2`, 2048)).results?.bindings;
  if (!rows || rows.length > 1) throw new SubmissionUnavailable('Realm resource selection is ambiguous');
  return rows[0]?.head?.value ?? null;
}
