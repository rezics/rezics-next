import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const workDerivationUnresolvedDeclaration = {
  id: 'work-derivation-unresolved-v1',
  canonical: { derivation: { types: ['rv:UnresolvedWorkDerivation'] } },
  binding: {
    required: ['derivation', 'target-work', 'target-main', 'target-revision', 'source-work',
      'kind', 'evidence', 'actor', 'receipt', 'scope', 'epoch'],
    optional: ['source-main'],
    roles: ['derivation'], demandedBy: ['rv:UnresolvedWorkDerivation'],
  },
} as const satisfies TurtleDeclaration;

export const workDerivationUnresolvedProfile = parseTurtleProfile(
  'work-derivation-unresolved-v1',
  readFileSync(new URL('./work-derivation-unresolved-v1.ttl', import.meta.url), 'utf8'),
  workDerivationUnresolvedDeclaration,
);
