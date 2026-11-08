import { type AuthoritativeTime, type CommandTransaction } from '../../command/command.ts';
import type { Copy } from '../entry-model.ts';
import * as store from '../entry-store.ts';
import { decodeLibraryProfilePin } from '../profile-pin.ts';
import { copyPrivateReadStatementPlan } from '../copy-operation-bounds.ts';
import type { LibraryProfileSource } from '../profile-source.ts';
import type { NativeCopyConfig, NativeCopyProducers, CopySourceObservation } from '../copy-model.ts';
export type { NativeCopyConfig, NativeCopyProducers } from '../copy-model.ts';
import type { CopyPresentation } from '../copy-model.ts';
import { prepareCopyInventory, readCopyInventoryValues } from '../copy-inventory.ts';
import type { CommandAttempt, CommandOutcome } from '../../command/command.ts';
import type { CopyApplicationPorts, LibraryCursorCapability } from '../contract/index.ts';
import type { KeyRing } from '../../tokens/seal.ts';
type Command = {
    transactionId: string;
    time: AuthoritativeTime;
};
export type NativeCopyTypes = {
    transaction: CommandTransaction;
    time: AuthoritativeTime;
    attempt: CommandAttempt;
    command: Command;
    outcome: CommandOutcome<Copy>;
    copy: Copy;
    fact: NonNullable<Awaited<ReturnType<typeof store.readCopyFact>>>;
    source: LibraryProfileSource;
    observation: CopySourceObservation;
    retained: NonNullable<Awaited<ReturnType<ReturnType<typeof copyPrivateReadStatementPlan>['run']>>>;
    detail: {
        copy: Copy;
        compatibilityPin: ReturnType<typeof decodeLibraryProfilePin>;
        kindPin: ReturnType<typeof decodeLibraryProfilePin>;
        statusPin: ReturnType<typeof decodeLibraryProfilePin>;
    };
    presentation: CopyPresentation;
    inventory: Awaited<ReturnType<typeof prepareCopyInventory>>;
    inventoryValues: Awaited<ReturnType<typeof readCopyInventoryValues>>;
};
/** One adapter around the existing command runner, storage, immutable-release and source producers. */
export declare function createNativeCopyPorts(config: NativeCopyConfig, producers: NativeCopyProducers, cursors: LibraryCursorCapability<KeyRing>): CopyApplicationPorts<NativeCopyTypes>;
