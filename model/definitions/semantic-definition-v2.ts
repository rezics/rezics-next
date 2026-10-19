import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const authoredSemanticDefinitionDeclaration = {
  id: 'semantic-definition-v2',
  canonical: {
    definition: { types: ['rv:SemanticDefinition'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/semantic-definition-v2>' }] },
    revision: { types: ['rv:DefinitionRevision'], when: [{ path: 'rv:modelRevision', value: '<https://rezics.com/definition/semantic-definition-v2>' }] },
  },
} as const satisfies TurtleDeclaration;

export const authoredSemanticDefinitionProfile = parseTurtleProfile(
  authoredSemanticDefinitionDeclaration.id,
  readFileSync(new URL('./semantic-definition-v2.ttl', import.meta.url), 'utf8'),
  authoredSemanticDefinitionDeclaration,
);
