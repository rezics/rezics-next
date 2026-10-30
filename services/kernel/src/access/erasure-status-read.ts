import type { Pool } from 'pg';
import { mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { deadlineClient, within } from './authenticate.ts';
import { readAccount } from './account-data.ts';
import { ERASURE_PARTICIPANTS, readErasureStatus } from './erasure.ts';
import { GLOBAL_CONTEXT } from './gates/catalogue.ts';
import { classifyUnavailability } from './unavailable.ts';

export type ManagedErasureStatus = Readonly<{
  accountId: string;
  state: 'pending' | 'retention-outstanding' | 'complete';
  at: string;
  completedAt: string | null;
  pendingParticipants: readonly string[];
  retentionOutstanding: boolean;
  lateItems: boolean;
  effectsFrontier: boolean;
}>;

/** Selection is an account key; authority is always the fixed Global Context. */
export async function readManagedErasureStatus(
  deps: { pool: Pool; access: Access; clock?: () => Date },
  actor: Actor,
  input: { accountId: string },
  context: { deadline: number },
): Promise<ManagedErasureStatus | null> {
  if (actor.kind !== 'account') throw new ProblemError('authentication_required');
  const identity = actor;
  const { accountId } = input;
  const route = routeOf(accountId);
  if (route === null) throw new ProblemError('invalid_request');
  const { pool, access } = deps;
  const { deadline } = context;
  try {
    return await within(deadline, async () => {
      const time = await withConnection(pool, (client) => mintReadTime(deadlineClient(client, deadline), deps.clock));
      try {
        async function requireAuthority() {
          // Preparation may consult foreign actor/principal anchors. Hold no checkout here.
          const check = await accessCheck(access, identity, 'account:read_erasure', GLOBAL_CONTEXT, {
            pool,
            deadline,
            time,
          });
          // A bearer snapshot alone cannot prove the actor's current lifecycle/floor.
          const current = await withConnection(pool, (connection) =>
            readAccount(deadlineClient(connection, deadline), routeOf(identity.accountId)!, identity.accountId),
          );
          if (
            !current ||
            current.kind !== 'actor' ||
            current.state !== 'active' ||
            current.fenced ||
            !Number.isSafeInteger(identity.authnEpoch) ||
            identity.authnEpoch < 1 ||
            BigInt(identity.authnEpoch) < current.minimumAuthnEpoch
          )
            throw new ProblemError('forbidden');
          await withConnection(pool, async (connection) => {
            const client = deadlineClient(connection, deadline);
            const home = await readPartition(client, partitionOf(GLOBAL_CONTEXT.route));
            if (!home || home.writeState !== 'active') throw new ProblemError('partition_unavailable');
            if (!(await check(client, time))) throw new ProblemError('forbidden');
          });
        }
        await requireAuthority();
        const native = await withConnection(pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const home = await readPartition(client, partitionOf(route));
            if (!home || home.writeState !== 'active') throw new ProblemError('partition_unavailable');
            const status = await readErasureStatus(client, accountId);
            await client.query('COMMIT');
            return status;
          } catch (error) {
            try {
              await connection.query('ROLLBACK');
            } catch (rollbackError) {
              discardConnection(connection, rollbackError as Error);
            }
            throw error;
          }
        });
        // Reprepare current evidence after releasing the native snapshot, with the same T and deadline.
        await requireAuthority();
        if (native === null) return null;
        if (native.version !== 1) throw new ProblemError('dependency_unavailable');
        const names = ERASURE_PARTICIPANTS[1];
        return Object.freeze({
          accountId,
          state: native.state,
          at: native.at,
          completedAt: native.completedAt,
          pendingParticipants: Object.freeze(names.filter((name) => native.participants[name]!.outcome === 'pending')),
          retentionOutstanding: names.some((name) =>
            native.participants[name]!.retained.some((entry) => entry.resolvedAt === null),
          ),
          lateItems: native.outstanding.lateItems,
          effectsFrontier: native.outstanding.effectsFrontier,
        });
      } finally {
        releaseOperationalTime(time);
      }
    });
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    const reason = classifyUnavailability(error);
    if (reason === 'deadline') throw new ProblemError('deadline_exceeded');
    if (reason === 'moved' || reason === 'fenced') throw new ProblemError('partition_unavailable');
    // Native SQL, unknown participant versions and dependency failures never disclose their details.
    throw new ProblemError('dependency_unavailable');
  }
}
