import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { authoritativeTimeValue, noEffect } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor, Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  createLibraryCommandRunner,
  LibraryNotFoundError,
  sameAccountRoute,
  type LibraryCommandBody,
} from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import page from './label-catalogue-page.sql';
import * as store from './label-store.ts';

type Label = { id: string; name: string; revision: number };
type LabelValue = { label: { id: string; revision: number } };
type ListOptions = { limit?: number; cursor?: string };
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
export function createPersonalLabelCommands(config: { pool: Pool; tokens: KeyRing; clock?: KernelClock }) {
  const { pool, tokens } = config;
  const clock = config.clock ?? systemClock;
  const runner = createLibraryCommandRunner({ pool, clock });

  async function run<T>(actor: Actor, kind: string, input: unknown, requestKey: string, body: LibraryCommandBody<T>) {
    try {
      return await runner.ownAccount(actor, { action: 'library_entry:update', kind, input, requestKey }, body);
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

  async function createLabel(actor: Actor, input: unknown, key: string) {
    const owner = account(actor, 'library_entry:update');
    const parsed = nameInput(input);
    return run(actor, 'library_label.create', { name: parsed.name }, key, async (tx, command) => {
      const route = routeOf(owner.accountId)!;
      const label = await store.insertPersonalLabel(
        tx,
        route,
        { accountId: owner.accountId, id: newId(route), name: parsed.normalized },
        { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
      );
      return { value: minimal(label), events: events(owner, label.id) };
    });
  }

  async function renameLabel(actor: Actor, labelId: string, input: unknown, key: string) {
    const owner = account(actor, 'library_entry:update');
    const parsed = nameInput(input, true);
    const expected = parsed.revision!;
    return run(
      actor,
      'library_label.rename',
      { labelId, name: parsed.name, revision: expected },
      key,
      async (tx, command) => {
        const route = sameAccountRoute(owner.accountId, labelId);
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
      },
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
    return run(
      actor,
      restore ? 'library_label.restore' : 'library_label.delete',
      { labelId, revision: expected },
      key,
      async (tx, command) => {
        const route = sameAccountRoute(owner.accountId, labelId);
        const current = await store.readPersonalLabel(tx, route, owner.accountId, labelId, true);
        if (!current) throw new LibraryNotFoundError();
        const time = authoritativeTimeValue(command.time);
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
      },
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
    const parsed = object(options, ['limit', 'cursor']);
    const limit = parsed.limit === undefined ? 20 : parsed.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Page limit must be an integer from 1 to 100');
    return snapshot(actor, 'library_entry:list', async (client, owner, route) => {
      const partition = await readPartition(client, partitionOf(route));
      if (!partition) throw new Error('Missing owner partition');
      const binding = {
        route: 'library_label.list',
        viewer: owner.accountId,
        query: { owner: owner.accountId, limit },
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
      const rows = await page.run(
        { query: client.query.bind(client) },
        { route, account_id: owner.accountId, after_label_id: after, limit },
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
    });
  }

  return { createLabel, renameLabel, deleteLabel, restoreLabel, readLabel, listLabels };
}
