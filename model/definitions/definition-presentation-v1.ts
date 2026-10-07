import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const definitionPresentationDeclaration = {
  id: 'definition-presentation-v1',
  canonical: {
    presentation: { types: ['rv:DefinitionPresentation'] },
    revision: { types: ['rv:PresentationRevision'] },
  },
  binding: {
    required: [
      'presentation',
      'revision',
      'definition',
      'meaningRevision',
      'fromRole',
      'toRole',
      'language',
    ],
    roles: ['presentation', 'revision'],
    demandedBy: ['rv:DefinitionPresentation', 'rv:PresentationRevision'],
  },
} as const satisfies TurtleDeclaration;

export const definitionPresentationProfile = parseTurtleProfile(
  definitionPresentationDeclaration.id,
  readFileSync(new URL('./definition-presentation-v1.ttl', import.meta.url), 'utf8'),
  definitionPresentationDeclaration,
);
