import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem-error.ts';
import { problemSchema } from '../http/problem-schema.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER } from '@rezics/operations/protocol';
import { idempotencyKeyOf } from '../http/idempotency-key.ts';
import { AuthenticationError } from '../request/authentication-error.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import {
  createYearlyCompletionGoalCommands,
  createYearlyCompletionGoalReads,
  YEARLY_COMPLETION_GOAL_METRIC,
  type YearlyCompletionGoalTargetRead,
} from './yearly-goal.ts';
import { createReportedYearSummaryReads, type ReportedYearSummary } from './reported-year-summary.ts';

const closed = { additionalProperties: false } as const;
const decimal = t.String({ pattern: '^[0-9]{1,19}$' });
const revision = t.String({ pattern: '^[1-9][0-9]{0,18}$' });
const nullableRevision = t.Union([revision, t.Null()]);
const count = t.Object(
  {
    completedOccurrences: decimal,
    distinctCompletedSubjects: decimal,
    repeatOccurrences: decimal,
    completedOccurrencesWithUnknownProfile: decimal,
    finishPrecision: t.Object({ year: decimal, month: decimal, day: decimal }, closed),
  },
  closed,
);
const monthCount = t.Object({ ...count.properties, month: t.Integer({ minimum: 1, maximum: 12 }) }, closed);
const reportedYear = t.Object(
  {
    ...count.properties,
    scope: t.Literal('retained_native_sessions'),
    year: t.Integer({ minimum: 1, maximum: 9999 }),
    calendar: t.Literal('gregorian'),
    dateSource: t.Literal('explicitly_reported_journal_finish'),
    months: t.Array(monthCount, {
      minItems: 12,
      maxItems: 12,
    }),
    monthUnallocated: count,
    coverage: t.Object(
      {
        nativeSessions: t.Literal('complete'),
        initializedSessions: decimal,
        retainedSessions: decimal,
        completedOccurrencesWithMissingFinish: decimal,
        completedOccurrencesWithUnsupportedFinish: decimal,
        otherHistory: t.Literal('unavailable'),
        unitMeaning: t.Literal('not_evaluated'),
      },
      closed,
    ),
    currentness: t.Object({ state: t.Literal('snapshot'), revision: t.String() }, closed),
  },
  closed,
);
const target = t.Union([
  t.Object({ state: t.Literal('none'), revision: nullableRevision }, closed),
  t.Object({ state: t.Literal('set'), target: t.Integer({ minimum: 1, maximum: 1000 }), revision }, closed),
  t.Object({ state: t.Literal('unavailable'), reason: t.Literal('not_installed') }, closed),
]);
const availableAction = t.Object({ allowed: t.Literal(true) }, closed);
const action = t.Union([
  availableAction,
  t.Object(
    {
      allowed: t.Literal(false),
      reason: t.Union([t.Literal('target_unavailable'), t.Literal('no_target')]),
    },
    closed,
  ),
]);
function readResponse() {
  return memoizedValue(readResponse, () =>
    t.Object(
      {
        year: t.Integer({ minimum: 1, maximum: 9999 }),
        metric: t.Literal(YEARLY_COMPLETION_GOAL_METRIC),
        viewer: t.Object(
          {
            state: t.Literal('owner'),
            actions: t.Object({ editTarget: action, clearTarget: action, navigateYear: availableAction }, closed),
          },
          closed,
        ),
        target,
        progress: t.Union([
          t.Object({ state: t.Literal('available'), summary: reportedYear }, closed),
          t.Object({ state: t.Literal('unavailable'), reason: t.Literal('summary_unavailable') }, closed),
        ]),
      },
      closed,
    ),
  );
}
function changeResponse() {
  return memoizedValue(changeResponse, () =>
    t.Object(
      {
        year: t.Integer({ minimum: 1, maximum: 9999 }),
        metric: t.Literal(YEARLY_COMPLETION_GOAL_METRIC),
        target: t.Union([t.Integer({ minimum: 1, maximum: 1000 }), t.Null()]),
        revision,
      },
      closed,
    ),
  );
}
function unauthorized() {
  return memoizedValue(unauthorized, () => problemSchema('authentication_required', 'invalid_credentials'));
}
function forbidden() {
  return memoizedValue(forbidden, () => problemSchema('forbidden'));
}
function invalid() {
  return memoizedValue(invalid, () => problemSchema('invalid_request'));
}
function conflict() {
  return memoizedValue(conflict, () => problemSchema('conflict'));
}
function idempotencyConflict() {
  return memoizedValue(idempotencyConflict, () => problemSchema('idempotency_conflict'));
}
function unavailable() {
  return memoizedValue(unavailable, () =>
    problemSchema(
      'semantic_not_ready',
      'overloaded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'deadline_exceeded',
      'dependency_unavailable',
    ),
  );
}
function idempotencyHeaders() {
  return memoizedValue(idempotencyHeaders, () =>
    t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
  );
}
function writeRate() {
  return memoizedValue(writeRate, () => defineRateLimit({ family: 'write', units: 1 }));
}

