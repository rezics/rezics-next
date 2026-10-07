import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

// Canonical routing and the command binding stay in the established registry.
// Repeating them here declares the same route twice.
export const ratingAggregateDefaultPolicyDeclaration = {
  id: 'rating-aggregate-default-policy-v1',
} as const satisfies TurtleDeclaration;

export const ratingAggregateDefaultPolicyProfile = parseTurtleProfile(
  ratingAggregateDefaultPolicyDeclaration.id,
  readFileSync(new URL('./rating-aggregate-default-policy-v1.ttl', import.meta.url), 'utf8'),
  ratingAggregateDefaultPolicyDeclaration,
);
