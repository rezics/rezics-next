/** Access-owned Library capabilities. Imported only through this public entry. */
export { collectionKindInputWork } from './collection-kind-input-bounds.ts';
export type { CollectionKindInputBinding, CollectionKindInputResult, CollectionKindRawInputBody, } from './collection-kind-input.ts';
export { NativeCollectionWork, bindNativeCollectionWorkLifetime, instrumentNativeCollectionWork, requireNativeCollectionFootprint, withNativeCollectionWorkAllowance, } from './collection-native-work.ts';
export type { WorkAllowance, WorkDimensions, WorkReceipt } from './contract/work-dimensions.ts';
