import type { ShelfReadDependencies, ShelfReads } from './shelf-contract.ts';
export type ShelfNativeReadBindings = Pick<ShelfReadDependencies, 'maintenance' | 'generation'>;
/** Actual date/session/dictionary/count SQL and the existing opaque codec; no specification-only factory. */
export declare function createDefaultShelfReads(dependencies: Pick<ShelfReadDependencies, 'pool' | 'access' | 'tokens' | 'clock'> & ShelfNativeReadBindings): ShelfReads;
