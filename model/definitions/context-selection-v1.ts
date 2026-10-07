import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const contextSelectionDeclaration = {
  id: 'context-selection-v1',
  canonical: {
    selection: { types: ['rv:ContextSelection'] },
    revision: { types: ['rv:ContextSelectionRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const contextSelectionProfile = parseTurtleProfile(
  'context-selection-v1',
  readFileSync(new URL('./context-selection-v1.ttl', import.meta.url), 'utf8'),
  contextSelectionDeclaration,
);
