import { accessNativeWork, accessCheckout, accessTransaction, type AccessWorkAccounting } from '../work.ts';
import { CommandUnavailableError, requireAccessDeadline } from '../unavailable.ts';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  runCommand,
  authoritativeTimeValue,
  type CommandAuthorization,
  type AuthoritativeTime,
  type CommandOutcome,
} from '../../command/command.ts';
import { readPartition } from '../../partition/partition.ts';
import { withConnection, discardConnection } from '../../database/pool.ts';
import { deadlineClient, within } from '../authenticate.ts';
import type { AccountActor, AccessContext, Resource } from '../../request/access.ts';
import { partitionOf } from '../../route/route.ts';
import { isExposureGroup } from '@rezics/access';
import openingClose from './opening-close.sql';
import openingOpen from './opening-open.sql';
import openingRead from './opening-read.sql';
import openingPartitionRead from './opening-partition-read.sql';
import openingMovedTargetRead from './opening-moved-target-read.sql';

export const GLOBAL_CONTEXT: Resource = Object.freeze({
  route: 0,
  id: '00000000-0000-8000-8000-000000000000',
});

export { isExposureGroup };

export type ExposureState = { open: boolean; at: string };

/** The exposure read is a single temporal primary-key probe at the kernel's request T. */
export async function readExposure(
  pool: Pool,
  group: string,
  at: Date | AuthoritativeTime,
  deadline: number,
  work?: AccessWorkAccounting,
  time?: AuthoritativeTime,
): Promise<ExposureState> {
  if (!isExposureGroup(group) || (at instanceof Date && !Number.isFinite(at.getTime())))
    throw new TypeError('Invalid exposure lookup');
  const nativeTime = time ?? (at instanceof Date ? undefined : at);
  const instant = nativeTime ? authoritativeTimeValue(nativeTime) : (at as Date).toISOString();
  requireAccessDeadline(deadline);
  return within(deadline, () =>
    accessCheckout(work, () =>
      withConnection(pool, async (client) => {
        const bounded = deadlineClient(client, deadline);
        try {
          await accessTransaction(
            work,
            bounded,
            nativeTime || work ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN READ ONLY',
          );
          if (nativeTime || work) {
            const input = { partition_no: partitionOf(GLOBAL_CONTEXT.route) };
            if (work) {
              // Only closed native state and a length are projected initially. The
              // handoff locator is arbitrary text; reserve its observed byte bound
              // before fetching it in this same repeatable-read snapshot.
              const partition = await accessNativeWork(work, 'opening-partition', input, {}, () =>
                openingPartitionRead.run(bounded, input),
              );
              if (!partition) throw new CommandUnavailableError('overloaded', input.partition_no);
              if (partition.writeState === 'moved') {
                const movedToBytes = partition.movedToBytes;
                if (movedToBytes === null || !Number.isSafeInteger(movedToBytes) || movedToBytes < 0)
                  throw new Error('Invalid exposure partition handoff length');
                const targetInput = { ...input, bytes: movedToBytes };
                const target = await accessNativeWork(work, 'opening-moved-target', targetInput, { movedToBytes }, () =>
                  openingMovedTargetRead.run(bounded, targetInput),
                );
                if (!target || typeof target.movedTo !== 'string')
                  throw new Error('Exposure partition handoff read failed');
                throw new CommandUnavailableError('moved', input.partition_no, target.movedTo);
              }
            } else {
              const partition = await readPartition(bounded, input.partition_no);
              if (!partition) throw new CommandUnavailableError('overloaded', input.partition_no);
              if (partition.writeState === 'moved')
                throw new CommandUnavailableError('moved', input.partition_no, partition.movedTo);
            }
          }
          const input = { group, at: instant };
          const row = await accessNativeWork(work, 'opening', input, {}, () => openingRead.run(bounded, input));
          if (!row || typeof row.open !== 'boolean' || typeof row.at !== 'string')
            throw new Error('Exposure catalogue read failed');
          await accessTransaction(work, bounded, 'COMMIT');
          const readAt = new Date(row.at);
          if (!Number.isFinite(readAt.getTime()) || (nativeTime && row.at !== instant))
            throw new Error('Exposure catalogue time was invalid');
          if (nativeTime) authoritativeTimeValue(nativeTime);
          return { open: row.open, at: nativeTime || work ? row.at : readAt.toISOString() };
        } catch (error) {
          if (work) {
            work.fail(error);
            discardConnection(client, error instanceof Error ? error : new Error('Exposure read failed'));
            throw error;
          }
          try {
            await client.query('ROLLBACK');
          } catch {
            // Preserve the original read failure.
          }
          throw error;
        }
      }),
    ),
  ).catch((error: unknown) => {
    work?.fail(error);
    throw error;
  });
}

export type ExposureMutationContext = AccessContext & { actor: AccountActor };
export type ExposureMutation = {
  group: string;
  key: string;
  authorization: CommandAuthorization;
};
export type ExposureValue = { group: string; open: boolean; changed: boolean };

/** Exposure openings share the Global Context partition and its native receipt fence. */
export function createExposureCommands(config: { pool: Pool; clock: () => Date }) {
  async function change(
    context: ExposureMutationContext,
    operation: 'open' | 'close',
    input: ExposureMutation,
  ): Promise<CommandOutcome<ExposureValue>> {
    const { group, key, authorization } = input;
    const { actor } = context;
    if (
      context.pool !== config.pool ||
      !isExposureGroup(group) ||
      typeof key !== 'string' ||
      key.length < 1 ||
      key.length > 255 ||
      authorization.action !== `exposure:${operation}` ||
      authorization.resource.route !== GLOBAL_CONTEXT.route ||
      authorization.resource.id !== GLOBAL_CONTEXT.id
    )
      throw new Error('Exposure command denied');

    const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
    const digest = createHash('sha256')
      .update(canonicalize([operation, group, basis])!, 'utf8')
      .digest();
    return runCommand(
      config.pool,
      {
        partition: partitionOf(GLOBAL_CONTEXT.route),
        basis,
        deadline: context.deadline,
        clock: config.clock,
        authorization,
        receipt: {
          actorAccountId: actor.accountId,
          kind: `access.exposure.${operation}`,
          key: `${GLOBAL_CONTEXT.route}:${key}`,
          digest,
        },
      },
      async (tx, { time, transactionId }) => {
        const at = authoritativeTimeValue(time);
        const row =
          operation === 'open'
            ? await openingOpen.run(tx, { group, at, transaction_id: transactionId })
            : await openingClose.run(tx, { group, at, transaction_id: transactionId });
        const changed = row?.changed === true;
        const value = { group, open: operation === 'open', changed };
        return {
          value,
          events: [
            {
              type: `com.rezics.access.exposure.${operation === 'open' ? 'opened' : 'closed'}.v1`,
              subject: GLOBAL_CONTEXT.id,
              data: value,
            },
          ],
        };
      },
    );
  }

  return {
    open: (context: ExposureMutationContext, input: ExposureMutation) => change(context, 'open', input),
    close: (context: ExposureMutationContext, input: ExposureMutation) => change(context, 'close', input),
  };
}
