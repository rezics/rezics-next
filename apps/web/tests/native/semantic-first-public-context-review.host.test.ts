import { registerSemanticFirstPublicHost } from './semantic-first-public-suite.ts';

registerSemanticFirstPublicHost({
  requested: ['context-editorial-decisions'],
  dependencies: { 'context-editorial-decisions': ['multilingual-terms', 'context-creation'] },
});
