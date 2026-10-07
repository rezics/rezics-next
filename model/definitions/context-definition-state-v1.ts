import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const contextDefinitionStateDeclaration = {
  id: 'context-definition-state-v1',
  canonical: {
    control: { types: ['rv:DefinitionLifecycle'] },
    revision: { types: ['rv:DefinitionLifecycleRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const contextDefinitionStateProfile = parseTurtleProfile(
  'context-definition-state-v1',
  readFileSync(new URL('./context-definition-state-v1.ttl', import.meta.url), 'utf8'),
  contextDefinitionStateDeclaration,
);
