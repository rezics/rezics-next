import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const themeFirstPartyDeclaration = {
  id: 'theme-first-party-v1',
  canonical: {
    theme: { types: ['rv:FirstPartyTheme'] },
    revision: { types: ['rv:FirstPartyThemeRevision'] },
    'review-slot': { types: ['rv:FirstPartyThemeReviewSlot'] },
    review: { types: ['rv:FirstPartyThemeReview'] },
    activation: { types: ['rv:FirstPartyThemeActivation'] },
    'revocation-slot': { types: ['rv:FirstPartyThemeRevocationSlot'] },
    revocation: { types: ['rv:FirstPartyThemeRevocation'] },
    'control-head': { types: ['rv:FirstPartyThemeControlHead'] },
    control: { types: ['rv:FirstPartyThemeControl'] },
  },
} as const satisfies TurtleDeclaration;

export const themeFirstPartyProfile = parseTurtleProfile(
  themeFirstPartyDeclaration.id,
  readFileSync(new URL('./theme-first-party-v1.ttl', import.meta.url), 'utf8'),
  themeFirstPartyDeclaration,
);
