import type { OperationalTransaction } from '../command/operational.ts';
import { type CanonicalRawKey } from './canonical-source-store.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import type { WorkDimensions } from './collection-source.ts';
import type { NativeSourceIdentity, NativeSourceCustody } from './native-source-custody.ts';
import { type CollectionKindPreparationLocator } from './collection-kind-work-admission.ts';
export declare const COLLECTION_KIND_INPUT_RAW_LIMIT = 100;
export declare const COLLECTION_KIND_INPUT_BYTE_LIMIT = 4096;
type Progress = Readonly<{
    driver: CanonicalRawKey['driver'] | 'done';
    after: CanonicalRawKey | null;
}>;
export type CollectionKindRawInputBody = Readonly<{
    format: 1;
    original: Readonly<{
        id: string;
        digest: string;
        formula: string;
        audience: string;
    }>;
    enrollment: Readonly<{
        reference: string;
        generation: string;
        restore: string;
        catalogue: string;
    }>;
    preparation: Readonly<{
        id: string;
        version: string;
        predecessor: string | null;
    }>;
    source: Readonly<{
        identity: NativeSourceIdentity;
        fence: string;
        capture: string;
        transaction: string;
        hold: string;
    }>;
    before: Progress;
    after: Progress;
    rows: readonly Readonly<{
        key: CanonicalRawKey;
    }>[];
    exhausted: boolean;
}>;
export type CollectionKindInputBinding = Readonly<{
    locator: CollectionKindPreparationLocator;
    inputId: string;
    body: CollectionKindRawInputBody;
    custody: NativeSourceCustody;
}>;
export declare function collectionKindInputWork(): WorkDimensions;
export type CollectionKindInputResult = Readonly<{
    status: 'committed';
    binding: CollectionKindInputBinding;
}> | Readonly<{
    status: 'awaiting_commit';
    inputId: string;
}> | Readonly<{
    status: 'unavailable';
    reason: string;
}>;
/** Called by the original audience resolver on its SAME live native home. The
 * first call produces an interval; only a subsequent committed native lookup
 * returns it. No foreign Type/Access call occurs before the caller releases T.
 */
export declare function resolveCollectionKindRawInput(tx: OperationalTransaction, locator: CollectionKindPreparationLocator, originId: string, work: NativeCollectionWork): Promise<CollectionKindInputResult>;
export {};
