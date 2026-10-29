import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { commandAccessContext, requireCommandAdmission } from '../access/command-admission.ts';
import { admitGroup } from '../access/gates/admission.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { throwAccessUnavailable } from '../access/unavailable.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  noEffect,
  releaseOperationalTime,
  type AuthoritativeTime,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createCollectionReads } from './collection-reads.ts';
import { createLibraryCommandRunner, WORK_STEP_DEADLINE_MS } from './command-support.ts';
import { readPins, writePins } from './pin-store.ts';

function owner(actor: Actor, action: string) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (!actor.scopes.includes(action))
    throw new ProblemError('forbidden', {
      headers: { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${action}"` },
    });
  return actor;
}
const invalid = () => new ProblemError('invalid_request');

/** IDs-only private preference, independent of target ownership and Collection mutation. */
export function createPins(deps: { pool: Pool; access: Access; tokens: KeyRing; clock: KernelClock }) {
  const { pool, access, tokens, clock } = deps;
  const runner = createLibraryCommandRunner({ pool, clock });
  const collections = createCollectionReads({ pool, access, tokens });
  async function targetGate(actor: Actor, deadline: number, time: AuthoritativeTime) {
    await admitGroup({
      pool,
      access: () => access,
      actor,
      group: 'collections',
      clientAction: 'collection:read',
      deadline,
      clock: () => new Date(authoritativeTimeValue(time)),
    });
  }

  async function list(actor: Actor, options: { limit?: number; cursor?: string }) {
    const account = owner(actor, 'library_pin:list');
    const route = routeOf(account.accountId)!;
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid();
    const binding = { operation: 'library_pin.list', parameters: { accountId: account.accountId, limit } };
    let time: AuthoritativeTime | undefined;
    try {
      // Commit and release owner metadata before any target/Access home visit.
      const page = await withConnection(pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const current = await readAccount(client, route, account.accountId);
          if (
            !current ||
            current.kind !== 'actor' ||
            current.state !== 'active' ||
            current.fenced ||
            !Number.isSafeInteger(account.authnEpoch) ||
            account.authnEpoch < 1 ||
            current.minimumAuthnEpoch > BigInt(account.authnEpoch)
          )
            throw new AuthenticationError(401, 'Bearer error="invalid_token"');
          time = await mintReadTime(client, clock);
          const stored = await readPins(client, route, account.accountId);
          let ordinal = 0;
          if (options.cursor !== undefined) {
            const cursor = decodeCursor(
              tokens,
              binding,
              options.cursor,
              new Date(authoritativeTimeValue(time)).getTime(),
            );
            if (
              !cursor.ok ||
              cursor.after.length !== 2 ||
              !Number.isSafeInteger(cursor.after[0]) ||
              !Number.isSafeInteger(cursor.after[1]) ||
              (cursor.after[1] as number) < 1 ||
              (cursor.after[1] as number) > 100
            )
              throw new ProblemError('invalid_cursor');
            if (cursor.after[0] !== stored.revision) throw new ProblemError('stale_cursor');
            ordinal = cursor.after[1] as number;
          }
          const ids = stored.ids.slice(ordinal, ordinal + limit);
          const end = ordinal + ids.length;
          const next =
            end < stored.ids.length
              ? encodeCursor(
                  tokens,
                  binding,
                  { epoch: 1, after: [stored.revision, end] },
                  new Date(authoritativeTimeValue(time)).getTime(),
                )
              : null;
          await client.query('COMMIT');
          return { ids, revision: stored.revision, next };
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        }
      });
      if (page.ids.length) await targetGate(account, deadline, time!);
      const pins = [];
      for (const collectionId of page.ids) {
        let target;
        try {
          target = await collections.readCollection(account, collectionId, deadline, { time: time! });
        } catch (error) {
          if (!(error instanceof ProblemError && error.code === 'not_found')) throw error;
          target = null;
        }
        pins.push({ collectionId, target });
      }
      return { pins, revision: page.revision, next: page.next };
    } finally {
      if (time) releaseOperationalTime(time);
    }
  }

  async function mutate(
    actor: Actor,
    collectionId: string,
    input: { revision: number; after?: string | null },
    key: string,
    remove = false,
  ) {
    const account = owner(actor, 'library_pin:update');
    if (routeOf(collectionId) === null) throw new ProblemError('not_found');
    if (
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0 ||
      (input.after !== undefined &&
        input.after !== null &&
        (routeOf(input.after) === null || input.after === collectionId))
    )
      throw invalid();
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    try {
      return await runner.ownAccountPrepared(
        account,
        {
          action: 'library_pin:update',
          kind: remove ? 'library.pin.delete' : 'library.pin.put',
          requestKey: key,
          input: { collectionId, ...input },
          async prepare(attempt) {
            try {
              await requireCommandAdmission(access, account, commandAccessContext({ pool, deadline }, attempt));
            } catch (error) {
              throwAccessUnavailable(error, deadline);
              throw new AuthenticationError(401, 'Bearer error="invalid_token"');
            }
            // Business failure belongs to a fresh NEW pin, after exact receipt replay.
            try {
              if (!remove) {
                const stored = await withConnection(pool, (connection) =>
                  readPins(deadlineClient(connection, deadline), routeOf(account.accountId)!, account.accountId),
                );
                // Monotone CAS makes this probe safe: a changed list cannot enter the fresh body.
                if (stored.revision === input.revision && !stored.ids.includes(collectionId)) {
                  await targetGate(account, deadline, attempt.time);
                  await collections.readCollection(account, collectionId, deadline, { time: attempt.time, attempt });
                }
              }
              return { error: undefined };
            } catch (error) {
              return { error };
            }
          },
        },
        async (tx, _context, prepared) => {
          const route = routeOf(account.accountId)!;
          const stored = await readPins(tx, route, account.accountId);
          if (stored.revision !== input.revision) throw new ProblemError('conflict');
          const exists = stored.ids.includes(collectionId);
          if (!remove && !exists && prepared.error) throw prepared.error;
          if (input.after != null && !stored.ids.includes(input.after)) throw invalid();
          const ids = stored.ids.filter((id) => id !== collectionId);
          if (!remove) {
            if (exists && input.after === undefined) ids.splice(stored.ids.indexOf(collectionId), 0, collectionId);
            else
              ids.splice(
                input.after === null ? 0 : input.after === undefined ? ids.length : ids.indexOf(input.after) + 1,
                0,
                collectionId,
              );
          }
          if (ids.length > 100) throw new ProblemError('collection_full');
          if (ids.every((id, i) => stored.ids[i] === id) && ids.length === stored.ids.length)
            return noEffect({ revision: stored.revision });
          if (stored.revision === Number.MAX_SAFE_INTEGER) throw new ProblemError('conflict');
          if (!(await writePins(tx, route, account.accountId, stored.revision, ids)))
            throw new ProblemError('conflict');
          return {
            value: { revision: stored.revision + 1 },
            events: [
              {
                type: 'com.rezics.library.pin.updated.v1',
                subject: account.accountId,
                data: { collectionId },
              },
            ],
          };
        },
      );
    } catch (error) {
      if (error instanceof GrantDeniedError) throw new AuthenticationError(401, 'Bearer error="invalid_token"');
      throw error;
    }
  }
  return { list, mutate };
}
