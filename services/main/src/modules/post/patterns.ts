import { GRAPHS, iri } from '../work/activate.ts';
import { unerased } from '../work/public-patterns.ts';

/** The live Book placement is the only Post-to-Work relationship. A reused Post
 * can bind several Books; callers must retain that multiplicity. */
export function postBookPlacement(post: string, book: string, main: string,
  occurrence = '?postOccurrence') {
  return `GRAPH ${iri(GRAPHS.current)} {
    ${post} a rv:Post .
    ${book} a <https://schema.org/Book> ; rv:mainVersion ${main} .
    ${main} a rv:MainVersion ; rv:work ${book} .
    ?postStructure a rv:Structure ; rv:structureProfile rv:BookComposition ;
      rv:structureOf ${main} ; rv:selectedGeneration ?postGeneration .
    ?postGeneration rv:generationState rv:Active .
    ?postPlacement a rv:OccurrencePlacement ; rv:generation ?postGeneration ;
      rv:occurrenceRole rv:ChapterRole ; <https://schema.org/item> ${post} ; rv:occurrence ${occurrence} .
    FILTER NOT EXISTS { ?postPlacement rv:removedBy ?postRemoval }
  }`;
}

/** Exact public Content eligibility exposes text, independently of catalogue membership. */
export function publicPost(post: string) {
  return `GRAPH ${iri(GRAPHS.current)} {
    ${post} a rv:Post ; rv:head ?publicPostHead .
    ?postVariant a rv:ContentVariant ; rv:resource ${post} ;
      rv:contentPublicationHead ?postPublication ; rv:publicSearchEligibilityHead ?postEligibility .
  } GRAPH ${iri(GRAPHS.revisions)} {
    ?postEligibility a rv:ContentSearchEligibilityDecision ;
      rv:publicationDecision ?postPublication ; rv:disclosure rv:Public .
    ?postPublication a rv:ContentPublicationDecision ; rv:resource ${post} ; rv:contentRevision ?postRevision .
    FILTER NOT EXISTS { ?postRevision a rv:ErasedRevision }
  } ${unerased(post)}`;
}
