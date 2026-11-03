import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { ShelfReadDependencies, ShelfReads } from './shelf-contract.ts';
import { createShelfReads } from './shelf-reads.ts';
import { createShelfPageReader } from './shelf-reader-page.ts';
import { createShelfMetadataReaders } from './shelf-reader-metadata.ts';
import { createShelfTypeLookup } from './shelf-reader-types.ts';
import type { ShelfTypeDigest } from './shelf-type-keys.ts';
import { readShelfGeneration } from './shelf-reader-generation.ts';

export type ShelfNativeReadBindings = Pick<ShelfReadDependencies, 'maintenance' | 'generation'> & {
  shelfTypeDigest?: ShelfTypeDigest;
};

/** Actual date/session/dictionary/count SQL and the existing opaque codec; no specification-only factory. */
export function createDefaultShelfReads(
  dependencies: Pick<ShelfReadDependencies, 'pool' | 'access' | 'tokens' | 'clock'> & ShelfNativeReadBindings,
): ShelfReads {
  const generation = dependencies.generation ?? readShelfGeneration;
  const metadata = createShelfMetadataReaders(generation);
  return createShelfReads({
    ...dependencies,
    generation,
    pageReader: createShelfPageReader(),
    summaryReader: metadata,
    facetReader: metadata,
    typeKeys: { lookup: createShelfTypeLookup(dependencies.shelfTypeDigest) },
    cursors: { encode: encodeListCursor, decode: decodeListCursor },
  });
}
