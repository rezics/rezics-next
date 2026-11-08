import type { Pool, PoolClient } from 'pg';
import type { Release } from '@rezics/definitions';
import type { NativeCopyDefinitions } from './copy-model.ts';
import { MAX_COPY_FILTER_OPTIONS } from './contract/index.ts';
export { MAX_COPY_FILTER_OPTIONS };
import type { CopyInventory, CopyInventoryValue } from './contract/index.ts';
export type { CopyInventoryChoice, CopyInventoryFacet, CopyInventory, CopyInventoryValue } from './contract/index.ts';
export type CopyInventorySnapshot = Readonly<{
    digest: string;
    release: Release;
}> | null;
/** Bounded distinct value seeks; the owner home remains the caller's already admitted transaction. */
export declare function readCopyInventoryValues(client: Pick<PoolClient, 'query'>, route: number, accountId: string): Promise<CopyInventoryValue[]>;
export declare function presentCopyInventory(values: readonly CopyInventoryValue[], snapshots: ReadonlyMap<string, CopyInventorySnapshot>, languages?: readonly string[]): CopyInventory;
/** Historical option labels come only from each value's retained accepting pin. */
export declare function prepareCopyInventory(pool: Pool, values: readonly CopyInventoryValue[], deadline: number, languages: readonly string[], definitions: NativeCopyDefinitions): Promise<CopyInventory>;
