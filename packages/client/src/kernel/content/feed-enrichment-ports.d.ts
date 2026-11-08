import type * as Rating from '../rating/index.ts';
import type * as SemanticSummaries from '../semantic/summaries.ts';
/** Existing owner operations installed by Content composition for current feed enrichment. */
export type FeedEnrichmentPorts = Readonly<{
    readSubjectSummaries: typeof SemanticSummaries.readSubjectSummaries;
    readSubjectSummaryObservation: typeof SemanticSummaries.readSubjectSummaryObservation;
    readVisibleRatingQuestion: typeof Rating.readVisibleRatingQuestion;
    standardQuestionId: typeof Rating.STANDARD_QUESTION_ID;
}>;
