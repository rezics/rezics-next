import { GRAPHS, iri, lit } from '../work/activate.ts';

/** The same adoption witnesses for browse, home lists and chapter reads.
 * Publication selections take precedence when both slot families exist. */
export function zoneAdoption(realm: string, language?: string): string {
  return `{ GRAPH ${iri(GRAPHS.current)} {
      ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ; rv:work ?work ;
        rv:mainVersion ?main ; rv:selectionHead ?selection .
      ?contribution rv:publicationHead ?decision . }
    GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ;
      rv:component ?slot ; rv:context ${iri(realm)} ; rv:work ?work ;
      rv:mainVersion ?main ; rv:contribution ?contribution ;
      rv:publicationDecision ?decision ; rv:selectedDraft ?draft .
      ?decision rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?draft a rv:ErasedRevision }
      ${language ? `FILTER EXISTS { ?selection rv:language ${lit(language)} }` : ''} } }
    UNION
    { GRAPH ${iri(GRAPHS.current)} {
        ?slot a rv:RealmResourceSlot ; rv:realm ${iri(realm)} ; rv:work ?work ;
          rv:mainVersion ?main ; rv:selectionHead ?selection . }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:RealmSubmissionSelection ;
        rv:component ?slot ; rv:context ${iri(realm)} ; rv:work ?work ; rv:mainVersion ?main . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?publicationSlot a rv:RealmPublicationSlot ;
          rv:realm ${iri(realm)} ; rv:work ?work ; rv:selectionHead ?publicationSelection . }
        GRAPH ${iri(GRAPHS.revisions)} { ?publicationSelection a rv:PublicationSelection } }
      ${language ? `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work rdfs:label ?titleLanguage . }
        FILTER(LANGMATCHES(LANG(?titleLanguage), ${lit(language)})) }` : ''}
    }`;
}
