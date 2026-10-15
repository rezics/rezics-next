import type { WorkProfileCorpusRecipe } from '../../../scripts/load/work-profile-corpus.ts';

/** The seed builder and offline key check consume the same authored recipe inputs. */
export const seedSpecification = {
  version: 'public-population-checkpoints-v2',
  fixed: { unrelatedWorks: 0, unrelatedPosts: 0, follows: 0, memberships: 0,
    historyDepth: 0, realmSize: 0, conceptVocabulary: 0 },
  populations: ['recipeOccurrences', 'readerShelfEntries', 'mountedCollectionResources', 'zoneNavigationEntries'],
} as const satisfies Pick<WorkProfileCorpusRecipe, 'version' | 'fixed' | 'populations'>;
