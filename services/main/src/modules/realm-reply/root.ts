import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { unerased } from '../work/public-patterns.ts';

/** A comment anchors a published contribution revision, including an eligible
 * alternative to Main's selected text. Private drafts and erased roots fail
 * closed. One bounded ASK; no body, Account identity or history enumeration. */
export async function publicReplyRoot(graph: Pick<FusekiClient, 'query'>,
  work: string, revision: string): Promise<boolean> {
  const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
  if (!native.test(work) || !native.test(revision)) return false;
  return (await graph.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a schema:CreativeWork ; rv:head ?workHead .
        ?contribution a rv:TextContribution ; rv:work ${iri(work)} ; rv:publicationHead ?decision }
      GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:PublicationDecision ;
        rv:component ?contribution ; rv:work ${iri(work)} ; rv:disclosure rv:Public ;
        rv:selectedDraft ${iri(revision)} .
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ?contribution .
        FILTER NOT EXISTS { ${iri(revision)} a rv:ErasedRevision } }
      ${unerased(iri(work))}
    }`, 1024)).boolean === true;
}
