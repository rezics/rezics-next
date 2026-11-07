import type { Pool, PoolClient } from 'pg';
import type { LabelCommandAdmission } from './label-command-admission.ts';
import { readAccountCommandState } from './access-port.ts';
import { GrantDeniedError } from '../access/contract/errors.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { authoritativeTimeValue, noEffect } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { receiptKeysFor } from '../command/receipt-key.ts';
import {
  createLibraryCommandRunner,
  type LibraryCommandBody,
  type LibraryCommandExecutionPlan,
} from './command-support.ts';
import { LibraryNotFoundError, sameAccountRoute } from './collection-command-work.ts';
import { LibraryConflictError } from './entry-errors.ts';
import page from './label-catalogue-page.sql';
import prefixPage from './label-catalogue-prefix.sql';
import * as store from './label-store.ts';
import { assertAniListLabel, prepareAniListLabel, type AniListLabelGuard } from './list-import-anilist-label-guard.ts';
import { assertMalLabelFence, prepareMalLabelFence, type MalLabelFence } from './list-import-mal-label-fence.ts';
import { deadlineFor } from '../request/deadline.ts';
import {
  composeLabelOperation,
  executeLabelOperation,
  executeLabelSql,
  LABEL_NAME_SCALARS,
  LABEL_PAGE_DEFAULT,
  LABEL_PAGE_MAX,
  labelCataloguePlan,
  labelCommandAttemptComponent,
  labelCreatePlan,
  labelLifecyclePlan,
  labelOperationComponent,
  labelOwnerSqlComponent,
  labelRenamePlan,
  labelSnapshotComponent,
} from './label-operation-bounds.ts';

type Label = { id: string; name: string; revision: number };
type LabelValue = { label: { id: string; revision: number } };
type ListOptions = { limit?: number; cursor?: string; q?: string };
type Client = Pick<PoolClient, 'query'>;

function account(actor: Actor, action: string): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(action))
    throw new GrantDeniedError();
  return actor;
}

function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Expected an object');
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new TypeError('Unknown label input field');
  return input as Record<string, unknown>;
}

function revision(input: unknown): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1 || input > 2_147_483_647)
    throw new TypeError('Expected a positive native integer revision');
  return input;
}

function nameInput(input: unknown, rename = false) {
  const value = object(input, rename ? ['name', 'revision'] : ['name']);
  const normalized = store.normalizePersonalLabelName(value.name);
  return { name: value.name as string, normalized, ...(rename ? { revision: revision(value.revision) } : {}) };
}

const minimal = (label: { id: string; revision: number }): LabelValue => ({
  label: { id: label.id, revision: label.revision },
});
const visible = (label: Label): Label => ({ id: label.id, name: label.name, revision: label.revision });
const events = (owner: AccountActor, labelId: string) => [
  { type: 'com.rezics.library.label.changed.v1', subject: owner.accountId, data: { labelId } },
];

