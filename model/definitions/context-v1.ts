import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const contextDeclaration = {
  id: 'context-v1',
  canonical: {
    global: {
      types: ['rv:SemanticContext'],
      when: [{ path: 'rv:contextRole', value: 'rv:GlobalInterpretation' }],
    },
    context: { types: ['rv:SemanticContext'] },
    'semantic-revision': { types: ['rv:ContextSemanticRevision'] },
    entry: { types: ['rv:ContextEntry'] },
    'preference-revision': { types: ['rv:ContextPreferenceRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const contextProfile = parseTurtleProfile(
  'context-v1',
  readFileSync(new URL('./context-v1.ttl', import.meta.url), 'utf8'),
  contextDeclaration,
);
