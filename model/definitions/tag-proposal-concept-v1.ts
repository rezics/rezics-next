import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const tagProposalConceptDeclaration = {
  id: 'tag-proposal-concept-v1',
  canonical: {
    concept: { types: ['rv:AuthorTagConcept'] },
  },
} as const satisfies TurtleDeclaration;

export const tagProposalConceptProfile = parseTurtleProfile(
  tagProposalConceptDeclaration.id,
  readFileSync(new URL('./tag-proposal-concept-v1.ttl', import.meta.url), 'utf8'),
  tagProposalConceptDeclaration,
);
