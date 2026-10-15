import { Elysia } from 'elysia';
import { accountFailure } from '../modules/account/problems.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { opaqueCommandFailure, logExpectedFailure } from './problems.ts';

/** Native policy options. The composition root's budget hook and exposure
 * binding consume the contract's policy, so these options never charge twice. */
export function operationPolicies(work: MainWorkDependencies) {
  return new Elysia({ name: 'main-operation-policies' }).macro({
    auth: (scopes: readonly string[]) => ({
      async derive({ request, set }) {
        try { return { principal: await work.account.verify(request, scopes) }; }
        catch (error) {
          set.headers['cache-control'] = 'no-store';
          const failure = accountFailure(error, set);
          if (failure) { logExpectedFailure(error, failure.status); return failure; }
          return opaqueCommandFailure(error, set);
        }
      },
      detail: { security: [{ bearerAuth: [] }] },
    }),
    exposure: (exposure: 'public') => ({ detail: { 'x-rezics-exposure': exposure } }),
    rateLimit: (family: 'read' | 'write') => ({ meta: { rateLimitFamily: family } }),
  });
}
