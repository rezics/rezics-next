import type { Pool, PoolClient } from 'pg';
import { readAccount } from './access-port.ts';
import type { KernelClock } from '../clock.ts';
import type { CommandResult } from '../command/command.ts';
import { partitionReadClientObservation, withBoundedReadConnection } from '../database/pool.ts';
import { withReadingDashboardReadConnection } from './reading-dashboard-read-connection.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { Partition } from '../partition/partition.ts';
import { AuthenticationError } from '../request/authentication-error.ts';
import type { Access, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { createLibraryCommandRunner } from './command-support.ts';
import {
  createReportedYearSummaryReads,
  reportedYearRevision,
  type ReportedYearSummary,
} from './reported-year-summary.ts';

export const YEARLY_COMPLETION_GOAL_METRIC = 'completed_consumption_occurrences' as const;
export const YEARLY_COMPLETION_GOAL_TARGET_MIN = 1;
export const YEARLY_COMPLETION_GOAL_TARGET_MAX = 1000;
const MAX_REVISION = 9_223_372_036_854_775_807n;
const CHANGE_EVENT = 'com.rezics.library.yearly-goal.changed.v1';

export type YearlyCompletionGoalChange = Readonly<{
  year: number;
  metric: typeof YEARLY_COMPLETION_GOAL_METRIC;
  target: number | null;
  expectedRevision: string | null;
}>;

export type YearlyCompletionGoalTargetRead =
  | Readonly<{ state: 'none'; revision: string | null }>
  | Readonly<{ state: 'set'; target: number; revision: string }>
  | Readonly<{ state: 'unavailable'; reason: 'not_installed' }>;

export type YearlyCompletionGoalRead = Readonly<{
  target: YearlyCompletionGoalTargetRead;
  progress:
    | Readonly<{ state: 'available'; summary: ReportedYearSummary }>
    | Readonly<{ state: 'unavailable'; reason: 'summary_unavailable' }>;
}>;

export type YearlyCompletionGoalChangeResult = Readonly<{
  year: number;
  metric: typeof YEARLY_COMPLETION_GOAL_METRIC;
  target: number | null;
  revision: string;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict native validation; JSON numbers and explicit absence never coerce. */
export function validateYearlyCompletionGoalChange(value: unknown): YearlyCompletionGoalChange {
  if (!record(value)) throw new ProblemError('invalid_request');
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !keys.every((key) => ['year', 'metric', 'target', 'expectedRevision'].includes(key)) ||
    !Number.isInteger(value.year) ||
    (value.year as number) < 1 ||
    (value.year as number) > 9999 ||
    value.metric !== YEARLY_COMPLETION_GOAL_METRIC ||
    (value.target !== null &&
      (!Number.isInteger(value.target) ||
        (value.target as number) < YEARLY_COMPLETION_GOAL_TARGET_MIN ||
        (value.target as number) > YEARLY_COMPLETION_GOAL_TARGET_MAX)) ||
    (value.expectedRevision !== null &&
      (typeof value.expectedRevision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.expectedRevision))) ||
    (value.target === null && value.expectedRevision === null)
  )
    throw new ProblemError('invalid_request');
  if (value.expectedRevision !== null && BigInt(value.expectedRevision as string) > MAX_REVISION)
    throw new ProblemError('invalid_request');
  return value as YearlyCompletionGoalChange;
}

function isMissingInstallation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error.code === '42P01' || error.code === '42703')
  );
}

