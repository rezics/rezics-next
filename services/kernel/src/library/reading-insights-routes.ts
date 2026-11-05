import { t } from 'elysia';
import type { TSchema } from 'typebox';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import { ProblemError, problemSchema } from '../http/problem.ts';
import type { ConsumptionSummary } from './consumption-statistics.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { ReportedYearSummary } from './reported-year-summary.ts';
import {
  createReadingInsightsAssessmentReads,
  type ReadingInsightsAssessments,
} from './reading-insights-assessments.ts';
import type { ReadingInsightsCurrentProgress } from './reading-insights-current-progress.ts';
import { createReadingInsightsProfileReads, type ReadingInsightsProfiles } from './reading-insights-profiles.ts';
import { createReadingInsightsOverviewReads, type ReadingInsightsOverview } from './reading-insights-overview.ts';

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

const assessmentCounts = {
  absent: count,
  explicitNull: count,
  value: count,
  historicalUnknown: count,
};

const readingInsightsCurrentProgressGroupSchema = t.Object(
  {
    meaning: t.Object(
      {
        profilePin: profile,
        unitId: t.String({ minLength: 1, maxLength: 128 }),
        meaningRevision: t.Integer({ minimum: 1, maximum: 16 }),
        mode: t.Union([t.Literal('scalar_amount'), t.Literal('cursor_position'), t.Literal('completed_units')]),
        unit: t.String({ minLength: 1, maxLength: 128 }),
        dimension: t.Union([t.String({ maxLength: 128 }), t.Null()]),
        precision: t.Union([t.Integer({ minimum: 0, maximum: 6 }), t.Null()]),
        minimum: t.Union([t.String(), t.Null()]),
        maximum: t.Union([t.String(), t.Null()]),
        totalPolicy: t.Union([t.Literal('optional'), t.Literal('required'), t.Literal('forbidden'), t.Null()]),
        identityKind: t.Union([t.Literal('none'), t.Literal('session_local')]),
        structureKind: t.Literal('none'),
        locator: t.Union([t.String({ maxLength: 256 }), t.Null()]),
      },
      closed,
    ),
    occurrences: count,
    currentValue: t.Union([t.String(), t.Null()]),
    currentValueCount: count,
    missingCurrentValueCount: count,
    totalValue: t.Union([t.String(), t.Null()]),
    totalValueCount: count,
    missingTotalValueCount: count,
  },
  closed,
);
const readingInsightsCurrentProgressScopeSchema = t.Object(
  {
    sessionCount: count,
    coveredSessions: count,
    groups: t.Array(readingInsightsCurrentProgressGroupSchema, { maxItems: 8 }),
    remainder: t.Object(
      {
        groupCount: count,
        occurrences: count,
        currentValueCount: count,
        missingCurrentValueCount: count,
        totalValueCount: count,
        missingTotalValueCount: count,
      },
      closed,
    ),
  },
  closed,
);
export const readingInsightsCurrentProgressSchema = t.Unsafe<ReadingInsightsCurrentProgress>(
  t.Union([
    t.Object(
      {
        state: t.Literal('unavailable'),
        reason: t.Union([t.Literal('not_installed'), t.Literal('initializing'), t.Literal('maintenance_unavailable')]),
        coverage: t.Object(
          { initializedSessions: t.Union([count, t.Null()]), retainedSessions: t.Union([count, t.Null()]) },
          closed,
        ),
      },
      closed,
    ),
    t.Object(
      {
        state: t.Literal('available'),
        scope: t.Literal('active_and_backlog_sessions'),
        coverage: t.Object(
          {
            initializedSessions: count,
            retainedSessions: count,
            currentSessions: count,
            activeSessions: count,
            backlogSessions: count,
            coveredSessions: count,
            unsupportedSessions: count,
          },
          closed,
        ),
        currentness: t.Object(
          {
            state: t.Literal('snapshot'),
            source: t.Literal('reading_insights_current_progress_v1'),
            revision: t.String({ maxLength: 36 }),
            retainedSourceRevision: t.String({ maxLength: 36 }),
          },
          closed,
        ),
        active: readingInsightsCurrentProgressScopeSchema,
        backlog: readingInsightsCurrentProgressScopeSchema,
        limit: t.Literal(8),
      },
      closed,
    ),
  ]),
);
export const readingInsightsAssessmentsSchema = t.Unsafe<ReadingInsightsAssessments>(
  t.Union([
    t.Object(
      {
        scope: t.Literal('retained_nonretired_sessions'),
        state: t.Literal('available'),
        coverage: t.Object({ ...coverage, includedSessions: count }, closed),
        currentness: t.Object(
          {
            state: t.Literal('snapshot'),
            source: t.Literal('reading_insights_assessments_v1'),
            revision: t.String({ maxLength: 36 }),
            retainedSourceRevision: t.String({ maxLength: 36 }),
          },
          closed,
        ),
        revisions: t.Array(
          t.Object(
            {
              meaningRevision: t.Integer({ minimum: 1, maximum: 16 }),
              counts: t.Object(assessmentCounts, closed),
              values: t.Array(t.Object({ units: t.Integer({ minimum: 0, maximum: 20 }), occurrences: count }, closed), {
                maxItems: 21,
              }),
            },
            closed,
          ),
          { maxItems: 16 },
        ),
      },
      closed,
    ),
    t.Object(
      {
        scope: t.Literal('retained_nonretired_sessions'),
        state: t.Literal('unavailable'),
        reason: t.Union([t.Literal('not_installed'), t.Literal('initializing'), t.Literal('maintenance_unavailable')]),
        coverage: t.Object(coverage, closed),
      },
      closed,
    ),
  ]),
);

