import type { Pool } from 'pg';
import {
  advanceLibraryIdentityNativePlan,
  advanceLibraryIdentityNativePlanWithWork,
} from './identity-native-planner.ts';
import {
  readLibraryScopeEffectsPage,
  verifyLibraryScopeEffectsSeal,
  type LibraryScopeEffectsPage,
} from './identity-scope-effects.ts';
import {
  identitySourceConsumerLibraryWork,
  type IdentitySourceConsumerMaintenanceContext,
} from '../semantic/identity-source-consumer-maintenance.ts';
import type { LibraryIdentityPlanInput, LibraryIdentityPlanResult } from './identity-native-planner-types.ts';

/** Named public ports retain the opaque seal through its owning page union during declaration emission. */
export type LibraryIdentityNativePlanner = Readonly<{
  advance(input: LibraryIdentityPlanInput): Promise<LibraryIdentityPlanResult>;
  readPage(input: Parameters<typeof readLibraryScopeEffectsPage>[1]): Promise<LibraryScopeEffectsPage>;
  verifySeal: typeof verifyLibraryScopeEffectsSeal;
  advancePrepaid(
    input: Omit<LibraryIdentityPlanInput, 'allowance'>,
    context: IdentitySourceConsumerMaintenanceContext,
  ): Promise<LibraryIdentityPlanResult>;
}>;

/** Default native producer ports. These never borrow receiving acknowledgments or publish a ready Source. */
export function createLibraryIdentityNativePlanner({ pool }: { pool: Pool }): LibraryIdentityNativePlanner {
  return Object.freeze({
    advance: (input: LibraryIdentityPlanInput) => advanceLibraryIdentityNativePlan(pool, input),
    readPage: (input: Parameters<typeof readLibraryScopeEffectsPage>[1]) => readLibraryScopeEffectsPage(pool, input),
    verifySeal: verifyLibraryScopeEffectsSeal,
    /** Source owns the frame/parent. Its existing prepaid Library partition is consumed in place. */
    advancePrepaid(
      input: Omit<LibraryIdentityPlanInput, 'allowance'>,
      context: IdentitySourceConsumerMaintenanceContext,
    ) {
      const work = identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, input.deadline);
      if (!work || input.deadline !== context.deadline) throw new TypeError('Missing live prepaid Library partition');
      return advanceLibraryIdentityNativePlanWithWork(pool, input, work);
    },
  });
}
export { libraryIdentityFootprint } from './identity-native-planner-work.ts';

export { createCollectionBulkOperations } from './collection-bulk-operation.ts';
export { readLibraryScopeEffectsPageWithWork } from './identity-scope-effects.ts';
export { nextLibraryIdentityNativePlanWithWork } from './identity-native-planner.ts';
export {
  declareLibraryIdentityStatement,
  assembleLibraryIdentityOriginalComponents,
  LIBRARY_IDENTITY_CHECKOUT_WORK,
  LIBRARY_IDENTITY_ORIGINAL_MISSING_OPERANDS,
  assembleLibraryIdentitySelectedBodies,
  LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES,
  LIBRARY_IDENTITY_SELECTED_MISSING_OPERANDS,
} from './identity-original-work.ts';
