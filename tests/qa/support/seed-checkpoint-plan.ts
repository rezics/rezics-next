import { WORK_PROFILE_SCALES, workProfileDimensions, type CorpusDimensions,
  type WorkProfileScale } from '../../../scripts/load/work-profile-corpus.ts';

export const SEED_AXES = ['unrelatedWorks', 'unrelatedPosts', 'zoneNavigationEntries',
  'mountedCollectionResources', 'readerShelfEntries', 'recipeOccurrences'] as const;
export type SeedAxis = (typeof SEED_AXES)[number];
export const SEED_RECIPE = 'public-population-checkpoints-v3';
export interface SeedStage { axis: SeedAxis; scale: WorkProfileScale; fixed: CorpusDimensions }

/** Grow one axis at a time in one store. Each next series starts at the last
 * stopped cut: all other populations stay identical within that series. */
export function seedCheckpointPlan(): SeedStage[] {
  let dimensions: CorpusDimensions = { unrelatedWorks: 4, unrelatedPosts: 4, follows: 0,
    memberships: 0, historyDepth: 0, realmSize: 0, conceptVocabulary: 0,
    zoneNavigationEntries: 4, mountedCollectionResources: 4, readerShelfEntries: 4, recipeOccurrences: 100 };
  return SEED_AXES.flatMap(axis => {
    const fixed = { ...dimensions, [axis]: 0 };
    const stages = WORK_PROFILE_SCALES.map(scale => ({ axis, scale, fixed }));
    dimensions = workProfileDimensions(axis, 'large', fixed);
    return stages;
  });
}
