import type { Pool } from 'pg';
/** Imported-tuple home selection without loading cover media. */
export declare function importedTupleRouteOf(pool?: Pool): (routeKey: Uint8Array, source: string, externalId: string) => number;
