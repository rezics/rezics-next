import { problem, type Context, type UnwrapRoute } from 'elysia';
import { actingContextFailure, actingContextUnavailable } from '../modules/access/composition.ts';
import type { VerifiedAccountAssertion } from '../modules/account/verify-assertion.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { logExpectedFailure, opaqueCommandFailure } from './problems.ts';
import { actingContextPreferenceModels, actingContextPreferenceOperation } from './acting-context-preference.contract.ts';

type PreferenceContext = Context<UnwrapRoute<typeof actingContextPreferenceOperation.options, typeof actingContextPreferenceModels>>;

export function actingContextPreferenceHandler(work: MainWorkDependencies) {
  return async ({ body, set, principal }: Pick<PreferenceContext, 'body' | 'set'> & { principal: VerifiedAccountAssertion }) => {
    set.headers['cache-control'] = 'no-store';
    try {
      if (!work.actingContexts) return problem(actingContextUnavailable.body);
      return await work.actingContexts.setPreference(principal, {
        actingSubject: body.actingSubject, expectedRevision: body.expectedRevision,
        idempotencyKey: body.idempotencyKey,
      });
    } catch (error) {
      const failure = actingContextFailure(error);
      if (failure) { logExpectedFailure(error, failure.status); return failure; }
      return opaqueCommandFailure(error, set);
    }
  };
}
