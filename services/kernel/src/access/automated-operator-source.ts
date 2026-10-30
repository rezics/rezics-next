import type { Pool } from 'pg';
import {
  AUTH_MANAGEMENT_CLIENT_ID,
  AUTH_MANAGEMENT_SCOPES,
  type AuthSessionPort,
  type SessionProof,
} from '@rezics/auth-contract';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { accessClock } from './access-clock.ts';
import { deadlineClient, within } from './authenticate.ts';
import { AuthBindingDeniedError } from './auth-bindings.ts';
import {
  AccessUnavailableError,
  CommandUnavailableError,
  requireAccessDeadline,
  throwAccessUnavailable,
} from './unavailable.ts';
import humanSource from './automated-operator-source-human.sql';
import operatorSource from './automated-operator-source.sql';

export type AutomatedCreationOperator = Readonly<{
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
}>;
/** Local trusted composition; a browser selection never supplies the human. */
export interface AutomatedOperatorAccess {
  readAutomatedCreationOperator(input: {
    human: SessionProof;
    operatorAccountId: string;
    deadline: number;
  }): Promise<AutomatedCreationOperator | null>;
}

/** Two current passes of the installed account:manage formula at live native T.
 * Each source is one exact account point in its own partition snapshot. Source
 * checkouts never enclose Access preparation or another pool checkout. Labels
 * are command preconditions only; creation still obtains its own fresh authority.
 */
export async function readAutomatedCreationOperator(
  deps: { pool: Pool; access: Access; clock?: () => Date },
  actor: Actor,
  selection: { operatorAccountId: string },
  context: { deadline: number },
): Promise<AutomatedCreationOperator | null> {
  const { pool, access } = deps;
  const { deadline } = context;
  const operatorAccountId = selection.operatorAccountId;
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || routeOf(operatorAccountId) === null)
    throw new AuthBindingDeniedError();
  const humanId = actor.accountId;
  const authnEpoch = actor.authnEpoch;
  const target = { route: routeOf(operatorAccountId)!, id: operatorAccountId };
  if (!Number.isFinite(deadline)) throw new AccessUnavailableError('deadline');
  async function point<T>(id: string, read: (client: Parameters<Access['authorize']>[0], route: number) => Promise<T>) {
    requireAccessDeadline(deadline);
    return withReadTransaction(pool, async (client) => {
      const bounded = deadlineClient(client, deadline);
      const route = routeOf(id)!;
      const home = partitionOf(route);
      const partition = await readPartition(bounded, home);
      if (!partition) throw new CommandUnavailableError('contention', home);
      if (partition.writeState !== 'active')
        throw new CommandUnavailableError(
          partition.writeState === 'moved' ? 'moved' : 'fenced',
          home,
          partition.movedTo,
        );
      // Position advances for unrelated commands in the partition. Only the
      // actual home/epoch and selected account revision bind this observation.
      return { home: { node: partition.node, epoch: partition.epoch }, row: await read(bounded, route) };
    });
  }
  const human = () => point(humanId, (client, route) => humanSource.run(client, { route, account_id: humanId }));
  const operator = () =>
    point(operatorAccountId, (client, route) => operatorSource.run(client, { route, account_id: operatorAccountId }));
  const equal = (before: unknown, final: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(final)) throw new AccessUnavailableError('contention');
  };
  async function current() {
    requireAccessDeadline(deadline);
    const time = await withConnection(pool, (client) =>
      mintReadTime(deadlineClient(client, deadline), deps.clock ?? accessClock(access)),
    );
    try {
      const caller = await human();
      const h = caller.row;
      if (
        !h ||
        h.kind !== 'actor' ||
        h.state !== 'active' ||
        h.fenced ||
        h.operatorAccountId !== null ||
        !Number.isSafeInteger(authnEpoch) ||
        authnEpoch <= 0 ||
        BigInt(authnEpoch) < BigInt(h.floor)
      )
        throw new AuthBindingDeniedError();
      const before = await operator();
      const row = before.row;
      // Native reserveResponsibility eligibility: active, unfenced and no operator.
      // Kind/equality/organization role never confers management permission.
      const eligible =
        row &&
        (row.kind === 'actor' || row.kind === 'organization') &&
        row.state === 'active' &&
        !row.fenced &&
        row.operatorAccountId === null;
      if (eligible) {
        const check = await accessCheck(access, actor, 'account:manage', target, { pool, deadline, time });
        await withConnection(pool, async (client) => {
          if (!(await check(deadlineClient(client, deadline), time))) throw new AuthBindingDeniedError();
        });
      }
      equal(before, await operator());
      equal(caller, await human());
      requireAccessDeadline(deadline);
      return { caller, source: before, eligible };
    } finally {
      releaseOperationalTime(time);
    }
  }
  try {
    return await within(deadline, async () => {
      const before = await current();
      const final = await current();
      equal(before, final);
      requireAccessDeadline(deadline);
      const row = final.source.row;
      return final.eligible && row
        ? {
            id: operatorAccountId,
            kind: row.kind as 'actor' | 'organization',
            handle: row.handle,
            displayName: row.displayName,
          }
        : null;
    });
  } catch (error) {
    if (error instanceof AuthBindingDeniedError || error instanceof CommandUnavailableError) throw error;
    throwAccessUnavailable(error, deadline);
    throw new AccessUnavailableError('overloaded');
  }
}

/** Only Auth's actual signer and native Access may produce this Actor. */
export function createAutomatedOperatorAccess(deps: {
  pool: Pool;
  access: Access;
  clock?: () => Date;
  accessTokenForProof: AuthSessionPort['internal']['accessTokenForProof'];
}): AutomatedOperatorAccess {
  return {
    async readAutomatedCreationOperator({ human, operatorAccountId, deadline }) {
      requireAccessDeadline(deadline);
      return within(deadline, async () => {
        const actor = await deps.access.authenticate(await deps.accessTokenForProof(human), {
          pool: deps.pool,
          deadline,
        });
        if (
          human.client_id !== AUTH_MANAGEMENT_CLIENT_ID ||
          JSON.stringify(human.scope) !== JSON.stringify(AUTH_MANAGEMENT_SCOPES.transfer) ||
          actor.accountId !== human.account_id ||
          actor.clientId !== human.client_id ||
          actor.authnEpoch !== human.authn_epoch ||
          actor.requestedBy !== null ||
          JSON.stringify(actor.scopes) !== JSON.stringify(human.scope)
        )
          throw new AuthBindingDeniedError();
        return readAutomatedCreationOperator(deps, actor, { operatorAccountId }, { deadline });
      });
    },
  };
}
