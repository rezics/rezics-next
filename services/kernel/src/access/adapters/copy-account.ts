/** Access owns its private SQL, row projections and current authentication floor. */
import type { Pool, PoolClient } from 'pg';
import type { AuthoritativeTime, CommandTransaction } from '../../command/command.ts';
import { readAccount } from '../account-data.ts';
import { GrantDeniedError } from '../resource-access-errors.ts';
import { routeOf } from '../../route/route.ts';
import { accessCheck, type Access } from '../../request/access.ts';
import type { CopyAccountAdmission, CopyAccountStatementWork, CopyAccountWork } from '../contract/index.ts';
import accountRead from '../account-read.sql';
import accountState from '../account-command-state.sql';
import accountShare from '../account-share.sql';

type Client = Pick<PoolClient, 'query'>;
function work(
  sql: string,
  input: unknown,
  keys: number,
  rows: number,
  points: number,
  seeks: number,
  outputBytes = 0,
): CopyAccountStatementWork {
  return {
    candidateKeys: keys,
    nativeRows: rows,
    identityMetadataRows: 0,
    emptySeeks: seeks,
    nativePoints: points,
    witnessKeys: 0,
    statements: 1,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(input)) + outputBytes + 2,
    engineRequests: 0,
  };
}
/** The full projection is the account-read producer's contract, including signed route and bigint maxima. */
export function nativeCopyAccountWork(): CopyAccountWork {
  return {
    floor(route, accountId) {
      return work(
        accountRead.sql,
        { route, account_id: accountId },
        1,
        1,
        1,
        1,
        Buffer.byteLength(
          JSON.stringify({
            route: 65535,
            accountId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
            kind: 'actor',
            state: 'active',
            fenced: true,
            minimumAuthnEpoch: '9223372036854775807',
            transactionId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          }),
        ),
      );
    },
    command(route, accountId) {
      const input = { route, account_id: accountId };
      const read = work(accountRead.sql, input, 0, 0, 0, 0);
      const state = work(
        accountState.sql,
        input,
        1,
        1,
        1,
        1,
        Buffer.byteLength(
          JSON.stringify({
            kind: 'actor',
            state: 'active',
            fenced: true,
            minimumAuthnEpoch: '9223372036854775807',
          }),
        ),
      );
      return { ...state, bytes: Math.max(read.bytes, state.bytes) };
    },
    share(route, accountId) {
      return work(accountShare.sql, { route, account_id: accountId }, 2, 2, 2, 1, 256);
    },
  };
}

export function createNativeCopyAccountAdmission(config: {
  pool: Pool;
  access: Access;
}): CopyAccountAdmission<CommandTransaction, AuthoritativeTime> {
  return {
    async admit(client: Client, owner) {
      const route = routeOf(owner.accountId)!;
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
    },
    check(owner, route, at, deadline) {
      return accessCheck(
        config.access,
        owner,
        'copy:read',
        { route, id: owner.accountId },
        { pool: config.pool, deadline, time: at },
      );
    },
    denied: () => new GrantDeniedError(),
  };
}
