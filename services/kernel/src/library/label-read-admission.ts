import type { Pool, PoolClient } from 'pg';
import { GrantDeniedError } from '../access/contract/errors.ts';
import accountShare from '../access/account-share.sql';
import { deadlineClient, readAccountCommandState } from './access-port.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { AccountActor, Actor } from '../request/access.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { runLibraryBoundedOperation } from './collection-command-work.ts';
import { labelReadAdmissionWork } from './label-operation-bounds.ts';

type Client = Pick<PoolClient, 'query'>;

export type LabelReadHome = Readonly<{ epoch: number; position: bigint }>;

export const LABEL_READ_HOME_EPOCH: unique symbol = Symbol('library.label-read-home-epoch');
export type LabelReadPage<T extends object> = T & { readonly [LABEL_READ_HOME_EPOCH]: number };

/** Lock the current owner and read its home from the same snapshot as private label data. */
export async function admitLabelRead(client: Client, actor: AccountActor, route: number): Promise<LabelReadHome> {
  await accountShare.run(client, { route, account_id: actor.accountId });
  const current = await readAccountCommandState(client, route, actor.accountId);
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

  const row = await readPartition(client, partitionOf(route));
  if (!row || row.writeState !== 'active' || row.movedTo !== null) throw new GrantDeniedError();
  return Object.freeze({ epoch: row.epoch, position: row.position });
}

export function attachLabelReadHome<T extends object>(page: T, home: LabelReadHome): LabelReadPage<T> {
  Object.defineProperty(page, LABEL_READ_HOME_EPOCH, { value: home.epoch, enumerable: false });
  return page as LabelReadPage<T>;
}

export function selectedLabelReadHomeEpoch(page: LabelReadPage<object>): number {
  return page[LABEL_READ_HOME_EPOCH];
}

/** Recheck after foreign enrichment, with no account or selection connection held during that work. */
export async function reAdmitLabelRead(
  pool: Pool,
  actor: Actor,
  expectedHomeEpoch: number,
  deadline: number,
): Promise<void> {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  const route = routeOf(actor.accountId);
  if (route === null) throw new GrantDeniedError();

  await withRequestDeadline(deadline, () =>
    runLibraryBoundedOperation(
      'library.label.read.final-admission',
      labelReadAdmissionWork(route, actor.accountId, 'READ COMMITTED'),
      () =>
        withConnection(pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          try {
            const home = await admitLabelRead(client, actor, route);
            if (home.epoch !== expectedHomeEpoch) throw new GrantDeniedError();
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        }),
    ),
  );
}

/** Preserve the enriched value only when the owner and selected home remain current. */
export async function enrichAndReAdmitLabelRead<T>(input: {
  pool: Pool;
  actor: Actor;
  expectedHomeEpoch: number;
  deadline: number;
  enrich: () => Promise<T>;
}): Promise<T> {
  const result = await input.enrich();
  await reAdmitLabelRead(input.pool, input.actor, input.expectedHomeEpoch, input.deadline);
  return result;
}
