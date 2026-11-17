import { registerSemanticFirstPublicHost } from './semantic-first-public-suite.ts';

registerSemanticFirstPublicHost({
  requested: [
    'statement-consent',
    'subject-lifecycle',
    'zone-creation-and-configuration',
    'zone-publication-and-navigation',
    'zone-lifecycle-and-moderation',
  ],
  dependencies: {
    'statement-consent': [],
    'subject-lifecycle': [],
    'zone-creation-and-configuration': [],
    'zone-publication-and-navigation': ['zone-creation-and-configuration'],
    'zone-lifecycle-and-moderation': ['zone-creation-and-configuration', 'zone-publication-and-navigation'],
  },
});
