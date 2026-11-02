import type { Pool } from 'pg';
import { advanceLibraryIdentityNativePlan, advanceLibraryIdentityNativePlanWithWork } from './identity-native-planner.ts';
import { readLibraryScopeEffectsPage, verifyLibraryScopeEffectsSeal } from './identity-scope-effects.ts';
import { identitySourceConsumerLibraryWork, type IdentitySourceConsumerMaintenanceContext } from '../semantic/identity-source-consumer-maintenance.ts';
import type { LibraryIdentityPlanInput } from './identity-native-planner-types.ts';

/** Default native producer ports. These never borrow receiving acknowledgments or publish a ready Source. */
export function createLibraryIdentityNativePlanner({pool}: {pool: Pool}) {
  return Object.freeze({
    advance: (input: LibraryIdentityPlanInput) => advanceLibraryIdentityNativePlan(pool, input),
    readPage: (input: Parameters<typeof readLibraryScopeEffectsPage>[1]) => readLibraryScopeEffectsPage(pool, input),
    verifySeal: verifyLibraryScopeEffectsSeal,
    /** Source owns the frame/parent. Its existing prepaid Library partition is consumed in place. */
    advancePrepaid(input: Omit<LibraryIdentityPlanInput, 'allowance'>, context: IdentitySourceConsumerMaintenanceContext) {
      const work = identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, input.deadline);
      if (!work || input.deadline !== context.deadline) throw new TypeError('Missing live prepaid Library partition');
      return advanceLibraryIdentityNativePlanWithWork(pool, input, work);
    },
  });
}
export { libraryIdentityFootprint } from './identity-native-planner-work.ts';
