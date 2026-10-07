import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const ratingQuestionPresentationDeclaration = {
  id: 'rating-question-presentation-v1',
  canonical: {
    presentation: { types: ['rv:RatingQuestionPresentation'] },
    revision: { types: ['rv:RatingQuestionPresentationRevision'] },
  },
  binding: {
    required: ['presentation', 'revision', 'context', 'language'],
    roles: ['presentation', 'revision'],
    demandedBy: ['rv:RatingQuestionPresentation', 'rv:RatingQuestionPresentationRevision'],
  },
} as const satisfies TurtleDeclaration;

export const ratingQuestionPresentationProfile = parseTurtleProfile(
  ratingQuestionPresentationDeclaration.id,
  readFileSync(new URL('./rating-question-presentation-v1.ttl', import.meta.url), 'utf8'),
  ratingQuestionPresentationDeclaration,
);
