import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const semanticDefinitionDeclaration = {
  id: 'semantic-definition-v1',
  canonical: {
    definition: { types: ['rv:SemanticDefinition'] },
    revision: { types: ['rv:DefinitionRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const semanticDefinitionProfile = parseTurtleProfile(
  semanticDefinitionDeclaration.id,
  readFileSync(new URL('./semantic-definition-v1.ttl', import.meta.url), 'utf8'),
  semanticDefinitionDeclaration,
);
