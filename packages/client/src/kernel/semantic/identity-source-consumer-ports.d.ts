import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { WorkAllowance, WorkDimensions } from '../library/contract/work-dimensions.ts';
import type { NativeCollectionWork } from '../library/collection-native-work.ts';
import type { AccountIdentityReversalSettlement, AccountIdentitySource } from '../access/agent-verification-identity.ts';
import type { IdentityEpochStore, IdentityIntent, IdentityNativeReceipt, IdentityReceipt } from './identity-epoch-contract.ts';
import type { IdentitySourceConsumerContext, IdentitySourceConsumerReference } from './identity-source-consumer-custody.ts';
import type { LibraryExpectedEffectAfter, LibraryScopeEffectSeal, LibraryScopeEffectsKey, LibraryScopeEffectsPage, LibraryScopeEffectsPageInput } from '../library/identity-scope-effects.ts';
export type IdentitySourceWorkDeclaration = Readonly<{
    work: WorkDimensions;
    engineRequests: 0;
}>;
type AccountReceipt = Exclude<IdentityReceipt, {
    kind: 'subject.merge';
}>;
/** Composition installs the Access, Library and binding bodies. Source never value-imports those owners. */
export type IdentitySourceConsumerRuntime = Readonly<{
    identityEpochStore(): IdentityEpochStore;
    readAccountIdentitySource(tx: CommandTransaction, receipt: AccountReceipt, intent?: IdentityIntent, undoOnly?: boolean): Promise<AccountIdentitySource>;
    originalSourceDeclaration(): IdentitySourceWorkDeclaration;
    reversalSettlementDeclaration(): IdentitySourceWorkDeclaration;
    readAccountIdentityReversalSettlement(pool: Pool, reference: IdentitySourceConsumerReference, context: IdentitySourceConsumerContext): Promise<AccountIdentityReversalSettlement | null>;
    acceptAccountIdentityTechnicalSource(tx: CommandTransaction, reference: IdentitySourceConsumerReference): Promise<IdentityNativeReceipt | null>;
    verifyAccountIdentityTechnicalSource(tx: CommandTransaction, reference: IdentitySourceConsumerReference, receiving: IdentityNativeReceipt): Promise<boolean>;
    bindingConsumerDeclaration(): IdentitySourceWorkDeclaration;
    declareLibraryIdentityCustodyOperation(operation: 'revalidateHold'): IdentitySourceWorkDeclaration;
    libraryOriginalDeclaration(): IdentitySourceWorkDeclaration;
    readLibraryScopeEffectsPage(pool: Pool, input: LibraryScopeEffectsKey & Readonly<{
        after: LibraryExpectedEffectAfter | null;
        limit: number;
        allowance: WorkAllowance;
        deadline: number;
    }>): Promise<LibraryScopeEffectsPage>;
    readLibraryScopeEffectsPageWithWork(pool: Pool, input: LibraryScopeEffectsPageInput, work: NativeCollectionWork): Promise<LibraryScopeEffectsPage>;
    verifyLibraryScopeEffectsSeal(tx: CommandTransaction, key: LibraryScopeEffectsKey, seal: LibraryScopeEffectSeal): Promise<boolean>;
}>;
export declare function bindIdentitySourceConsumerRuntime(runtime: IdentitySourceConsumerRuntime): void;
export declare function identitySourceConsumerRuntime(): IdentitySourceConsumerRuntime;
export {};