const failureReason = t.Union([
  t.Literal('semantic_not_ready'),
  t.Literal('dependency_unavailable'),
  t.Literal('overloaded'),
  t.Literal('partition_unavailable'),
  t.Literal('transaction_retry_exhausted'),
  t.Literal('deadline_exceeded'),
]);
const panel = (value: TSchema) =>
  t.Union([
    t.Object({ status: t.Literal('received'), value }, closed),
    t.Object({ status: t.Literal('failed'), reason: failureReason }, closed),
  ]);
const summaryCounts = t.Object(
  {
    completedOccurrences: count,
    distinctCompletedSubjects: count,
    repeatOccurrences: count,
    completedOccurrencesWithUnknownProfile: count,
    finishPrecision: t.Object({ year: count, month: count, day: count }, closed),
  },
  closed,
);
const allTimeSummary = t.Unsafe<ConsumptionSummary>(
  t.Object(
    {
      scope: t.Literal('retained_native_sessions'),
      completedOccurrences: count,
      distinctCompletedSubjects: count,
      repeatOccurrences: count,
      completedOccurrencesWithUnknownProfile: count,
      coverage: t.Object(
        {
          nativeSessions: t.Literal('complete'),
          otherHistory: t.Literal('unavailable'),
          unitMeaning: t.Literal('not_evaluated'),
        },
        closed,
      ),
      currentness: t.Object({ state: t.Literal('snapshot'), revision: t.String({ maxLength: 36 }) }, closed),
    },
    closed,
  ),
);
const reportedYearSummary = t.Unsafe<ReportedYearSummary>(
  t.Object(
    {
      scope: t.Literal('retained_native_sessions'),
      year: t.Integer({ minimum: 1, maximum: 9999 }),
      calendar: t.Literal('gregorian'),
      dateSource: t.Literal('explicitly_reported_journal_finish'),
      ...summaryCounts.properties,
      months: t.Array(
        t.Object({ month: t.Integer({ minimum: 1, maximum: 12 }), ...summaryCounts.properties }, closed),
        {
          minItems: 12,
          maxItems: 12,
        },
      ),
      monthUnallocated: summaryCounts,
      coverage: t.Object(
        {
          nativeSessions: t.Literal('complete'),
          initializedSessions: count,
          retainedSessions: count,
          completedOccurrencesWithMissingFinish: count,
          completedOccurrencesWithUnsupportedFinish: count,
          otherHistory: t.Literal('unavailable'),
          unitMeaning: t.Literal('not_evaluated'),
        },
        closed,
      ),
      currentness: t.Object({ state: t.Literal('snapshot'), revision: t.String({ maxLength: 36 }) }, closed),
    },
    closed,
  ),
);
export const readingInsightsOverviewSchema = t.Unsafe<ReadingInsightsOverview>(
  t.Object(
    {
      scope: t.Literal('private_reading_insights'),
      year: t.Integer({ minimum: 1, maximum: 9999 }),
      panels: t.Object(
        {
          allTime: panel(allTimeSummary),
          reportedYear: panel(reportedYearSummary),
          profiles: panel(readingInsightsProfilesSchema),
          currentProgress: panel(readingInsightsCurrentProgressSchema),
          assessments: panel(readingInsightsAssessmentsSchema),
        },
        closed,
      ),
      actions: t.Object(
        {
          diary: t.Object(
            {
              operationId: t.Literal('library_diary.list'),
              query: t.Object({ year: t.Integer({ minimum: 1, maximum: 9999 }) }, closed),
            },
            closed,
          ),
          months: t.Array(
            t.Object(
              {
                operationId: t.Literal('library_diary.list'),
                query: t.Object(
                  {
                    year: t.Integer({ minimum: 1, maximum: 9999 }),
                    month: t.Integer({ minimum: 1, maximum: 12 }),
                  },
                  closed,
                ),
                month: t.Integer({ minimum: 1, maximum: 12 }),
              },
              closed,
            ),
            { minItems: 12, maxItems: 12 },
          ),
          unallocatedMonth: t.Object(
            {
              operationId: t.Literal('library_diary.list'),
              query: t.Object(
                {
                  year: t.Integer({ minimum: 1, maximum: 9999 }),
                  month: t.Literal('unallocated'),
                },
                closed,
              ),
            },
            closed,
          ),
        },
        closed,
      ),
    },
    closed,
  ),
);

