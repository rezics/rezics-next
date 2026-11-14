import { GrantDeniedError, LifecycleDeniedError } from '../access/contract/errors.ts';
import { shareAccount } from './access-port.ts';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import {
  commandHistoryIdentityAccounts,
  declareCommandHistory,
  guardHistoryAccounts,
} from '../history/application/records.ts';
import { ACCOUNT_ROLE_BITS, unionHistoryScope } from '../history/contract/index.ts';
import { routeOf } from '../route/route.ts';

export const COLLECTION_BULK_TARGET_HISTORY_KIND = 'library.collectionBulk.target';

function curatorReference(accountId: string) {
  const accountRoute = routeOf(accountId);
  if (accountRoute === null) throw new TypeError('Collection curator has no account route');
  return { accountRoute, accountId, roles: ACCOUNT_ROLE_BITS.owner };
}

/** Hold both copied account roles against erasure and History's local late fence. */
export async function guardCollectionBulkTargetHistory(
  tx: CommandTransaction,
  curatorAccountId: string,
  sourceAccountId: string,
) {
  const curator = curatorReference(curatorAccountId);
  for (const accountId of [...new Set([curatorAccountId, sourceAccountId])].sort()) {
    try {
      await shareAccount(tx, accountId);
    } catch (error) {
      if (error instanceof LifecycleDeniedError) throw new GrantDeniedError();
      throw error;
    }
  }
  const identity = commandHistoryIdentityAccounts(tx);
  if (identity.length === 0) throw new TypeError('Missing verified Collection bulk command identity');
  const accounts = unionHistoryScope('command-receipt/v1', identity, [curator]).accounts;
  await guardHistoryAccounts(tx, currentCommand(tx).partition, accounts);
}

/** Declare the exact event population selected by the locked native target outcome. */
export async function declareCollectionBulkTargetHistory(
  tx: CommandTransaction,
  curatorAccountId: string | null,
  emitsEvent: boolean,
): Promise<void> {
  if (emitsEvent && curatorAccountId === null) throw new TypeError('Collection event requires a curator account');
  const accounts = curatorAccountId === null ? [] : [curatorReference(curatorAccountId)];
  const receipt = { artifactType: 'command-receipt/v1' as const, accounts };
  await declareCommandHistory(tx, COLLECTION_BULK_TARGET_HISTORY_KIND, {
    response: receipt,
    events: emitsEvent ? [{ artifactType: 'outbox-event/v1', accounts }] : [],
  });
}
