/** Compatibility entry: Library owns the complete native preparation Source declaration. */
export {
  MEMBERS_PREPARATION_SOURCE_AXES,
  MEMBERS_PREPARATION_SOURCE_TERMS,
  MEMBERS_PREPARATION_SOURCE_COST,
  MEMBERS_PREPARATION_SOURCE_DECLARATION,
  type MembersPreparationSourceCost,
} from '../library/adapters/index.ts';

import { MEMBERS_PREPARATION_SOURCE_PATHS as preparationSourcePaths } from '../library/adapters/index.ts';

/** Preserve Search's callable entry over the single Library-owned schedule. */
export function MEMBERS_PREPARATION_SOURCE_PATHS() {
  return preparationSourcePaths();
}