/** Native private catalogue; receipts contain identity and revision only. */
export function createPersonalLabelCommands(config: {
  pool: Pool;
  tokens: KeyRing;
  clock?: KernelClock;
  access?: Access;
}) {
  const { pool, tokens } = config;
  const clock = config.clock ?? systemClock;
  const runner = createLibraryCommandRunner({ pool, clock });

  async function run<T>(
    actor: Actor,
    kind: string,
    input: unknown,
    requestKey: string,
    body: LibraryCommandBody<T>,
    guard?: AniListLabelGuard,
    attemptPlan?: LibraryCommandExecutionPlan,
  ) {
    try {
      const request = {
        action: 'library_entry:update',
        kind,
        input: guard ? { input, importReview: guard } : input,
        requestKey,
        ...(attemptPlan ? { attemptPlan } : {}),
      };
      if (guard) {
        const owner = account(actor, 'library_entry:update');
        return await createLibraryCommandRunner(config).ownAccountPrepared(
          actor,
          {
            ...request,
            prepare: (attempt) => prepareAniListLabel(config, owner, guard, attempt.time),
          },
          async (tx, command, prepared) => {
            if (prepared.error !== undefined) throw prepared.error;
            await assertAniListLabel(tx, owner, guard);
            return body(tx, command);
          },
        );
      }
      return await runner.ownAccount(actor, request, body);
    } catch (error) {
      // Translate only this domain index, after the native transaction has rolled back.
      if (
        error instanceof Error &&
        (error as { code?: string }).code === '23505' &&
        (error as { constraint?: string }).constraint === 'personal_label_live_name'
      ) {
        if (kind === 'library_label.restore') throw new ProblemError('library_label_restore_occupied');
        throw new LibraryConflictError();
      }
      throw error;
    }
  }

  async function snapshot<T>(
    actor: Actor,
    action: string,
    body: (client: Client, owner: AccountActor, route: number) => Promise<T>,
  ) {
    const owner = account(actor, action);
    const route = routeOf(owner.accountId)!;
    return withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const current = await readAccountCommandState(client, route, owner.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(owner.authnEpoch) ||
          owner.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
        )
          throw new GrantDeniedError();
        const result = await body(client, owner, route);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function createLabel(
    actor: Actor,
    input: unknown,
    key: string,
    importGuard?: AniListLabelGuard | MalLabelFence | LabelCommandAdmission,
  ) {
    const malLabelFence =
      importGuard && 'sourceDigest' in importGuard && 'subject' in importGuard ? importGuard : undefined;
    const guard = importGuard && 'subjectId' in importGuard ? importGuard : undefined;
    const admission = importGuard && 'prepare' in importGuard ? importGuard : undefined;
    const owner = account(actor, 'library_entry:update');
    const parsed = nameInput(input);
    const route = routeOf(owner.accountId)!;
    const commandInput = admission
      ? { name: parsed.name, review: admission.input }
      : guard
        ? { name: parsed.name, importReview: guard }
        : malLabelFence
          ? { name: parsed.name, malLabelFence }
          : { name: parsed.name };
    const attempt = composeLabelOperation(
      labelCreatePlan({
        route,
        accountId: owner.accountId,
        labelId: 'f'.repeat(36),
        name: parsed.normalized,
        transactionId: 'f'.repeat(36),
        time: '\u0000'.repeat(64),
      }),
      [
        labelCommandAttemptComponent(
          'library_label.create',
          { input: commandInput, requestKey: key },
          { label: { id: 'f'.repeat(36), revision: 2_147_483_647 } },
          receiptKeysFor(pool).keys.size + 1,
        ),
        ...(guard
          ? [
              labelOwnerSqlComponent(
                'import.anilist.label-fence',
                guard,
                { payload: { source: {}, labelReview: {} } },
                2,
                2,
              ),
            ]
          : []),
        ...(malLabelFence
          ? [
              labelOwnerSqlComponent(
                'import.mal.label-fence',
                malLabelFence,
                { row: {}, sourceDigest: 'f'.repeat(64), selectionDigest: 'f'.repeat(64) },
                malLabelFence.label ? 2 : 1,
                malLabelFence.label ? 2 : 1,
              ),
            ]
          : []),
        ...(admission?.work ? [labelOperationComponent('import.preparation-source-fence', admission.work)] : []),
      ],
      true,
    );
    const attemptPlan = { operation: `library.${attempt.kind}.${attempt.branch}`, total: attempt.total };
    const body: LibraryCommandBody<LabelValue> = async (tx, command) => {
      if (malLabelFence) await assertMalLabelFence(tx, owner, malLabelFence);
      const route = routeOf(owner.accountId)!;
      const label = await store.insertPersonalLabel(
        tx,
        route,
        { accountId: owner.accountId, id: newId(route), name: parsed.normalized },
        { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
      );
      return { value: minimal(label), events: events(owner, label.id) };
    };
    if (admission) {
      try {
        return await runner.ownAccountPrepared(
          actor,
          {
            action: 'library_entry:update',
            kind: 'library_label.create',
            requestKey: key,
            input: { name: parsed.name, review: admission.input },
            attemptPlan,
            prepare: (attemptTime) => admission.prepare(attemptTime.time),
          },
          async (tx, command, validate) => {
            await validate(tx);
            return body(tx, command);
          },
        );
      } catch (error) {
        if (
          (error as { code?: string; constraint?: string })?.code === '23505' &&
          (error as { constraint?: string }).constraint === 'personal_label_live_name'
        )
          throw new LibraryConflictError();
        throw error;
      }
    }
    if (!malLabelFence) return run(actor, 'library_label.create', { name: parsed.name }, key, body, guard, attemptPlan);
    if (!config.access) throw new TypeError('MAL label adoption requires Subject access');
    const access = config.access,
      deadline = deadlineFor(5000);
    return createLibraryCommandRunner(config).ownAccountPrepared(
      actor,
      {
        action: 'library_entry:update',
        kind: 'library_label.create',
        requestKey: key,
        input: { name: parsed.name, malLabelFence },
        attemptPlan,
        async prepare(attempt) {
          try {
            await prepareMalLabelFence({ pool, access }, owner, malLabelFence, attempt.time, deadline);
            return { error: undefined };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        if (prepared.error !== undefined) throw prepared.error;
        return body(tx, command);
      },
    );
  }

  async function renameLabel(actor: Actor, labelId: string, input: unknown, key: string) {
    const owner = account(actor, 'library_entry:update');
    const parsed = nameInput(input, true);
    const expected = parsed.revision!;
    const attempt = composeLabelOperation(
      labelRenamePlan({
        route: routeOf(owner.accountId)!,
        accountId: owner.accountId,
        labelId,
        name: parsed.normalized,
        revision: expected,
        transactionId: 'f'.repeat(36),
        time: '\u0000'.repeat(64),
        includeRead: true,
      }),
      [
        labelCommandAttemptComponent(
          'library_label.rename',
          { labelId, name: parsed.name, revision: expected, requestKey: key },
          { label: { id: 'f'.repeat(36), revision: 2_147_483_647 } },
          receiptKeysFor(pool).keys.size + 1,
        ),
      ],
      true,
    );
    return run(
      actor,
      'library_label.rename',
      { labelId, name: parsed.name, revision: expected },
      key,
      async (tx, command) => {
        const route = sameAccountRoute(owner.accountId, labelId);
        const operation = labelRenamePlan({
          route,
          accountId: owner.accountId,
          labelId,
          name: parsed.normalized,
          revision: expected,
          transactionId: command.transactionId,
          time: authoritativeTimeValue(command.time),
          includeRead: true,
        });
        return executeLabelOperation(operation, async () => {
          const current = await store.readPersonalLabel(tx, route, owner.accountId, labelId);
          if (!current) throw new LibraryNotFoundError();
          if (current.revision !== expected) throw new LibraryConflictError();
          if (current.name === parsed.normalized) return noEffect(minimal(current));
          const changed = await store.renamePersonalLabel(
            tx,
            route,
            owner.accountId,
            labelId,
            expected,
            parsed.normalized,
            { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
          );
          if (!changed) throw new LibraryConflictError();
          return { value: minimal(changed), events: events(owner, labelId) };
        });
      },
      undefined,
      { operation: `library.${attempt.kind}.${attempt.branch}`, total: attempt.total },
    );
  }

  async function lifecycle<R>(
    actor: Actor,
    labelId: string,
    expectedRevision: number,
    key: string,
    restore: boolean,
    value: (label: store.LabelRecord) => R,
  ) {
    const owner = account(actor, 'library_entry:update');
    const expected = revision(expectedRevision);
    const attempt = composeLabelOperation(
      labelLifecyclePlan({
        route: routeOf(owner.accountId)!,
        accountId: owner.accountId,
        labelId,
        revision: expected,
        transactionId: 'f'.repeat(36),
        time: '\u0000'.repeat(64),
        restore,
        includeRead: true,
      }),
      [
        labelCommandAttemptComponent(
          restore ? 'library_label.restore' : 'library_label.delete',
          { labelId, revision: expected, requestKey: key },
          restore
            ? { label: { id: 'f'.repeat(36), revision: 2_147_483_647 } }
            : { deleted: true, revision: 2_147_483_647 },
          receiptKeysFor(pool).keys.size + 1,
        ),
      ],
      true,
    );
    return run(
      actor,
      restore ? 'library_label.restore' : 'library_label.delete',
      { labelId, revision: expected },
      key,
      async (tx, command) => {
        const route = sameAccountRoute(owner.accountId, labelId);
        const time = authoritativeTimeValue(command.time);
        const operation = labelLifecyclePlan({
          route,
          accountId: owner.accountId,
          labelId,
          revision: expected,
          transactionId: command.transactionId,
          time,
          restore,
          includeRead: true,
        });
        return executeLabelOperation(operation, async () => {
          const current = await store.readPersonalLabel(tx, route, owner.accountId, labelId, true);
          if (!current) throw new LibraryNotFoundError();
          if (restore) {
            if (
              current.revision !== expected ||
              current.deletedAt === null ||
              Date.parse(current.deletedAt) > Date.parse(time)
            )
              throw new ProblemError('library_label_restore_stale');
            if (current.purgeAfter === null || Date.parse(time) >= Date.parse(current.purgeAfter))
              throw new ProblemError('library_label_restore_expired');
          } else {
            if (current.deletedAt !== null) throw new LibraryNotFoundError();
            if (current.revision !== expected) throw new LibraryConflictError();
          }
          const change = restore ? store.restorePersonalLabel : store.deletePersonalLabel;
          const changed = await change(tx, route, owner.accountId, labelId, expected, {
            transactionId: command.transactionId,
            time,
          });
          if (!changed) {
            if (restore) throw new ProblemError('library_label_restore_stale');
            throw new LibraryConflictError();
          }
          return { value: value(changed), events: events(owner, labelId) };
        });
      },
      undefined,
      { operation: `library.${attempt.kind}.${attempt.branch}`, total: attempt.total },
    );
  }

  function deleteLabel(actor: Actor, labelId: string, expected: number, key: string) {
    return lifecycle(actor, labelId, expected, key, false, (label) => ({
      deleted: true as const,
      revision: label.revision,
    }));
  }

  function restoreLabel(actor: Actor, labelId: string, expected: number, key: string) {
    return lifecycle(actor, labelId, expected, key, true, minimal);
  }

  function readLabel(actor: Actor, labelId: string): Promise<Label> {
    return snapshot(actor, 'library_entry:read', async (client, owner, route) => {
      sameAccountRoute(owner.accountId, labelId);
      const label = await store.readPersonalLabel(client, route, owner.accountId, labelId);
      if (!label) throw new LibraryNotFoundError();
      return visible(label);
    });
  }

  async function listLabels(
    actor: Actor,
    options: ListOptions = {},
  ): Promise<{ labels: Label[]; next: string | null }> {
    const parsed = object(options, ['limit', 'cursor', 'q']);
    let q = '';
    if (parsed.q !== undefined) {
      try {
        q = store.normalizePersonalLabelPrefix(parsed.q);
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) throw new ProblemError('invalid_request');
        throw error;
      }
    }
    const limit = parsed.limit === undefined ? LABEL_PAGE_DEFAULT : parsed.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LABEL_PAGE_MAX)
      throw new RangeError(`Page limit must be an integer from 1 to ${LABEL_PAGE_MAX}`);
    const owner = account(actor, 'library_entry:list');
    const route = routeOf(owner.accountId)!;
    const hasCursor = parsed.cursor !== undefined;
    const composed = composeLabelOperation(
      labelCataloguePlan({
        route,
        accountId: owner.accountId,
        ...(q
          ? {
              prefix: q,
              upper: store.personalLabelPrefixEnd(q),
              ...(hasCursor ? { afterName: '\u{10ffff}'.repeat(LABEL_NAME_SCALARS) } : {}),
            }
          : {}),
        afterLabelId: hasCursor ? 'f'.repeat(36) : '00000000-0000-0000-0000-000000000000',
        limit,
      }),
      [
        labelSnapshotComponent(
          'label.catalogue.partition-cursor-serialization-snapshot',
          { owner: owner.accountId, cursor: parsed.cursor ?? null, prefix: q, limit },
          limit * (LABEL_NAME_SCALARS * 4 + 128) + 4096,
        ),
      ],
      true,
    );
    return executeLabelOperation(composed, () =>
      snapshot(actor, 'library_entry:list', async (client, owner, route) => {
        const partition = await readPartition(client, partitionOf(route));
        if (!partition) throw new Error('Missing owner partition');
        const binding = {
          route: 'library_label.list',
          viewer: owner.accountId,
          query: { owner: owner.accountId, limit, ...(q ? { q, version: 1 } : {}) },
        };
        const now = clock();
        let after = '00000000-0000-0000-0000-000000000000';
        if (parsed.cursor !== undefined) {
          if (typeof parsed.cursor !== 'string') throw new ProblemError('invalid_cursor');
          const cursor = await decodeListCursor(tokens, binding, parsed.cursor, now);
          if (
            !cursor.ok ||
            cursor.after.length !== 2 ||
            typeof cursor.after[0] !== 'string' ||
            routeOf(cursor.after[0]) !== route ||
            typeof cursor.after[1] !== 'string' ||
            !/^(0|[1-9][0-9]{0,18})$/.test(cursor.after[1])
          )
            throw new ProblemError('invalid_cursor');
          if (cursor.epoch !== partition.epoch || cursor.after[1] !== partition.position.toString())
            throw new ProblemError('stale_cursor');
          after = cursor.after[0];
        }
        let afterName = q;
        if (q && after !== '00000000-0000-0000-0000-000000000000') {
          const last = await store.readPersonalLabel(client, route, owner.accountId, after);
          if (!last || !last.name.startsWith(q)) throw new ProblemError('stale_cursor');
          afterName = last.name;
        }
        const operation = labelCataloguePlan({
          route,
          accountId: owner.accountId,
          ...(q ? { prefix: q, upper: store.personalLabelPrefixEnd(q), afterName } : {}),
          afterLabelId: after,
          limit,
        });
        const leaf = operation.leaves[0]!;
        const db = { query: client.query.bind(client) };
        const rows = await executeLabelOperation(operation, () =>
          executeLabelSql(leaf, (operands) =>
            q
              ? prefixPage.run(db, operands as Parameters<typeof prefixPage.run>[1])
              : page.run(db, operands as Parameters<typeof page.run>[1]),
          ),
        );
        const last = rows.at(-1);
        return {
          labels: rows.filter((row) => row.deletedAt === null).map(visible),
          // A full raw window may end at EOF. One final empty page is intentionally valid.
          next:
            rows.length === limit && last
              ? await encodeListCursor(
                  tokens,
                  binding,
                  { epoch: partition.epoch, after: [last.id, partition.position.toString()] },
                  now,
                )
              : null,
        };
      }),
    );
  }

  return { createLabel, renameLabel, deleteLabel, restoreLabel, readLabel, listLabels };
}
