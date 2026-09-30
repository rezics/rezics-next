import { GRAPHS, iri } from './activate.ts';

export const unerased = (work: string) => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
  ?erasedVariant rv:resource ${work} ; rv:contentPublicationHead ?erasedPublication }
  GRAPH ${iri(GRAPHS.revisions)} { ?erasedPublication rv:contentRevision ?erasedRevision .
    ?erasedRevision a rv:ErasedRevision } }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${work} rv:head ?erasedWorkHead }
    GRAPH ${iri(GRAPHS.revisions)} { ?erasedWorkHead a rv:ErasedRevision } }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${work} rv:protectionHead ?protection } }`;

/** Shared by public reads and baseline write authorization. Current reviewed
 * publication or explicit catalogue visibility; a private draft and a retired
 * publication do not qualify. Provisional visibility grants no trust. */
export const publicWork = (work: string, main: string) => `{ { GRAPH ${iri(GRAPHS.current)} {
  ${work} a schema:CreativeWork ; rv:mainVersion ${main} .
  ${main} a rv:MainVersion ; rv:work ${work} ; rv:selectionHead ?publicSelection .
  ?publicContribution rv:work ${work} ; rv:publicationHead ?publicDecision . }
  GRAPH ${iri(GRAPHS.revisions)} { ?publicSelection a rv:PublicationSelection ;
    rv:work ${work} ; rv:mainVersion ${main} ;
    rv:contribution ?publicContribution ; rv:publicationDecision ?publicDecision ; rv:selectedDraft ?publicDraft .
    ?publicDecision a rv:PublicationDecision ; rv:component ?publicContribution ; rv:work ${work} ;
      rv:contribution ?publicContribution ; rv:disclosure rv:Public ; rv:selectedDraft ?publicDraft .
    ?publicDraft a rv:RevisionAnchor ; rv:component ?publicContribution .
    FILTER NOT EXISTS { ?publicDraft a rv:ErasedRevision } } }
  UNION { GRAPH ${iri(GRAPHS.current)} { ${work} a schema:CreativeWork ;
    rv:mainVersion ${main} ; rv:catalogueVisible true . ${main} a rv:MainVersion ; rv:work ${work} } }
  } ${unerased(work)}`;
