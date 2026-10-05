import { GRAPHS, iri, type WorkActivationEnvironment } from './activate.ts';
import { discloseInventory } from '../disclosure/read.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';

/** Graph publication is a candidate predicate, not audience admission. Owners
 * returning identities/counts without summaries use this same disclosure batch
 * before pagination or aggregation. One head probe and one owner query per 64
 * Works; never reads the assessment history or invents reader evidence. */
export async function admittedPublicWorks(environment: WorkActivationEnvironment | undefined,
  works: readonly string[], viewer: Viewer = ANONYMOUS_VIEWER): Promise<ReadonlySet<string>> {
  const unique = [...new Set(works)];
  if (!environment) return new Set(unique); // Graph-only legacy owner fixtures.
  const decisions = await discloseInventory(environment, unique.map(resource => ({
    owner: 'graph' as const, resource, component: 'name' as const, work: resource,
  })), viewer, 'read');
  return new Set(unique.filter((_, index) => decisions[index] === 'visible'));
}

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
