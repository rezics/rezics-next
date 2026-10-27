import { bulkLines, type IndexAction } from './document.ts';
import type { OpenSearch } from './opensearch.ts';

/**
 * Write one batch to a physical index, preserving external versions and complete bodies.
 * Successful return proves search visibility, including independently winning writes
 * behind accepted version conflicts. A losing bulk's refresh=wait_for is insufficient.
 * A physical-index refresh may supply that proof only with complete shard acknowledgements.
 *
 * Native implementation is pending. Extract the existing IndexWriteError from indexer.ts
 * into this module and re-export it there, preserving the same class and public semantics
 * without importing the indexer here. Missing-document deletes remain successful; an
 * index_not_found_exception, unrelated item error or incomplete response must reject.
 * Indexer integration and canonical old-write fencing are separate work.
 */
export async function writeIndexActions(
  search: OpenSearch,
  index: string,
  actions: readonly IndexAction[],
): Promise<void> {
  // Retain the existing serialization and version-range contract in this authoring stub.
  bulkLines(index, actions);
  void search;
  throw new Error('Native bulk visibility acknowledgement is not implemented');
}
