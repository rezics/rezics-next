/** Compatibility re-export of ordinary page arithmetic. Core owns the declarations. */

export {
  CANONICAL_SOURCE_RAW_KEY_LIMIT as ORDINARY_COLLECTION_ALIAS_LIMIT,
  COLLECTION_SOURCE_DRIVER_COUNT as ORDINARY_COLLECTION_DRIVER_COUNT,
  COLLECTION_SOURCE_WORK_GROUP_LIMIT as ORDINARY_COLLECTION_PREFIX_GROUP_LIMIT,
  ORDINARY_COLLECTION_PAGE_LIMIT,
  ORDINARY_COLLECTION_PREFIX_ROUNDS,
} from './contract/index.ts';
export {
  ordinaryCollectionPagePlan,
  ordinaryPageWorkDimensions,
  type OrdinaryCollectionPagePlan,
} from './core/index.ts';
