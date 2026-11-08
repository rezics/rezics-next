/** Local terminal disposition; shared native holds remain their actual owner's obligation. */
import type { CommandTransaction } from '../command/command.ts';
import type { CollectionCleanupPage } from './collection-retention.ts';
/** Called only under the participant's terminal account fence and locked owning Collection. */
export declare function purgeSavedCollectionPage(tx: CommandTransaction, input: {
    accountId: string;
    collectionId: string;
}): Promise<CollectionCleanupPage | null>;
