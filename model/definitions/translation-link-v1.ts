import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const translationLinkDeclaration = {
  id: 'translation-link-v1',
  canonical: {
    link: { types: ['rv:TranslationLink'] },
  },
  binding: {
    required: [
      'link', 'target-work', 'target-main', 'target-revision', 'source-work', 'source-main',
      'status', 'language', 'translator', 'publisher', 'evidence', 'actor', 'receipt', 'scope', 'epoch',
    ],
    optional: ['source-revision'],
    roles: ['link'],
    demandedBy: ['rv:TranslationLink'],
  },
} as const satisfies TurtleDeclaration;

export const translationLinkProfile = parseTurtleProfile(
  'translation-link-v1',
  readFileSync(new URL('./translation-link-v1.ttl', import.meta.url), 'utf8'),
  translationLinkDeclaration,
);