/** Independent panel seam: it allocates no diary slot and performs no preparation. */
export function readingInsightsRoutes(app: ReturnType<typeof definitionRoutes>, deps: { pool: Pool }) {
  const reads = createReadingInsightsProfileReads(deps);
  const assessmentReads = createReadingInsightsAssessmentReads(deps);
  const overviewReads = createReadingInsightsOverviewReads(deps);
  return app
    .get(
      '/v1/libraryReadingInsights',
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
          200: readingInsightsOverviewSchema,
          400: problemSchema('invalid_request'),
          401: problemSchema('authentication_required', 'invalid_credentials'),
          403: problemSchema('forbidden', 'platform_closed'),
          503: problemSchema(
            'semantic_not_ready',
            'dependency_unavailable',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'library_reading_insights.overview',
          'x-exposure': 'gate:reading_progress',
          'x-action': 'progress_session:list',
          security: [{ bearerAuth: [] }],
          'x-authority-anchor': 'own-account',
          'x-authority-resource-types': Object.keys(bundledRelease.types),
        },
      },
      async ({ actor, admission, job, query, request }) =>
        admission.run('normal', job, () =>
          overviewReads.overview(
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
    )
    .get(
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
    )
    .get(
      '/v1/libraryReadingInsightsAssessments',
      {
        query: t.Object({}, closed),
        transform: ({ request, set }) => {
          set.headers['cache-control'] = 'private, no-store';
          if ([...new URL(request.url).searchParams.keys()].length > 0) throw new ProblemError('invalid_request');
        },
        response: {
          200: readingInsightsAssessmentsSchema,
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
          operationId: 'library_reading_insights.assessments',
          'x-exposure': 'gate:reading_progress',
          'x-action': 'progress_session:list',
          security: [{ bearerAuth: [] }],
          'x-authority-anchor': 'own-account',
          'x-authority-resource-types': Object.keys(bundledRelease.types),
        },
      },
      async ({ actor, admission, job, request }) =>
        admission.run('normal', job, () => assessmentReads.assessments(actor, job.deadline, request.signal)),
    );
}
