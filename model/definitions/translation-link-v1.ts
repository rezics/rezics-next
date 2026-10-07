import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const translationLinkDeclaration = {
  id: 'translation-link-v1',
} as const satisfies TurtleDeclaration;

export const translationLinkProfile = parseTurtleProfile(
  'translation-link-v1',
  readFileSync(new URL('./translation-link-v1.ttl', import.meta.url), 'utf8'),
  translationLinkDeclaration,
);
