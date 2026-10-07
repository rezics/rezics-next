import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const realizationDeclaration = {
  id: 'realization-v1',
  canonical: {
    realization: { types: ['rv:Realization'] },
    revision: { types: ['rv:RealizationRevision'] },
  },
  binding: {
    required: ['realization', 'revision'],
    roles: ['realization', 'revision'],
    demandedBy: ['rv:RealizationRevision'],
  },
} as const satisfies TurtleDeclaration;

export const realizationProfile = parseTurtleProfile(
  realizationDeclaration.id,
  readFileSync(new URL('./realization-v1.ttl', import.meta.url), 'utf8'),
  realizationDeclaration,
);
