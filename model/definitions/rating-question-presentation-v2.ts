import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const ratingQuestionPresentationReviewedDeclaration = {
  id: 'rating-question-presentation-v2',
  canonical: {
    presentation: { types: ['rv:RatingQuestionPresentationV2'] },
    revision: { types: ['rv:RatingQuestionPresentationV2Revision'] },
  },
  binding: {
    required: ['presentation', 'revision', 'context', 'language'],
    roles: ['presentation', 'revision'],
    demandedBy: ['rv:RatingQuestionPresentationV2', 'rv:RatingQuestionPresentationV2Revision'],
  },
} as const satisfies TurtleDeclaration;

export const ratingQuestionPresentationReviewedProfile = parseTurtleProfile(
  ratingQuestionPresentationReviewedDeclaration.id,
  readFileSync(new URL('./rating-question-presentation-v2.ttl', import.meta.url), 'utf8'),
  ratingQuestionPresentationReviewedDeclaration,
);
