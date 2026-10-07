import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workDerivationV2Declaration = {
  id: 'work-derivation-v2',
  canonical: {
    derivation: { types: ['rv:LexiconWorkDerivation'] },
  },
  binding: {
    required: [
      'derivation',
      'target-work',
      'target-main',
      'target-revision',
      'source-work',
      'kind',
      'evidence',
      'actor',
      'receipt',
      'scope',
      'epoch',
    ],
    optional: ['source-main', 'source-revision'],
    roles: ['derivation'],
    demandedBy: ['rv:LexiconWorkDerivation'],
  },
} as const satisfies TurtleDeclaration;

export const workDerivationV2Profile = parseTurtleProfile(
  workDerivationV2Declaration.id,
  readFileSync(new URL('./work-derivation-v2.ttl', import.meta.url), 'utf8'),
  workDerivationV2Declaration,
);
