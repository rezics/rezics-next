import { GRAPHS, iri } from '../work/activate.ts';
import {
  QUESTION_PRESENTATION_COST,
  QUESTION_PRESENTATION_KINDS,
  QUESTION_PRESENTATION_REVISION_PROFILES,
} from './question-presentation-schema.ts';

/** The editorial head can advance independently of the retained public review.
 * Legacy reviewed heads remain readable until their first v2 edit. */
export function reviewedQuestionPresentationPattern(context: string, includeProtected = false) {
  return `VALUES ?presentationKind { ${QUESTION_PRESENTATION_KINDS} }
    ${QUESTION_PRESENTATION_REVISION_PROFILES}
    GRAPH ${iri(GRAPHS.current)} { ?presentation a ?presentationKind ;
      rv:presentationContext ${iri(context)} ; rv:questionPresentationHead ?editorialHead ; rv:presentationLanguage ?language .
      OPTIONAL { ?presentation rv:questionPresentationReviewedHead ?reviewedHead }
      ${includeProtected ? '' : 'FILTER NOT EXISTS { ?presentation rv:protectionHead ?protection }'} }
    BIND(COALESCE(?reviewedHead, ?editorialHead) AS ?head)
    GRAPH ${iri(GRAPHS.revisions)} { ?head a ?presentationRevisionKind, rv:RevisionAnchor ;
      rv:component ?presentation ; rv:presentationContext ${iri(context)} ;
      rv:presentationLanguage ?language ; rv:reviewStatus rv:Reviewed .
      FILTER NOT EXISTS { ?head a rv:ErasedRevision } }`;
}

/** Bounded distinct-language witness, also evaluated inside the atomic graph
 * write. Only retained reviews count; admissions, cancelled attempts and drafts
 * without a reviewed head never reserve a language. */
export function questionPresentationLanguageLimit(context: string, component: string) {
  return `{ SELECT (COUNT(*) AS ?reviewedCount) WHERE {
    { SELECT DISTINCT ?language WHERE {
      ${reviewedQuestionPresentationPattern(context, true)}
      FILTER(?presentation != ${iri(component)})
    } LIMIT ${QUESTION_PRESENTATION_COST.reviewedLanguagesPerContext} }
  } } FILTER(?reviewedCount >= ${QUESTION_PRESENTATION_COST.reviewedLanguagesPerContext})`;
}
