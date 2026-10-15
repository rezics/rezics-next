import { t } from 'elysia';
import { actingContextPreference } from '../api-responses.ts';
import { accountProblems } from '../modules/account/problems.ts';
import { actingContextProblemSchemas } from '../modules/access/composition.ts';
import { dependencyUnavailable, internalError } from '../modules/problem.ts';
import { rateLimitedSchema, rateLimitUnavailable, rateLimitUnclassified } from '../modules/rate-limit/problems.ts';

const policy = { exposure: 'public', rateLimitFamily: 'write', bearer: true } as const;

export const actingContextPreferenceModels = {
  ActingContextPreference: actingContextPreference,
  ActingContextPreferenceInvalid: actingContextProblemSchemas[400],
  ActingContextPreferenceUnauthorized: accountProblems[401],
  ActingContextPreferenceDenied: actingContextProblemSchemas[403],
  ActingContextPreferenceStale: actingContextProblemSchemas[409],
  ActingContextPreferenceLimited: rateLimitedSchema,
  ActingContextPreferenceInternal: internalError.schema,
  ActingContextPreferenceUnavailable: t.Union([actingContextProblemSchemas[503], dependencyUnavailable.schema,
    rateLimitUnavailable.schema, rateLimitUnclassified.schema]),
};

export const actingContextPreferenceOperation = {
  method: 'put', path: '/v1/me/acting-context-preferences/work.create',
  policy,
  options: {
    auth: ['work:create'], exposure: policy.exposure, rateLimit: policy.rateLimitFamily,
    body: t.Object({ profile: t.Literal('work-create-acting-context-preference-v1'),
      task: t.Literal('work.create'),
      actingSubject: t.Nullable(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
      expectedRevision: t.Nullable(t.String({ pattern: '^[0-9a-f-]{36}$' })),
      idempotencyKey: t.String({ minLength: 1, maxLength: 128 }),
    }, { additionalProperties: false }),
    response: { 200: 'ActingContextPreference', 400: 'ActingContextPreferenceInvalid',
      401: 'ActingContextPreferenceUnauthorized', 403: 'ActingContextPreferenceDenied',
      409: 'ActingContextPreferenceStale', 429: 'ActingContextPreferenceLimited',
      500: 'ActingContextPreferenceInternal', 503: 'ActingContextPreferenceUnavailable' },
  },
} as const;
