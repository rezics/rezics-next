import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const ratingAggregateDefaultPolicyDeclaration = {
  id: 'rating-aggregate-default-policy-v1',
  canonical: {
    revision: { types: ['rv:RatingPolicyRevision'] },
  },
  binding: {
    required: ['context', 'revision', 'contextRevision', 'predecessor', 'aggregationPolicy'],
    roles: ['context', 'revision'],
    demandedBy: ['rv:RatingPolicyRevision'],
  },
} as const satisfies TurtleDeclaration;

export const ratingAggregateDefaultPolicyProfile = parseTurtleProfile(
  ratingAggregateDefaultPolicyDeclaration.id,
  readFileSync(new URL('./rating-aggregate-default-policy-v1.ttl', import.meta.url), 'utf8'),
  ratingAggregateDefaultPolicyDeclaration,
);
