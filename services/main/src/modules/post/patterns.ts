import { GRAPHS, iri } from '../work/activate.ts';
import { unerased } from '../work/public-patterns.ts';
import { structureProfileFor } from '../structure/profiles.ts';

/** The live Book placement is the only Post-to-Work relationship. A reused Post
 * can bind several Books; callers must retain that multiplicity. */
export function postBookPlacement(post: string, book: string, main: string,
  occurrence = '?postOccurrence') {
  return `GRAPH ${iri(GRAPHS.current)} { ${post} a rv:Post . }
    ${bookChapterPlacement(post, book, main, occurrence)}`;
}

/** A live chapter occurrence supplies its Book without changing the target's identity. */
export function bookChapterPlacement(resource: string, book: string, main: string,
  occurrence = '?postOccurrence') {
  const composition = structureProfileFor('book-composition');
  return `GRAPH ${iri(GRAPHS.current)} {
    ${book} a <${composition.ownerType}> ; rv:mainVersion ${main} .
    ${main} a rv:MainVersion ; rv:work ${book} .
    ?postStructure a rv:Structure ; rv:structureProfile <${composition.graphProfile}> ;
      rv:structureOf ${main} ; rv:selectedGeneration ?postGeneration .
    ?postGeneration rv:generationState rv:Active .
    ?postPlacement a rv:OccurrencePlacement ; rv:generation ?postGeneration ;
      rv:occurrenceRole rv:ChapterRole ; <https://schema.org/item> ${resource} ; rv:occurrence ${occurrence} .
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
