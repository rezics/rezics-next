import type { Pool, PoolClient } from 'pg';
import type { LabelCommandAdmission } from './label-command-admission.ts';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  releaseOperationalTime,
  noEffect,
  type AuthoritativeTime,
  type CommandResult,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, Actor, AccountActor } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  createLibraryCommandRunner,
  LibraryNotFoundError,
  sameAccountRoute,
  WORK_STEP_DEADLINE_MS,
} from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import { assertAniListLabel, prepareAniListLabel, type AniListLabelGuard } from './list-import-anilist-label-guard.ts';
import { setLabelAssignment } from './label-assignment-store.ts';
import { unassignStoredLabelAssignment, restoreStoredLabelAssignment } from './label-assignment-lifecycle-store.ts';
import { admitShelfRead } from './shelf-admission.ts';
import { readLibraryEntryTiles, type LibraryEntryTile } from './library-entry-tiles.ts';
import { readPersonalLabel } from './label-store.ts';
import { resolveSubject } from './subject-anchor.ts';
import labelPage from './label-assignment-label-page.sql';
import subjectPage from './label-assignment-subject-page.sql';
import { assertMalLabelFence, prepareMalLabelFence, type MalLabelFence } from './list-import-mal-label-fence.ts';

type Client = Pick<PoolClient, 'query'>;
type Assignment = { id: string; labelId: string; subjectId: string; revision: number };
type Expected = { subjectId: string; assignmentId: string; revision: number };
type ExpectedTarget =
  | { id: string; revision: number; effective: boolean }
  | null
  | { labelId: string; assignmentId: string; revision: number; labelRevision: number };
type ListOptions = { labelId?: string; subjectId?: string; limit?: number; cursor?: string; view?: 'BASIC' | 'FULL' };
const invalid = () => new ProblemError('invalid_request');
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !keys.includes(k)))
    throw invalid();
  return input as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || routeOf(value) === null) throw invalid();
  return value;
}
function assignmentId(value: unknown): string {
  // Assignment identities are native random UUIDs, not routed resource identities.
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
    throw invalid();
  return value;
}
function owner(actor: Actor, action: string): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(action))
    throw new GrantDeniedError();
  return actor;
}
function input(value: unknown, expected: boolean) {
  const parsed = object(value, expected ? ['subjectId', 'assignmentId', 'revision'] : ['subjectId']);
  const subjectId = id(parsed.subjectId);
  if (!expected) return { subjectId };
  if (
    typeof parsed.revision !== 'number' ||
    !Number.isInteger(parsed.revision) ||
    parsed.revision < 1 ||
    parsed.revision > 2147483646
  )
    throw invalid();
  return { subjectId, assignmentId: assignmentId(parsed.assignmentId), revision: parsed.revision };
}
const minimal = (a: { id: string; revision: number }) => ({ assignment: { id: a.id, revision: a.revision } });
const events = (actor: AccountActor, labelId: string) => [
  { type: 'com.rezics.library.label.changed.v1', subject: actor.accountId, data: { labelId } },
];

