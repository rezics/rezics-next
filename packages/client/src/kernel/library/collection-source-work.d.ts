/** Canonical Source sweep/repair. NativeCollectionWork lives on the leaf public entry. */
export { CollectionSourceLedger, NativeCollectionWork, bindNativeCollectionWorkLifetime, instrumentNativeCollectionWork, requireNativeCollectionFootprint, withNativeCollectionWorkAllowance, } from './collection-native-work.ts';
export type { WorkAllowance, WorkDimensions, WorkReceipt } from './contract/work-dimensions.ts';
import type { WorkContext } from '../work/registry.ts';
type SourceLocator = {
    accounts: [string];
    collectionId: string;
};
export declare function advanceCollectionSourceWork(context: WorkContext, input: SourceLocator): Promise<'ready' | 'more' | 'unavailable'>;
/** The existing Library worker owns native checkpoints. No Source GET writes, scheduler or new participant. */
export declare function registerCollectionSourceWork(context: WorkContext): Promise<void>;
export { IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION, declareLibraryIdentityStatement, assembleLibraryIdentityOriginalComponents, LIBRARY_IDENTITY_CHECKOUT_WORK, LIBRARY_IDENTITY_ORIGINAL_MISSING_OPERANDS, assembleLibraryIdentitySelectedBodies, LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES, LIBRARY_IDENTITY_SELECTED_MISSING_OPERANDS, } from './identity-original-work.ts';
