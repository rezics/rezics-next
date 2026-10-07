import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const definitionKeyDeclaration = {
  id: 'definition-key-v1',
  canonical: {
    key: { types: ['rv:DefinitionKey'] },
  },
} as const satisfies TurtleDeclaration;

export const definitionKeyProfile = parseTurtleProfile(
  definitionKeyDeclaration.id,
  readFileSync(new URL('./definition-key-v1.ttl', import.meta.url), 'utf8'),
  definitionKeyDeclaration,
);
