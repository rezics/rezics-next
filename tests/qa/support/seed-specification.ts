import { SEED_RECIPE } from './seed-checkpoint-plan.ts';
import type { WorkProfileCorpusRecipe } from '../../../scripts/load/work-profile-corpus.ts';

/** The seed builder and offline key check consume the same authored recipe inputs. */
export const seedSpecification = {
  version: SEED_RECIPE,
  populations: ['recipeOccurrences', 'readerShelfEntries', 'mountedCollectionResources', 'zoneNavigationEntries'],
} as const satisfies Pick<WorkProfileCorpusRecipe, 'version' | 'populations'>;
