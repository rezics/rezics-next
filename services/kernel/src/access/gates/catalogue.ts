import { requireAccessDeadline } from '../unavailable.ts';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  runCommand,
  authoritativeTimeValue,
  type CommandAuthorization,
  type CommandOutcome,
} from '../../command/command.ts';
import { withConnection } from '../../database/pool.ts';
import { deadlineClient, within } from '../authenticate.ts';
import type { AccountActor, AccessContext, Resource } from '../../request/access.ts';
import { partitionOf } from '../../route/route.ts';
import openingClose from './opening-close.sql';
import openingOpen from './opening-open.sql';
import openingRead from './opening-read.sql';

export const GLOBAL_CONTEXT: Resource = Object.freeze({
  route: 0,
  id: '00000000-0000-8000-8000-000000000000',
});

const GROUP_PATTERN = /^[a-z][a-z_-]{0,62}$/;
const RESERVED_GROUPS = new Set(['any', 'open', 'close']);

export function isExposureGroup(value: string): boolean {
  return GROUP_PATTERN.exec(value)?.[0] === value && !RESERVED_GROUPS.has(value);
}

export type ExposureState = { open: boolean; at: string };

/** The exposure read is a single temporal primary-key probe at the kernel's request T. */
export async function readExposure(pool: Pool, group: string, at: Date, deadline: number): Promise<ExposureState> {
  if (!isExposureGroup(group) || !(at instanceof Date) || !Number.isFinite(at.getTime()))
    throw new TypeError('Invalid exposure lookup');
  requireAccessDeadline(deadline);
  return within(deadline, () =>
    withConnection(pool, async (client) => {
      const bounded = deadlineClient(client, deadline);
      await bounded.query('BEGIN READ ONLY');
      try {
        const row = await openingRead.run(bounded, { group, at: at.toISOString() });
        if (!row || typeof row.open !== 'boolean' || typeof row.at !== 'string')
          throw new Error('Exposure catalogue read failed');
        await bounded.query('COMMIT');
        const instant = new Date(row.at);
        if (!Number.isFinite(instant.getTime())) throw new Error('Exposure catalogue time was invalid');
        return { open: row.open, at: instant.toISOString() };
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original read failure.
        }
        throw error;
      }
    }),
  );
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
