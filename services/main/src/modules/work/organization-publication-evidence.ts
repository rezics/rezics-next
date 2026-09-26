import type { GraphTerminalProof } from '../access/admission.ts';
import { canonicalOrganizationPublication, type OrganizationPublicationTarget }
  from '../access/organization-publication.ts';
import { CONTRIBUTION_PROFILE } from '../contribution/draft.ts';
import { PUBLICATION_PROFILE, textPublicationReceiptIri } from '../contribution/publish.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from './activate.ts';
import { readComponentState } from './history.ts';
import { REALM_SELECTION_PROFILE, realmSelectionSlotIri } from './select-realm.ts';

/** All mutable heads are compared again inside the Jena effect transaction. */
export function organizationPublicationGuard(target: OrganizationPublicationTarget): string {
  const t = canonicalOrganizationPublication(target);
  const slot = realmSelectionSlotIri(t.realm, t.mainVersion);
  return `GRAPH ${iri(GRAPHS.current)} {
    ${iri(t.work)} rv:head ${iri(t.expectedWorkHead)} ; rv:mainVersion ${iri(t.mainVersion)} .
    ${iri(t.contribution)} a rv:TextContribution ; rv:work ${iri(t.work)} ;
      rv:author ${iri(t.organizationSubject)} ; rv:publicationHead ${iri(t.publicationDecision)} .
  }
  GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(t.selection)} a rv:PublicationSelection ; rv:slot ${iri(slot)} ;
      rv:context ${iri(t.realm)} ; rv:work ${iri(t.work)} ; rv:mainVersion ${iri(t.mainVersion)} ;
      rv:contribution ${iri(t.contribution)} ; rv:publicationDecision ${iri(t.publicationDecision)} ;
      rv:selectedDraft ${iri(t.selectedDraft)} .
    ${iri(t.publicationDecision)} a rv:PublicationDecision ; rv:component ${iri(t.contribution)} ;
      rv:work ${iri(t.work)} ; rv:author ${iri(t.organizationSubject)} ;
      rv:selectedDraft ${iri(t.selectedDraft)} ; rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public .
  }`;
}

/** Reads immutable selected evidence, so a successful exact retry still works after suppression. */
export async function organizationPublisherEvidence(env: WorkActivationEnvironment,
  raw: OrganizationPublicationTarget): Promise<GraphTerminalProof> {
  const t = canonicalOrganizationPublication(raw);
  const slot = realmSelectionSlotIri(t.realm, t.mainVersion);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?selectionManifest ?publicationManifest ?draftManifest ?receipt ?id ?digest ?epoch ?scope ?dataEpoch ?sequence
    WHERE {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(t.selection)} a rv:PublicationSelection ; rv:slot ${iri(slot)} ;
          rv:context ${iri(t.realm)} ; rv:work ${iri(t.work)} ; rv:mainVersion ${iri(t.mainVersion)} ;
          rv:contribution ${iri(t.contribution)} ; rv:publicationDecision ${iri(t.publicationDecision)} ;
          rv:selectedDraft ${iri(t.selectedDraft)} ; rv:manifest ?selectionManifest ;
          rv:modelRevision ${iri(REALM_SELECTION_PROFILE)} ; rv:shapeRevision ${iri(REALM_SELECTION_PROFILE)} .
        ${iri(t.publicationDecision)} a rv:PublicationDecision ; rv:component ${iri(t.contribution)} ;
          rv:work ${iri(t.work)} ; rv:author ${iri(t.organizationSubject)} ;
          rv:selectedDraft ${iri(t.selectedDraft)} ; rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public ;
          rv:manifest ?publicationManifest ; rv:modelRevision ${iri(PUBLICATION_PROFILE)} ;
          rv:shapeRevision ${iri(PUBLICATION_PROFILE)} .
        ${iri(t.selectedDraft)} a rv:RevisionAnchor ; rv:component ${iri(t.contribution)} ;
          rv:manifest ?draftManifest ; rv:modelRevision ${iri(CONTRIBUTION_PROFILE)} ;
          rv:shapeRevision ${iri(CONTRIBUTION_PROFILE)} .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ?receipt a rv:OperationReceipt ; rv:publicationDecision ${iri(t.publicationDecision)} ;
          rv:contribution ${iri(t.contribution)} ; rv:selectedDraft ${iri(t.selectedDraft)} ;
          rv:work ${iri(t.work)} ; rv:author ${iri(t.organizationSubject)} ; rv:outcome rv:Succeeded ;
          rv:admissionId ?id ; rv:requestDigest ?digest ; rv:authorityEpoch ?epoch ;
          rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      }
    } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length !== 1) throw new Error('selected organization publication evidence unavailable');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value ?? '';
  const selection = readComponentState(env.objectDirectory, value('selectionManifest'), slot, REALM_SELECTION_PROFILE);
  const publication = readComponentState(env.objectDirectory, value('publicationManifest'), t.contribution, PUBLICATION_PROFILE);
  const draft = readComponentState(env.objectDirectory, value('draftManifest'), t.contribution, CONTRIBUTION_PROFILE);
  if (selection.contribution !== t.contribution || selection.publicationDecision !== t.publicationDecision
    || selection.selectedDraft !== t.selectedDraft || selection.work !== t.work
    || selection.mainVersion !== t.mainVersion || selection.slot !== slot
    || publication.author !== t.organizationSubject || publication.work !== t.work
    || publication.contribution !== t.contribution || publication.selectedDraft !== t.selectedDraft
    || publication.rightsBasis !== 'original-contribution' || publication.disclosure !== 'public'
    || draft.author !== t.organizationSubject || draft.work !== t.work
    || value('receipt') !== textPublicationReceiptIri(value('id'))
    || value('scope') !== `contribution:publish:${t.contribution}`
    || !/^[0-9a-f]{64}$/.test(value('digest')) || !/^[0-9]+$/.test(value('sequence'))) {
    throw new Error('organization publisher graph and payload evidence differ');
  }
  return { outcome: 'succeeded', receipt: value('receipt'), admissionId: value('id'),
    requestDigest: value('digest'), authorityEpoch: value('epoch'), scope: value('scope'),
    dataEpoch: value('dataEpoch'), sequence: value('sequence') };
}
