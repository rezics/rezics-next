import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import type { KernelClock } from '../clock.ts';
import type { CommandResult } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { createLibraryCommandRunner } from './command-support.ts';

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
  return {
    async target(
      actor: Actor,
      year: number,
      deadline: number,
      signal?: AbortSignal,
    ): Promise<YearlyCompletionGoalTargetRead> {
      if (!Number.isInteger(year) || year < 1 || year > 9999) throw new ProblemError('invalid_request');
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const route = routeOf(actor.accountId);
      if (route === null || !actor.scopes.includes('progress_session:list')) throw new ProblemError('forbidden');
      const alive = () => {
        if (signal?.aborted || Date.now() >= deadline) throw new ProblemError('deadline_exceeded');
      };
      alive();
      return within(deadline, () =>
        withConnection(dependencies.pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          let committed = false;
          try {
            await client.query('BEGIN');
            await client.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE', [
              route,
              actor.accountId,
            ]);
            const authorize = async () => {
              const owner = await readAccount(client, route, actor.accountId);
              if (
                !owner ||
                owner.kind !== 'actor' ||
                owner.state !== 'active' ||
                owner.fenced ||
                !Number.isSafeInteger(actor.authnEpoch) ||
                actor.authnEpoch < 1 ||
                owner.minimumAuthnEpoch > BigInt(actor.authnEpoch)
              )
                throw new ProblemError('forbidden');
            };
            await authorize();
            alive();
            let row: { target: number | null; revision: string } | undefined;
            try {
              row = (
                await client.query<{ target: number | null; revision: string }>(
                  `SELECT target,revision::text FROM library.yearly_completion_goal
                   WHERE route=$1 AND account_id=$2 AND year=$3`,
                  [route, actor.accountId, year],
                )
              ).rows[0];
            } catch (error) {
              if (isMissingInstallation(error)) throw new TargetInstallationUnavailableError();
              throw error;
            }
            await authorize();
            alive();
            await client.query('COMMIT');
            committed = true;
            alive();
            if (!row) return { state: 'none', revision: null };
            return row.target === null
              ? { state: 'none', revision: row.revision }
              : { state: 'set', target: row.target, revision: row.revision };
          } catch (error) {
            if (!committed) await connection.query('ROLLBACK');
            if (error instanceof TargetInstallationUnavailableError)
              return { state: 'unavailable', reason: 'not_installed' };
            if (isMissingInstallation(error)) return { state: 'unavailable', reason: 'not_installed' };
            throw error;
          }
        }),
      );
    },
  };
}

class TargetInstallationUnavailableError extends Error {}

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
