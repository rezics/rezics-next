import { GRAPHS, iri } from './activate.ts';

export const unerased = (work: string) => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
  ?erasedVariant rv:resource ${work} ; rv:contentPublicationHead ?erasedPublication }
  GRAPH ${iri(GRAPHS.revisions)} { ?erasedPublication rv:contentRevision ?erasedRevision .
    ?erasedRevision a rv:ErasedRevision } }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${work} rv:head ?erasedWorkHead }
    GRAPH ${iri(GRAPHS.revisions)} { ?erasedWorkHead a rv:ErasedRevision } }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${work} rv:protectionHead ?protection } }`;

/** Binds the current reviewed publication for consumers that need selected text. */
export const publishedWork = (work: string, main: string) => `GRAPH ${iri(GRAPHS.current)} {
  ${work} a schema:CreativeWork ; rv:mainVersion ${main} .
  ${main} a rv:MainVersion ; rv:work ${work} ; rv:selectionHead ?publicSelection .
  ?publicContribution rv:work ${work} ; rv:publicationHead ?publicDecision . }
  GRAPH ${iri(GRAPHS.revisions)} { ?publicSelection a rv:PublicationSelection ;
    rv:work ${work} ; rv:mainVersion ${main} ;
    rv:contribution ?publicContribution ; rv:publicationDecision ?publicDecision ; rv:selectedDraft ?publicDraft .
    ?publicDecision a rv:PublicationDecision ; rv:component ?publicContribution ; rv:work ${work} ;
      rv:contribution ?publicContribution ; rv:disclosure rv:Public ; rv:selectedDraft ?publicDraft .
    ?publicDraft a rv:RevisionAnchor ; rv:component ?publicContribution .
    FILTER NOT EXISTS { ?publicDraft a rv:ErasedRevision } }`;

/** A visibility predicate: being both published and catalogue-visible must
 * still yield exactly one Work/main binding. Publication variables are local
 * to EXISTS; consumers needing a selected text use publishedWork explicitly. */
export const publicWork = (work: string, main: string) => `GRAPH ${iri(GRAPHS.current)} {
  ${work} a schema:CreativeWork ; rv:mainVersion ${main} .
  ${main} a rv:MainVersion ; rv:work ${work} . }
  FILTER(EXISTS { ${publishedWork(work, main)} }
    || EXISTS { GRAPH ${iri(GRAPHS.current)} { ${work} rv:catalogueVisible true } })
  ${unerased(work)}`;
