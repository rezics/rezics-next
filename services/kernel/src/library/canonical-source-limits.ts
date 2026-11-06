/** Shared canonical Source and Collection reader limits. This module has no runtime imports. */
export const CANONICAL_SOURCE_RAW_KEY_LIMIT = 100;
export const COLLECTION_SOURCE_WORK_GROUP_LIMIT = 100;
export const COLLECTION_SOURCE_DRIVER_COUNT = 6;
/** Actual cap enforced while collecting one canonical group's complete original closure. */
export const OWNER_FILTER_CLOSURE_REFERENCE_LIMIT = 100;
/** Each retained original is represented by a reference plus at most the requested terminal. */
export const OWNER_FILTER_CLOSURE_ORIGINAL_LIMIT = Math.floor(OWNER_FILTER_CLOSURE_REFERENCE_LIMIT / 2);
