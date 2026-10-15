import { problem, type Context, type UnwrapRoute } from 'elysia';
import { accountFailure } from '../modules/account/problems.ts';
import { admissionFailure } from '../modules/access/admission-problems.ts';
import { setAdmittedWorkScalar } from '../modules/work/edit-admitted.ts';
import { invalidIdempotencyKey, scalarFailure } from '../modules/work/scalar-problems.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { logExpectedFailure, opaqueCommandFailure } from './problems.ts';
import { workScalarModels, workScalarOperation } from './work-scalar.contract.ts';

type ScalarContext = Context<UnwrapRoute<typeof workScalarOperation.options, typeof workScalarModels>>;

export function workScalarHandler(work: MainWorkDependencies) {
  return async ({ request, params, body, set }: Pick<ScalarContext, 'request' | 'params' | 'body' | 'set'>) => {
    set.headers['cache-control'] = 'no-store';
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey || !/^[A-Za-z0-9:_./-]{1,128}$/.test(idempotencyKey)) {
      return problem(invalidIdempotencyKey.body);
    }
    try {
      const value = body.scalarValue;
      const receipt = await setAdmittedWorkScalar(work.environment, work.account, work.access,
        request, { work: `https://rezics.com/id/${params.id}`, expectedHead: body.expectedHead,
          ...(value === undefined ? {} : { scalarValue: value }),
          actingSubject: body.actingSubject, idempotencyKey });
      return { profile: 'work-scalar-state-v1' as const, work: receipt.work,
        revision: receipt.revision, predecessor: receipt.predecessor,
        ...(value === undefined ? {} : { scalarValue: value }),
        sourcePosition: { datasetId: 'product' as const, dataEpoch: receipt.dataEpoch,
          sequence: receipt.sequence }, replayed: receipt.replayed };
    } catch (error) {
      const failure = scalarFailure(error, set) ?? accountFailure(error, set) ?? admissionFailure(error, set);
      if (failure) { logExpectedFailure(error, failure.status); return failure; }
      return opaqueCommandFailure(error, set);
    }
  };
}
