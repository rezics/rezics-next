import { type Context, type UnwrapRoute } from 'elysia';
import { accountFailure } from '../modules/account/problems.ts';
import { authorityFailure } from '../modules/access/composition.ts';
import { workReadFailure } from '../modules/work/read-problems.ts';
import { readWorkHeader } from '../modules/work/read-header.ts';
import { publicWorkRead, workRead } from '../modules/work/read-session.ts';
import { recoveryFailure } from '../modules/work/scalar-problems.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { logExpectedFailure, opaqueCommandFailure } from './problems.ts';
import { workHeaderModels, workHeaderOperation } from './work-header.contract.ts';

type HeaderContext = Context<UnwrapRoute<typeof workHeaderOperation.options, typeof workHeaderModels>>;

export function workHeaderHandler(work: MainWorkDependencies) {
  return async ({ request, params, query, set }: Pick<HeaderContext, 'request' | 'params' | 'query' | 'set'>) => {
    try {
      const read = query.actingSubject ? workRead : publicWorkRead;
      const result = await read(work, request, { ...query, localBasis: true },
        session => readWorkHeader(session, `https://rezics.com/id/${params.id}`));
      set.headers['cache-control'] = 'private, no-store';
      return result;
    } catch (error) {
      set.headers['cache-control'] = 'no-store';
      const failure = workReadFailure(error) ?? accountFailure(error, set)
        ?? authorityFailure(error, set) ?? recoveryFailure(error);
      if (failure) {
        // Work read unavailability already records its more specific fault.
        if (failure.response.code !== 'work_read_unavailable') logExpectedFailure(error, failure.status);
        return failure;
      }
      return opaqueCommandFailure(error, set);
    }
  };
}
