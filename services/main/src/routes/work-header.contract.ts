import { t } from 'elysia';
import { accountProblems } from '../modules/account/problems.ts';
import { authorityDenied } from '../modules/access/admission-problems.ts';
import { dependencyUnavailable, internalError, invalidRequest } from '../modules/problem.ts';
import { rateLimitUnavailable, rateLimitUnclassified } from '../modules/rate-limit/problems.ts';
import { readQuery, readUuid, workHeader } from '../modules/work/read-contract.ts';
import { invalidWorkRead, readBasisChanged, readingContinuityUnsupported, workReadBudgetExceeded,
  workReadMissing, workReadUnavailable } from '../modules/work/read-problems.ts';
import { recoveryHold } from '../modules/work/scalar-problems.ts';

const detail: { security: Record<string, string[]>[] } = { security: [{}, { bearerAuth: [] }] };
const policy = { exposure: 'public', rateLimitFamily: 'read', bearer: false } as const;

export const workHeaderModels = {
  WorkHeader: workHeader,
  WorkHeaderInvalid: t.Union([invalidRequest.schema, invalidWorkRead.schema]),
  WorkHeaderUnauthorized: accountProblems[401],
  WorkHeaderDenied: authorityDenied.schema,
  WorkHeaderMissing: workReadMissing.schema,
  WorkHeaderMoved: readBasisChanged.schema,
  WorkHeaderLimit: workReadBudgetExceeded.schema,
  WorkHeaderInternal: internalError.schema,
  WorkHeaderUnavailable: t.Union([workReadUnavailable.schema, dependencyUnavailable.schema,
    readingContinuityUnsupported.schema, recoveryHold.schema, rateLimitUnavailable.schema, rateLimitUnclassified.schema]),
};

export const workHeaderOperation = {
  method: 'get', path: '/v1/works/:id',
  policy,
  options: {
    params: t.Object({ id: readUuid }), query: t.Object(readQuery, { additionalProperties: false }),
    exposure: policy.exposure, rateLimit: policy.rateLimitFamily,
    detail,
    response: { 200: 'WorkHeader', 400: 'WorkHeaderInvalid', 401: 'WorkHeaderUnauthorized',
      403: 'WorkHeaderDenied', 404: 'WorkHeaderMissing', 409: 'WorkHeaderMoved', 422: 'WorkHeaderLimit',
      500: 'WorkHeaderInternal', 503: 'WorkHeaderUnavailable' },
  },
} as const;
