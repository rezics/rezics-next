import { t } from 'elysia';
import { pendingOperation, workScalarValue, workScalarWrite } from '../api-contract.ts';
import { accountProblems } from '../modules/account/problems.ts';
import { authorityDenied } from '../modules/access/admission-problems.ts';
import { dependencyUnavailable, internalError, invalidRequest } from '../modules/problem.ts';
import { rateLimitedSchema, rateLimitUnavailable, rateLimitUnclassified } from '../modules/rate-limit/problems.ts';
import { scalarProblemSchemas } from '../modules/work/scalar-problems.ts';
import { groupUuid } from './shared.ts';

const policy = { exposure: 'public', rateLimitFamily: 'write', bearer: true } as const;

export const workScalarModels = {
  WorkScalarWrite: workScalarWrite, WorkScalarPending: pendingOperation,
  WorkScalarInvalid: t.Union([invalidRequest.schema, scalarProblemSchemas[400]]),
  WorkScalarUnauthorized: accountProblems[401],
  WorkScalarDenied: authorityDenied.schema,
  WorkScalarMissing: scalarProblemSchemas[404],
  WorkScalarConflict: scalarProblemSchemas[409],
  WorkScalarLimited: rateLimitedSchema,
  WorkScalarInternal: internalError.schema,
  WorkScalarUnavailable: t.Union([dependencyUnavailable.schema, scalarProblemSchemas[503],
    rateLimitUnavailable.schema, rateLimitUnclassified.schema]),
};

export const workScalarOperation = {
  method: 'post', path: '/v1/works/:id/scalar-value',
  policy,
  options: {
    exposure: policy.exposure, rateLimit: policy.rateLimitFamily,
    params: t.Object({ id: groupUuid }),
    body: t.Object({ profile: t.Literal('work-scalar-state-v1'),
      expectedHead: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      scalarValue: t.Optional(workScalarValue),
      actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
    }, { additionalProperties: false }),
    response: { 200: 'WorkScalarWrite', 202: 'WorkScalarPending', 400: 'WorkScalarInvalid',
      401: 'WorkScalarUnauthorized', 403: 'WorkScalarDenied', 404: 'WorkScalarMissing',
      409: 'WorkScalarConflict', 429: 'WorkScalarLimited', 500: 'WorkScalarInternal', 503: 'WorkScalarUnavailable' },
  },
} as const;