/** Private commands over the native same-row reservation and retained identity DAOs. */
export function createLabelAssignmentCommands(deps: {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock?: KernelClock;
}) {
  const { pool, tokens } = deps,
    clock = deps.clock ?? systemClock;
  const runner = createLibraryCommandRunner({ pool, clock });
  async function snapshot<T>(
    actor: AccountActor,
    deadline: number,
    body: (client: Client, route: number) => Promise<T>,
  ) {
    return withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline),
        route = routeOf(actor.accountId)!;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const current = await readAccount(client, route, actor.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(actor.authnEpoch) ||
          actor.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(actor.authnEpoch)
        )
          throw new GrantDeniedError();
        const result = await body(client, route);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
  async function mutate(
    actor: Actor,
    labelId: string,
    value: unknown,
    key: string,
    operation: 'assign' | 'unassign' | 'restore',
    importGuard?: AniListLabelGuard | MalLabelFence | LabelCommandAdmission,
    expectedLabelRevision?: number,
    expectedSource?: { labelId: string; assignmentId: string; revision: number; labelRevision: number },
    expectedTarget?: ExpectedTarget,
  ) {
    const guard = importGuard && 'subjectId' in importGuard ? importGuard : undefined;
    const malLabelFence = importGuard && 'subject' in importGuard ? importGuard : undefined;
    const admission = importGuard && 'prepare' in importGuard ? importGuard : undefined;
    const account = owner(actor, 'library_entry:update');
    id(labelId);
    const parsed = input(value, operation !== 'assign');
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    const request = {
      action: 'library_entry:update',
      kind: `library_label.${operation === 'restore' ? 'assignment_restore' : operation}`,
      input: {
        labelId,
        ...parsed,
        ...(guard ? { importReview: guard } : {}),
        ...(malLabelFence ? { malLabelFence } : {}),
        ...(expectedLabelRevision === undefined ? {} : { expectedLabelRevision }),
        ...(expectedSource === undefined ? {} : { expectedSource }),
        ...(expectedTarget === undefined ? {} : { expectedTarget }),
        ...(admission ? { review: admission.input } : {}),
      },
      requestKey: key,
    };
    const execute = async (
      tx: Client,
      command: { transactionId: string; time: AuthoritativeTime },
      prepared: { subjectId?: string; error?: unknown; validate?: (tx: Client) => Promise<void> },
    ): Promise<
      CommandResult<(ReturnType<typeof minimal> & { unchanged?: boolean }) | { deleted: true; revision: number }>
    > => {
      if (prepared.error !== undefined) throw prepared.error;
      await prepared.validate?.(tx);
      if (malLabelFence) await assertMalLabelFence(tx, account, malLabelFence);
      const route = sameAccountRoute(account.accountId, labelId);
      const tuple = {
        route,
        accountId: account.accountId,
        labelId,
        subjectId: operation === 'assign' ? prepared.subjectId! : parsed.subjectId,
      };
      const context = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
      if (operation === 'assign') {
        if (guard) {
          await assertAniListLabel(tx, account, guard);
          const label = (
            await tx.query<{ revision: number }>(
              'SELECT revision FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3 AND deleted_at IS NULL FOR SHARE',
              [route, account.accountId, labelId],
            )
          ).rows[0];
          if (!label || label.revision !== guard.labelRevision) throw new LibraryConflictError();
        }
        const result = await setLabelAssignment(
          tx,
          {
            ...tuple,
            ...(expectedLabelRevision === undefined ? {} : { expectedLabelRevision }),
            ...(expectedSource === undefined ? {} : { expectedSource }),
            ...(expectedTarget === null || (expectedTarget && 'id' in expectedTarget) ? { expectedTarget } : {}),
          },
          context,
        );
        switch (result.kind) {
          case 'not_found':
            throw new LibraryNotFoundError();
          case 'capacity':
            throw new ProblemError('library_label_capacity');
          case 'migration_required':
            throw new ProblemError('index_not_ready');
          case 'changed':
            throw new LibraryConflictError();
          case 'existing':
            return noEffect({
              ...minimal(result.assignment),
              ...(guard || malLabelFence || admission || expectedLabelRevision !== undefined
                ? { unchanged: true }
                : {}),
            });
          case 'applied':
            return {
              value: {
                ...minimal(result.assignment),
                ...(guard || malLabelFence || admission || expectedLabelRevision !== undefined
                  ? { unchanged: false }
                  : {}),
              },
              events: events(account, labelId),
            };
        }
      }
      const expected = { ...tuple, ...(parsed as Expected) };
      if (operation === 'unassign') {
        const result = await unassignStoredLabelAssignment(
          tx,
          expected,
          context,
          expectedLabelRevision,
          expectedTarget && 'labelId' in expectedTarget
            ? {
                labelId: expectedTarget.labelId,
                assignmentId: expectedTarget.assignmentId,
                revision: expectedTarget.revision,
                labelRevision: expectedTarget.labelRevision,
              }
            : undefined,
        );
        switch (result.kind) {
          case 'not_found':
            throw new LibraryNotFoundError();
          case 'stale':
            throw new LibraryConflictError();
          case 'migration_required':
            throw new ProblemError('index_not_ready');
          case 'applied':
            return {
              value: { deleted: true as const, revision: result.assignment.revision },
              events: events(account, labelId),
            };
        }
      }
      const result = await restoreStoredLabelAssignment(tx, expected, context);
      switch (result.kind) {
        case 'not_found':
          throw new LibraryNotFoundError();
        case 'migration_required':
          throw new ProblemError('index_not_ready');
        case 'stale':
        case 'expired':
        case 'capacity':
          throw new ProblemError(`library_label_restore_${result.kind}`);
        case 'applied':
          return { value: minimal(result.assignment), events: events(account, labelId) };
      }
    };
    if (operation === 'unassign' && expectedLabelRevision === undefined)
      return runner.ownAccount(actor, request, (tx, command) => execute(tx, command, {}));
    return (guard || malLabelFence ? createLibraryCommandRunner(deps) : runner).ownAccountPrepared(
      actor,
      {
        ...request,
        async prepare(attempt) {
          try {
            if (operation === 'unassign') {
              const resolved = await withRequestDeadline(deadline, () =>
                resolveSubject(deps, account, parsed.subjectId, attempt.time),
              );
              if (!resolved) throw new LibraryNotFoundError();
              return { subjectId: resolved.subjectId };
            }
            if (guard) {
              const prepared = await prepareAniListLabel(deps, account, guard, attempt.time);
              if (prepared.error !== undefined) throw prepared.error;
              return { subjectId: guard.subjectId };
            }
            if (malLabelFence) await prepareMalLabelFence(deps, account, malLabelFence, attempt.time, deadline);
            const resolved = await withRequestDeadline(deadline, () =>
              resolveSubject(deps, account, parsed.subjectId, attempt.time),
            );
            if (!resolved) throw new LibraryNotFoundError();
            if (malLabelFence && resolved.subjectId !== malLabelFence.subject) throw new LibraryConflictError();
            return {
              subjectId: resolved.subjectId,
              ...(admission ? { validate: await admission.prepare(attempt.time) } : {}),
            };
          } catch (error) {
            return { error };
          }
        },
      },
      execute,
    );
  }
  // Operation-specific return types preserve the minimal receipt contract for native and HTTP consumers.
  async function assignLabel(
    actor: Actor,
    labelId: string,
    value: { subjectId: string },
    key: string,
    importGuard?: AniListLabelGuard | MalLabelFence | LabelCommandAdmission,
  ) {
    return (await mutate(
      actor,
      labelId,
      value,
      key,
      'assign',
      importGuard,
    )) as import('../command/command.ts').CommandOutcome<ReturnType<typeof minimal> & { unchanged?: boolean }>;
  }
  async function assignLabelAtRevision(
    actor: Actor,
    labelId: string,
    value: { subjectId: string },
    expectedLabelRevision: number,
    key: string,
  ) {
    return (await mutate(
      actor,
      labelId,
      value,
      key,
      'assign',
      undefined,
      expectedLabelRevision,
    )) as import('../command/command.ts').CommandOutcome<ReturnType<typeof minimal> & { unchanged: boolean }>;
  }
  /** Explicit import review retains the addressed membership baseline as native command operands. */
  async function assignReviewedLabel(
    actor: Actor,
    labelId: string,
    value: { subjectId: string },
    expectedLabelRevision: number,
    expectedTarget: { id: string; revision: number; effective: boolean } | null,
    key: string,
    admission: LabelCommandAdmission,
  ) {
    return (await mutate(actor, labelId, value, key, 'assign', admission, expectedLabelRevision,
      undefined, expectedTarget)) as import('../command/command.ts').CommandOutcome<ReturnType<typeof minimal> & { unchanged: boolean }>;
  }
  async function assignLabelForConsolidation(
    actor: Actor,
    targetLabelId: string,
    value: { subjectId: string },
    targetLabelRevision: number,
    source: { labelId: string; assignmentId: string; revision: number; labelRevision: number },
    target: { id: string; revision: number; effective: boolean } | null,
    key: string,
  ) {
    return (await mutate(
      actor,
      targetLabelId,
      value,
      key,
      'assign',
      undefined,
      targetLabelRevision,
      source,
      target,
    )) as import('../command/command.ts').CommandOutcome<ReturnType<typeof minimal> & { unchanged: boolean }>;
  }
  async function unassignLabel(actor: Actor, labelId: string, value: Expected, key: string) {
    return (await mutate(actor, labelId, value, key, 'unassign')) as import('../command/command.ts').CommandOutcome<{
      deleted: true;
      revision: number;
    }>;
  }
  async function unassignLabelAtRevision(
    actor: Actor,
    labelId: string,
    value: Expected,
    expectedLabelRevision: number,
    key: string,
    expectedTarget?: { labelId: string; assignmentId: string; revision: number; labelRevision: number },
  ) {
    return (await mutate(
      actor,
      labelId,
      value,
      key,
      'unassign',
      undefined,
      expectedLabelRevision,
      undefined,
      expectedTarget,
    )) as import('../command/command.ts').CommandOutcome<{
      deleted: true;
      revision: number;
    }>;
  }
  async function restoreAssignment(actor: Actor, labelId: string, value: Expected, key: string) {
    return (await mutate(actor, labelId, value, key, 'restore')) as import('../command/command.ts').CommandOutcome<
      ReturnType<typeof minimal>
    >;
  }
  async function listAssignments(actor: Actor, options: ListOptions) {
    const account = owner(actor, 'library_entry:read'),
      parsed = object(options, ['labelId', 'subjectId', 'limit', 'cursor', 'view']);
    if ((parsed.labelId === undefined) === (parsed.subjectId === undefined)) throw invalid();
    const labelId = parsed.labelId === undefined ? undefined : id(parsed.labelId);
    const subjectId = parsed.subjectId === undefined ? undefined : id(parsed.subjectId);
    const limit = parsed.limit ?? 20;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
    if (parsed.view !== undefined && parsed.view !== 'BASIC' && parsed.view !== 'FULL') throw invalid();
    const full = parsed.view === 'FULL';
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    if (full && labelId) {
      owner(account, 'library_entry:list');
      await admitShelfRead({ ...deps, clock }, account, deadline);
    }
    let time: AuthoritativeTime | undefined;
    try {
      if (subjectId) {
        time = await snapshot(account, deadline, (client) => mintReadTime(client, clock));
        if (!(await withRequestDeadline(deadline, () => resolveSubject(deps, account, subjectId, time))))
          throw new LibraryNotFoundError();
      }
      const result = await snapshot(account, deadline, async (client, route) => {
        const parent = labelId
          ? await readPersonalLabel(client, sameAccountRoute(account.accountId, labelId), account.accountId, labelId)
          : null;
        if (labelId && !parent) throw new LibraryNotFoundError();
        const partition = await readPartition(client, partitionOf(route));
        if (!partition) throw new Error('Missing owner partition');
        const binding = {
          route: 'library_label.assignment_list',
          viewer: account.accountId,
          query: { owner: account.accountId, labelId: labelId ?? null, subjectId: subjectId ?? null, limit },
        };
        let after = '00000000-0000-0000-0000-000000000000';
        const now = clock();
        if (parsed.cursor !== undefined) {
          if (typeof parsed.cursor !== 'string') throw new ProblemError('invalid_cursor');
          const cursor = await decodeListCursor(tokens, binding, parsed.cursor, now);
          if (
            !cursor.ok ||
            cursor.after.length !== 2 ||
            typeof cursor.after[0] !== 'string' ||
            routeOf(cursor.after[0]) === null ||
            typeof cursor.after[1] !== 'string' ||
            !/^(0|[1-9][0-9]{0,18})$/.test(cursor.after[1])
          )
            throw new ProblemError('invalid_cursor');
          if (cursor.epoch !== partition.epoch || cursor.after[1] !== partition.position.toString())
            throw new ProblemError('stale_cursor');
          after = cursor.after[0];
        }
        const db = { query: client.query.bind(client) };
        const rows = labelId
          ? await labelPage.run(db, {
              route,
              account_id: account.accountId,
              label_id: labelId,
              after_subject_id: after,
              limit,
            })
          : (await subjectPage.run(db, { route, account_id: account.accountId, subject_id: subjectId! }))
              .sort((a, b) => (a.labelId < b.labelId ? -1 : a.labelId > b.labelId ? 1 : 0))
              .filter((row) => row.labelId > after)
              .slice(0, limit);
        const assignments: (
          | Assignment
          | (Assignment & { label: { name: string } })
          | (Assignment & { libraryEntry: LibraryEntryTile | null })
        )[] = [];
        for (const row of rows) {
          if ('deletedAt' in row && row.deletedAt !== null) continue;
          if (row.id === null || row.slotNo === null) throw new ProblemError('index_not_ready');
          const current = labelId ? parent : await readPersonalLabel(client, route, account.accountId, row.labelId);
          if (!current) continue;
          const assignment = { id: row.id, labelId: row.labelId, subjectId: row.subjectId, revision: row.revision };
          assignments.push(full && !labelId ? { ...assignment, label: { name: current.name } } : assignment);
        }
        const tiles =
          full && labelId
            ? await readLibraryEntryTiles(client, {
                route,
                accountId: account.accountId,
                subjectIds: assignments.map((row) => row.subjectId),
              })
            : null;
        const last = rows.at(-1);
        return {
          ...(full && parent ? { label: { id: parent.id, name: parent.name, revision: parent.revision } } : {}),
          assignments: tiles
            ? assignments.map((row) => ({ ...row, libraryEntry: tiles.get(row.subjectId) ?? null }))
            : assignments,
          next:
            rows.length === limit && last
              ? await encodeListCursor(
                  tokens,
                  binding,
                  {
                    epoch: partition.epoch,
                    after: [labelId ? last.subjectId : last.labelId, partition.position.toString()],
                  },
                  now,
                )
              : null,
        };
      });
      if (subjectId && !(await withRequestDeadline(deadline, () => resolveSubject(deps, account, subjectId, time))))
        throw new LibraryNotFoundError();
      return result;
    } finally {
      if (time) releaseOperationalTime(time);
    }
  }
  return {
    assignLabel,
    assignLabelAtRevision,
    assignReviewedLabel,
    assignLabelForConsolidation,
    unassignLabel,
    unassignLabelAtRevision,
    restoreAssignment,
    listAssignments,
  };
}
