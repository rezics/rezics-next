import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { ShelfReadDependencies, ShelfReads } from './shelf-contract.ts';
import { createShelfReads } from './shelf-reads.ts';
import { createShelfPageReader } from './shelf-reader-page.ts';
import { createShelfMetadataReaders } from './shelf-reader-metadata.ts';
import { lookupShelfType } from './shelf-reader-types.ts';
import { ShelfReadUnavailableError } from './shelf-reader-unavailable.ts';

export type ShelfNativeReadBindings = Pick<ShelfReadDependencies, 'maintenance' | 'generation'>;

/** Actual date/session/dictionary/count SQL and the existing opaque codec; no specification-only factory. */
export function createDefaultShelfReads(
  dependencies: Pick<ShelfReadDependencies, 'pool' | 'access' | 'tokens' | 'clock'> & ShelfNativeReadBindings,
): ShelfReads {
  const generation =
    dependencies.generation ??
    (async () => {
      throw new ShelfReadUnavailableError(
        'ShelfMaintenanceOps.initialize and native RR gate/current-generation reader',
      );
    });
  const metadata = createShelfMetadataReaders(generation);
  return createShelfReads({
    ...dependencies,
    generation,
    pageReader: createShelfPageReader(),
    summaryReader: metadata,
    facetReader: metadata,
    typeKeys: { lookup: lookupShelfType },
    cursors: { encode: encodeListCursor, decode: decodeListCursor },
  });
}
