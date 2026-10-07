import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workDerivationDeclaration = {
  id: 'work-derivation-v1',
  canonical: { derivation: { types: ['rv:WorkDerivation'] } },
  binding: {
    required: ['derivation', 'target-work', 'target-main', 'target-revision', 'source-work',
      'source-main', 'source-revision', 'kind', 'evidence', 'actor', 'receipt', 'scope', 'epoch'],
    roles: ['derivation'], demandedBy: ['rv:WorkDerivation'],
  },
} as const satisfies TurtleDeclaration;

export const workDerivationProfile = parseTurtleProfile(
  'work-derivation-v1',
  readFileSync(new URL('./work-derivation-v1.ttl', import.meta.url), 'utf8'),
  workDerivationDeclaration,
);
