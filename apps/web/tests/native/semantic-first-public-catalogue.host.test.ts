import { registerSemanticFirstPublicHost } from './semantic-first-public-suite.ts';

registerSemanticFirstPublicHost({
  requested: ['catalogue-browsing'],
  dependencies: { 'catalogue-browsing': [] },
});
