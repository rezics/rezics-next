import { GRAPHS, iri, type WorkActivationEnvironment } from '../work/activate.ts';

/** Only the currently selected exact public Content decision grants these bytes. */
export async function isPublicContentRevision(env: WorkActivationEnvironment, resource: string,
  revision: string, variant?: string): Promise<boolean> {
  return (await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${variant ? iri(variant) : '?variant'} rv:resource ${iri(resource)} ;
      rv:contentPublicationHead ?publication ; rv:publicSearchEligibilityHead ?eligibility }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?publication a rv:ContentPublicationDecision ; rv:resource ${iri(resource)} ;
        rv:contentRevision ${iri(`urn:rezics:content:revision:${revision}`)} .
      ?eligibility a rv:ContentSearchEligibilityDecision ; rv:publicationDecision ?publication ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ${iri(`urn:rezics:content:revision:${revision}`)} a rv:ErasedRevision }
    }
  }`, 4096)).boolean === true;
}
