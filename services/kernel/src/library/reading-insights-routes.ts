import { t } from 'elysia';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import { ProblemError, problemSchema } from '../http/problem.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { createReadingInsightsProfileReads, type ReadingInsightsProfiles } from './reading-insights-profiles.ts';

const closed = { additionalProperties: false } as const;
const count = t.String({ pattern: '^[0-9]{1,19}$' });
const counts = { completedOccurrences: count, repeatOccurrencesWithinProfile: count };
const coverage = { initializedSessions: t.Union([count, t.Null()]), retainedSessions: t.Union([count, t.Null()]) };
const scope = { scope: t.Literal('selected_reported_year'), year: t.Integer({ minimum: 1, maximum: 9999 }) };
const profile = t.Object(
  {
    provenance: t.Union([t.Literal('profile'), t.Literal('legacy')]),
    releaseDigest: t.String({ pattern: '^sha256:[0-9a-f]{64}$' }),
    profileId: t.String({ minLength: 1, maxLength: 1024 }),
    acceptingType: t.Union([t.String({ minLength: 1, maxLength: 1024 }), t.Null()]),
  },
  closed,
);
export const readingInsightsProfilesSchema = t.Unsafe<ReadingInsightsProfiles>(
  t.Union([
    t.Object(
      {
        ...scope,
        state: t.Literal('available'),
        dateSource: t.Literal('explicitly_reported_journal_finish'),
        grouping: t.Literal('exact_retained_profile_pin'),
        historicalLabels: t.Literal('unavailable'),
        coverage: t.Object(
          { ...coverage, nativeSessions: t.Literal('complete'), otherHistory: t.Literal('unavailable') },
          closed,
        ),
        currentness: t.Object(
          {
            state: t.Literal('snapshot'),
            source: t.Literal('reading_insights_v1'),
            revision: t.String({ maxLength: 36 }),
            retainedSourceRevision: t.String({ maxLength: 36 }),
          },
          closed,
        ),
        totals: t.Object(counts, closed),
        profiles: t.Array(t.Object({ ...counts, profile }, closed), { maxItems: 8 }),
        unknown: t.Object(counts, closed),
        remainder: t.Object({ ...counts, profileGroups: count }, closed),
        limit: t.Literal(8),
      },
      closed,
    ),
    t.Object(
      {
        ...scope,
        state: t.Literal('unavailable'),
        reason: t.Union([t.Literal('not_installed'), t.Literal('initializing'), t.Literal('maintenance_unavailable')]),
        coverage: t.Object(coverage, closed),
      },
      closed,
    ),
  ]),
);

/** Independent panel seam: it allocates no diary slot and performs no preparation. */
export function readingInsightsRoutes(app: ReturnType<typeof definitionRoutes>, deps: { pool: Pool }) {
  const reads = createReadingInsightsProfileReads(deps);
  return app.get(
    '/v1/libraryReadingInsightsProfiles',
    {
      query: t.Object({ year: t.Numeric({ minimum: 1, maximum: 9999, multipleOf: 1 }) }, closed),
      transform: ({ request, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        const query = new URL(request.url).searchParams;
        if (
          [...query.keys()].some((key) => key !== 'year') ||
          query.getAll('year').length !== 1 ||
          !/^[1-9][0-9]{0,3}$/.test(query.get('year') ?? '')
        )
          throw new ProblemError('invalid_request');
      },
      response: {
        200: readingInsightsProfilesSchema,
        400: problemSchema('invalid_request'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        403: problemSchema('forbidden', 'platform_closed'),
        503: problemSchema(
          'dependency_unavailable',
          'overloaded',
          'partition_unavailable',
          'transaction_retry_exhausted',
          'deadline_exceeded',
        ),
      },
      detail: {
        operationId: 'library_reading_insights.profiles',
        'x-exposure': 'gate:reading_progress',
        'x-action': 'progress_session:list',
        security: [{ bearerAuth: [] }],
        'x-authority-anchor': 'own-account',
        'x-authority-resource-types': Object.keys(bundledRelease.types),
      },
    },
    async ({ actor, admission, job, query, request }) =>
      admission.run('normal', job, () =>
        reads.profiles(
          actor,
          query.year,
          job.deadline,
          request.signal,
          (_value, encoded) =>
            new Response(encoded, {
              headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
            }),
        ),
      ),
  );
}
