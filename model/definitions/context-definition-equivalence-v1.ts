import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const contextDefinitionEquivalenceDeclaration = {
  id: 'context-definition-equivalence-v1',
  canonical: {
    control: { types: ['rv:ContextDefinitionEquivalence'] },
    revision: { types: ['rv:ContextDefinitionEquivalenceRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const contextDefinitionEquivalenceProfile = parseTurtleProfile(
  'context-definition-equivalence-v1',
  readFileSync(new URL('./context-definition-equivalence-v1.ttl', import.meta.url), 'utf8'),
  contextDefinitionEquivalenceDeclaration,
);