function detail(operationId: string, actionName: string, isWrite = false) {
  return {
    operationId,
    'x-exposure': 'gate:reading_progress',
    'x-action': actionName,
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': Object.keys(bundledRelease.types),
    security: [{ bearerAuth: [] }],
    ...(isWrite ? { 'x-rate-limit': writeRate() } : {}),
  };
}

function requireAccount(actor: Actor) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  return actor;
}

function targetActions(value: YearlyCompletionGoalTargetRead) {
  if (value.state === 'unavailable')
    return {
      editTarget: { allowed: false as const, reason: 'target_unavailable' as const },
      clearTarget: { allowed: false as const, reason: 'target_unavailable' as const },
    };
  return {
    editTarget: { allowed: true as const },
    clearTarget:
      value.state === 'set' ? { allowed: true as const } : { allowed: false as const, reason: 'no_target' as const },
  };
}

function unavailableSummary(error: unknown): boolean {
  return error instanceof ProblemError && error.code === 'dependency_unavailable';
}

function mapCommandError(error: unknown): never {
  if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
  throw error;
}

export type YearlyCompletionGoalRouteDependencies = {
  pool: Pool;
  access: () => Access;
  clock?: KernelClock;
};

export const MAX_YEARLY_COMPLETION_GOAL_RESPONSE_BYTES = 20_480;

/** Owner target read and commands composed with the installed reported-year authority. */
export function yearlyCompletionGoalRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: YearlyCompletionGoalRouteDependencies,
) {
  const reads = createYearlyCompletionGoalReads(dependencies);
  const summaryReads = createReportedYearSummaryReads(dependencies);
  const commands = () =>
    createYearlyCompletionGoalCommands({
      pool: dependencies.pool,
      access: dependencies.access(),
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    });
  return app
    .get(
      '/v1/libraryYearlyCompletionGoal',
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
          200: readResponse(),
          400: invalid(),
          401: unauthorized(),
          403: forbidden(),
          503: unavailable(),
        },
        detail: detail('library_yearly_goal.read', 'progress_session:list'),
      },
      async ({ actor, admission, job, query, request }) => {
        const owner = requireAccount(actor);
        return admission.run('normal', job, async () => {
          const currentTarget = await reads.target(owner, query.year, job.deadline, request.signal);
          let progress:
            | { state: 'available'; summary: ReportedYearSummary }
            | { state: 'unavailable'; reason: 'summary_unavailable' };
          try {
            progress = {
              state: 'available',
              summary: await summaryReads.summary(owner, query.year, job.deadline, request.signal),
            };
          } catch (error) {
            if (!unavailableSummary(error)) throw error;
            progress = { state: 'unavailable', reason: 'summary_unavailable' };
          }
          const result = {
            year: query.year,
            metric: YEARLY_COMPLETION_GOAL_METRIC,
            viewer: {
              state: 'owner' as const,
              actions: { ...targetActions(currentTarget), navigateYear: { allowed: true as const } },
            },
            target: currentTarget,
            progress,
          };
          const encoded = JSON.stringify(result);
          if (new TextEncoder().encode(encoded).byteLength > MAX_YEARLY_COMPLETION_GOAL_RESPONSE_BYTES)
            throw new ProblemError('dependency_unavailable');
          return new Response(encoded, {
            headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
          });
        });
      },
    )
    .put(
      '/v1/libraryYearlyCompletionGoal',
      {
        headers: idempotencyHeaders(),
        transform: ({ set }) => {
          set.headers['cache-control'] = 'private, no-store';
        },
        body: t.Object(
          {
            year: t.Integer({ minimum: 1, maximum: 9999 }),
            metric: t.Literal(YEARLY_COMPLETION_GOAL_METRIC),
            target: t.Union([t.Integer({ minimum: 1, maximum: 1000 }), t.Null()]),
            expectedRevision: t.Union([revision, t.Null()]),
          },
          closed,
        ),
        response: {
          200: changeResponse(),
          400: invalid(),
          401: unauthorized(),
          403: forbidden(),
          409: conflict(),
          422: idempotencyConflict(),
          410: problemSchema('command_result_erased'),
          503: unavailable(),
        },
        detail: detail('library_yearly_goal.update', 'progress_session:update', true),
      },
      async ({ actor, admission, job, body, headers }) => {
        const owner = requireAccount(actor);
        return admission.run('normal', job, async () => {
          try {
            const result = await commands().change(owner, body, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]));
            return result.value;
          } catch (error) {
            mapCommandError(error);
          }
        });
      },
    );
}
