import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const semanticResourceDeclaration = {
  id: 'semantic-resource-v1',
  canonical: {
    resource: { types: ['rdfs:Resource'] },
    revision: { types: ['rv:SemanticRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const semanticResourceProfile = parseTurtleProfile(
  semanticResourceDeclaration.id,
  readFileSync(new URL('./semantic-resource-v1.ttl', import.meta.url), 'utf8'),
  semanticResourceDeclaration,
);
