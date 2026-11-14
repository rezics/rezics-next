import type { CommandTransaction } from '../command/command.ts';
import {
  ACCOUNT_ROLE_BITS,
  unionHistoryScope,
  type AccountReference,
  type CommandHistoryKind,
  type CommandHistoryScopes,
} from '../history/contract/index.ts';
import {
  commandHistoryIdentityAccounts,
  declareCommandHistory,
  guardHistoryAccounts,
} from '../history/application/records.ts';

export type CollectionPublicationHistoryOwner = Pick<AccountReference, 'accountRoute' | 'accountId'>;

/** Keep the Collection owner distinct from identity roles proved by this command's authorization. */
export function collectionPublicationHistoryScopes(
  owner: CollectionPublicationHistoryOwner,
  identityAccounts: readonly AccountReference[],
  eventCount: number,
): CommandHistoryScopes {
  if (!Number.isSafeInteger(eventCount) || eventCount < 0 || eventCount > 1000)
    throw new TypeError('Invalid Collection publication History event count');
  const accounts = unionHistoryScope(
    'command-receipt/v1',
    [{ ...owner, roles: ACCOUNT_ROLE_BITS.owner }],
    identityAccounts,
  ).accounts;
  return Object.freeze({
    response: unionHistoryScope('command-receipt/v1', accounts),
    events: Object.freeze(Array.from({ length: eventCount }, () => unionHistoryScope('outbox-event/v1', accounts))),
  });
}

/** Hold the exact copied identities against a committed erasure, including receipt replays. */
export async function guardCollectionPublicationHistory(
  tx: CommandTransaction,
  partition: number,
  owner: CollectionPublicationHistoryOwner,
  eventCount: number,
): Promise<void> {
  const scopes = collectionPublicationHistoryScopes(owner, commandHistoryIdentityAccounts(tx), eventCount);
  const accounts = unionHistoryScope(
    'command-receipt/v1',
    scopes.response.accounts,
    ...scopes.events.map(({ accounts: eventAccounts }) => eventAccounts),
  ).accounts;
  await guardHistoryAccounts(tx, partition, accounts);
}

/** Record the copied receipt and ordered event roles before the first native write. */
export async function declareCollectionPublicationHistory(
  tx: CommandTransaction,
  kind: CommandHistoryKind,
  owner: CollectionPublicationHistoryOwner,
  eventCount: number,
): Promise<void> {
  await declareCommandHistory(
    tx,
    kind,
    collectionPublicationHistoryScopes(owner, commandHistoryIdentityAccounts(tx), eventCount),
  );
}
