import { searchablePlacement } from '../structure/searchable-placements.ts';
import { fallbackLanguage, realmLanguage } from './selection-heads.ts';
import { GRAPHS, iri, lit } from './activate.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { PHRASE_HIT_PROBE } from './search-readiness.ts';
import { publicWork } from './public-patterns.ts';
import type { PublicMainPhraseQuery } from './search-public.ts';

/** The same selected native text and profile-declared Content relation for every phrase reader.
 * Keep this inside the reader's graph snapshot, including classification/rating joins. */
export function phraseMatchPattern(input: PublicMainPhraseQuery & { context?: { id: string } }, lucene: string, candidates?: string) {
  const realm = input.context?.id;
  const content = input.contentProjection;
  const matches = candidates ?? `GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
    (?unit ?score) text:query (rv:searchBody ${lit(lucene)} ${PHRASE_HIT_PROBE}) }`;
  return `{
        { ${matches}
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ?unit a rv:MatchUnit ; rv:disclosure rv:Public ;
            rv:work ?phraseWork ; rv:mainVersion ?phraseMain ; rv:contribution ?contribution ;
            rv:context ?unitContext ; rv:revision ?revision ;
            rv:selection ?selection ; rv:language ?language .
          OPTIONAL { ?unit rv:searchResultWork ?resultWork ; rv:searchResultMain ?resultMain ;
            rv:searchChapterTitle ?chapterTitle . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } }
        }
        GRAPH ${iri(GRAPHS.current)} {
          ?phraseWork a schema:CreativeWork ; rv:mainVersion ?phraseMain .
          ?phraseMain a rv:MainVersion ; rv:work ?phraseWork .
          ${realm ? '' : '?phraseMain rv:selectionHead ?selection .'}
          ${input.author ? `?contribution a rv:TextContribution ; rv:author ${iri(input.author)} .` : ''}
        }
        ${realm ? `
          OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
            ?slot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ; rv:mainVersion ?phraseMain ; rv:selectionHead ?local . }
            ${realmLanguage('?local', '?language')} }
          OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?phraseMain rv:selectionHead ?fallback }
            ${fallbackLanguage('?fallback', '?language')} }
          BIND(COALESCE(?local, ?fallback) AS ?effectiveSelection)
          BIND(IF(BOUND(?local), ${iri(realm)}, ?phraseMain) AS ?effectiveContext)
          BIND(IF(BOUND(?local), "realm-adoption", "main-fallback") AS ?reason)
          FILTER(?selection = ?effectiveSelection && ?unitContext = ?effectiveContext)
        ` : 'FILTER(?unitContext = ?phraseMain) BIND("main-fallback" AS ?reason)'}
        FILTER(!BOUND(?resultWork) || EXISTS { ${publicWork('?resultWork', '?resultMain')} })
        ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
        }
        ${content ? `UNION {
          ${matches}
          GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
            ?unit a rv:MatchUnit ; rv:disclosure rv:Public ; rv:field rv:Body ;
              rv:resource ?phraseWork ; rv:variant ?variant ; rv:revision ?contentRevision ;
              rv:publicationDecision ?contentDecision ; rv:eligibility ?contentEligibility ;
              rv:projection ?contentProjection ; rv:language ?language .
          }
          GRAPH ${iri(GRAPHS.current)} {
            ?variant a rv:ContentVariant ; rv:resource ?phraseWork ;
              rv:contentPublicationHead ?contentDecision ;
              rv:publicSearchEligibilityHead ?contentEligibility .
            ?phraseWork <http://www.w3.org/2000/01/rdf-schema#label> ?chapterTitle .
          }
          FILTER(LCASE(LANG(?chapterTitle)) = LCASE(?language))
          GRAPH ${iri(GRAPHS.revisions)} {
            ?contentEligibility a rv:ContentSearchEligibilityDecision ;
              rv:variant ?variant ; rv:publicationDecision ?contentDecision ;
              rv:rightsBasis ?rightsBasis ; rv:disclosure rv:Public .
            OPTIONAL { ?contentEligibility rv:rightsAssessment ?assessment }
            FILTER NOT EXISTS { ?contentRevision a rv:ErasedRevision }
          }
          ${searchablePlacement('?phraseWork', '?resultWork', '?resultMain', '?contentRevision')}
          ${publicWork('?resultWork', '?resultMain')}
          ${realm ? `OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
            ?contentSlot a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
              rv:mainVersion ?resultMain ; rv:selectionHead ?contentLocal . }
            ${realmLanguage('?contentLocal', '?language')} }
            BIND(IF(BOUND(?contentLocal), "realm-adoption", "main-fallback") AS ?reason)`
            : 'BIND("main-fallback" AS ?reason)'}
          ${input.author ? `GRAPH ${iri(GRAPHS.current)} {
            ?bookCredit a rv:NativeAgentCredit ; rv:work ?resultWork ; rv:agent ${iri(input.author)} ;
              <https://schema.org/roleName> "author" . }` : ''}
          BIND(?resultMain AS ?phraseMain)
          BIND(?phraseWork AS ?contribution)
          BIND(?contentRevision AS ?revision)
          BIND(?contentDecision AS ?selection)
          ${input.language ? `FILTER(?language = ${lit(input.language)})` : ''}
        }` : ''}
    }
    BIND(COALESCE(?resultWork, ?phraseWork) AS ?work)
    BIND(COALESCE(?resultMain, ?phraseMain) AS ?main)`;
}
