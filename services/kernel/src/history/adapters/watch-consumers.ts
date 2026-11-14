import {
  ACCOUNT_ROLE_BITS,
  COMMAND_HISTORY_KINDS,
  type HistoryArtifact,
  type HistoryBarrier,
  type HistoryRegistry,
} from '../contract/index.ts';

const WATCH_RECEIPTS = [
  ['content.board.watch', COMMAND_HISTORY_KINDS['content.board.watch']],
  ['content.watch.remove', COMMAND_HISTORY_KINDS['content.watch.remove']],
] as const;

const WATCH_EVENTS = ['com.rezics.content.board.watch.changed.v1', 'com.rezics.content.watch.removed.v1'] as const;

/** These copies have no durable response, projection, or work consumer. The minimizers still
 * require the exact source and association, this account's committed barrier, and (for events)
 * effects settlement with every open event consumer closed. */
function exactOwnerAssociation(artifact: HistoryArtifact, barrier: HistoryBarrier): boolean {
  const locator = artifact.locator;
  const account = artifact.accounts[0];
  if (!account || artifact.accounts.length !== 1 || locator.artifactType === 'durable-work/v1') return false;
  return (
    account.accountId === barrier.accountId &&
    account.accountRoute === barrier.accountRoute &&
    (account.roles & ACCOUNT_ROLE_BITS.owner) !== 0 &&
    locator.partitionNo === artifact.partition
  );
}

export function registerWatchHistoryConsumers({ history }: { history: HistoryRegistry }): void {
  for (const [name, commandKindId] of WATCH_RECEIPTS) {
    history.registerOwner({
      name,
      artifactType: 'command-receipt/v1',
      version: 1,
      async readiness(_tx, artifact, barrier) {
        if (
          artifact.locator.artifactType !== 'command-receipt/v1' ||
          artifact.locator.commandKindId !== commandKindId ||
          artifact.locator.principalKind !== 'account' ||
          artifact.locator.principalId !== barrier.accountId ||
          !exactOwnerAssociation(artifact, barrier)
        )
          return { ready: false, gap: 'content-watch-owner-association-unavailable' };
        return { ready: true };
      },
    });
  }
  for (const name of WATCH_EVENTS) {
    history.registerOwner({
      name,
      artifactType: 'outbox-event/v1',
      version: 1,
      async readiness(_tx, artifact, barrier) {
        if (artifact.locator.artifactType !== 'outbox-event/v1' || !exactOwnerAssociation(artifact, barrier))
          return { ready: false, gap: 'content-watch-owner-association-unavailable' };
        return { ready: true };
      },
    });
  }
}