export function createYearlyCompletionGoalReads(dependencies: { pool: Pool }) {
  const summaryReads = createReportedYearSummaryReads(dependencies);
  async function read<T>(
    actor: Actor,
    year: number,
    deadline: number,
    signal: AbortSignal | undefined,
    includeProgress: boolean,
    deliver: (value: YearlyCompletionGoalRead) => T,
  ): Promise<T> {
    if (!Number.isInteger(year) || year < 1 || year > 9999) throw new ProblemError('invalid_request');
    if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
    const owner = { ...actor, scopes: [...actor.scopes] };
    const route = routeOf(owner.accountId);
    if (route === null || !owner.scopes.includes('progress_session:list')) throw new ProblemError('forbidden');
    const alive = () => {
      if (signal?.aborted || Date.now() >= deadline) throw new ProblemError('deadline_exceeded');
    };
    alive();
    const authorize = async (client: PoolClient) => {
      const current = await readAccount(client, route, owner.accountId);
      if (
        !current ||
        current.kind !== 'actor' ||
        current.state !== 'active' ||
        current.fenced ||
        !Number.isSafeInteger(owner.authnEpoch) ||
        owner.authnEpoch < 1 ||
        current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
      )
        throw new ProblemError('forbidden');
    };
    let captured: { target: YearlyCompletionGoalTargetRead; home: Partition };
    try {
      const readOptions = { deadline, ...(signal === undefined ? {} : { signal }) };
      captured = await withReadingDashboardReadConnection(dependencies.pool, readOptions, async (client) => {
        await client.query('BEGIN');
        await client.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE', [
          route,
          owner.accountId,
        ]);
        await authorize(client);
        const { partition: home } = await partitionReadClientObservation(client, partitionOf(route));
        alive();
        let row: { target: number | null; revision: string } | undefined;
        try {
          row = (
            await client.query<{ target: number | null; revision: string }>(
              `SELECT target,revision::text FROM library.yearly_completion_goal
                   WHERE route=$1 AND account_id=$2 AND year=$3`,
              [route, owner.accountId, year],
            )
          ).rows[0];
        } catch (error) {
          if (isMissingInstallation(error)) throw new TargetInstallationUnavailableError(home);
          throw error;
        }
        alive();
        await client.query('COMMIT');
        alive();
        const target: YearlyCompletionGoalTargetRead = !row
          ? { state: 'none', revision: null }
          : row.target === null
            ? { state: 'none', revision: row.revision }
            : { state: 'set', target: row.target, revision: row.revision };
        return { target, home };
      });
    } catch (error) {
      if (!(error instanceof TargetInstallationUnavailableError)) throw error;
      captured = { target: { state: 'unavailable', reason: 'not_installed' }, home: error.home };
    }
    let progress: YearlyCompletionGoalRead['progress'] = { state: 'unavailable', reason: 'summary_unavailable' };
    if (includeProgress) {
      alive();
      try {
        progress = { state: 'available', summary: await summaryReads.summary(owner, year, deadline, signal) };
      } catch (error) {
        if (!(error instanceof ProblemError) || error.code !== 'dependency_unavailable') throw error;
      }
    }
    alive();
    // Reobserve admission outside both source reads, including their unavailable
    // branches. The captured target revision is independent of the progress head.
    return withBoundedReadConnection(
      dependencies.pool,
      deadline,
      async (client) => {
        alive();
        if (progress.state === 'available') {
          try {
            if ((await reportedYearRevision(client, route, owner.accountId)) !== progress.summary.currentness.revision)
              progress = { state: 'unavailable', reason: 'summary_unavailable' };
          } catch (error) {
            if (!(error instanceof ProblemError) || error.code !== 'dependency_unavailable') throw error;
            progress = { state: 'unavailable', reason: 'summary_unavailable' };
          }
          alive();
        }
        const { partition: home } = await partitionReadClientObservation(client, captured.home.partitionNo);
        if (home.node !== captured.home.node || home.epoch !== captured.home.epoch)
          throw new ProblemError('partition_unavailable');
        alive();
        await authorize(client);
        alive();
        const result = deliver({ target: captured.target, progress });
        alive();
        return result;
      },
      {
        deadlineError: () => new ProblemError('deadline_exceeded'),
        isUncertainSettledQueryError: () => true,
      },
    );
  }
  return {
    target(
      actor: Actor,
      year: number,
      deadline: number,
      signal?: AbortSignal,
    ): Promise<YearlyCompletionGoalTargetRead> {
      return read(actor, year, deadline, signal, false, (value) => value.target);
    },
    /** Delivery is synchronous so HTTP encoding remains inside final admission. */
    read<T = YearlyCompletionGoalRead>(
      actor: Actor,
      year: number,
      deadline: number,
      signal?: AbortSignal,
      deliver?: (value: YearlyCompletionGoalRead) => T,
    ): Promise<T> {
      return read(actor, year, deadline, signal, true, (value) => (deliver ? deliver(value) : (value as T)));
    },
  };
}

class TargetInstallationUnavailableError extends Error {
  constructor(readonly home: Partition) {
    super('Yearly completion goal is not installed');
  }
}

export function createYearlyCompletionGoalCommands(dependencies: { pool: Pool; access?: Access; clock?: KernelClock }) {
  const runner = createLibraryCommandRunner(dependencies);
  return {
    async change(actor: Actor, input: YearlyCompletionGoalChange, requestKey: string) {
      const value = validateYearlyCompletionGoalChange(input);
      if (value.target === null && value.expectedRevision === null) throw new ProblemError('invalid_request');
      const route = routeOf(actor.kind === 'account' ? actor.accountId : '');
      if (route === null || actor.kind !== 'account') throw new ProblemError('forbidden');
      return runner.ownAccount(
        actor,
        {
          action: 'progress_session:update',
          kind: 'library.yearly_completion_goal.change',
          requestKey,
          input: value,
        },
        async (tx): Promise<CommandResult<YearlyCompletionGoalChangeResult>> => {
          let row: { target: number | null; revision: string } | undefined;
          try {
            const changed =
              value.expectedRevision === null
                ? await tx.query<{ target: number | null; revision: string }>(
                    `INSERT INTO library.yearly_completion_goal(route,account_id,year,target,revision)
                     VALUES($1,$2,$3,$4::integer,1)
                     ON CONFLICT(route,account_id,year) DO NOTHING
                     RETURNING target,revision::text`,
                    [route, actor.accountId, value.year, value.target],
                  )
                : await tx.query<{ target: number | null; revision: string }>(
                    `UPDATE library.yearly_completion_goal SET target=$4::integer,revision=revision+1,
                       changed_at=clock_timestamp()
                     WHERE route=$1 AND account_id=$2 AND year=$3
                       AND revision=$5::bigint AND revision < 9223372036854775807
                       AND (target IS NOT NULL OR $4::integer IS NOT NULL)
                     RETURNING target,revision::text`,
                    [route, actor.accountId, value.year, value.target, value.expectedRevision],
                  );
            row = changed.rows[0];
          } catch (error) {
            if (isMissingInstallation(error)) throw new ProblemError('dependency_unavailable');
            throw error;
          }
          if (!row) throw new ProblemError('conflict');
          const changed = {
            year: value.year,
            metric: YEARLY_COMPLETION_GOAL_METRIC,
            target: row.target,
            revision: row.revision,
          } as const;
          return {
            value: changed,
            events: [
              {
                type: CHANGE_EVENT,
                subject: actor.accountId,
                data: { year: changed.year, revision: changed.revision },
              },
            ],
          };
        },
      );
    },
  };
}
