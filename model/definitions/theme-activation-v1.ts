import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const themeActivationDeclaration = {
  id: 'theme-activation-v1',
  canonical: {
    theme: { types: ['rv:CustomTheme'] },
  },
} as const satisfies TurtleDeclaration;

export const themeActivationProfile = parseTurtleProfile(
  themeActivationDeclaration.id,
  readFileSync(new URL('./theme-activation-v1.ttl', import.meta.url), 'utf8'),
  themeActivationDeclaration,
);
