import { withinCeiling } from '@rezics/bounds';
import { currentCommandWorkAssociation } from '../command/work-context.ts';
import {
  collectionReductionStatements,
  collectionReductionBound,
  collectionReductionStatementBounds,
} from './adapters/collection-reduction.ts';
export { PUBLIC_FILTER_COLLECTION_REDUCTION_DECLARATION } from './adapters/collection-reduction.ts';

/** Execute one actual Collection reduction statement against its immutable local maximum. */
export function runPublicFilterCollectionReductionQuery<Client, Input extends object, Result>(
  id: keyof ReturnType<typeof collectionReductionStatements>,
  query: Readonly<{ sql: string; params: readonly string[]; run(client: Client, input: Input): Promise<Result> }>,
  client: Client,
  input: Input,
): Promise<Result> {
  const item = collectionReductionStatements()[id]!;
  if (item.query.sql !== query.sql) throw new TypeError(`Collection public-reduction SQL owner mismatch: ${id}`);
  const actual = collectionReductionBound(item, input as Readonly<Record<string, unknown>>);
  const ceiling = collectionReductionStatementBounds()[id]!;
  if (!withinCeiling(actual, ceiling))
    throw new TypeError(`Collection public-reduction bind exceeds its ceiling: ${id}`);
  const association = currentCommandWorkAssociation();
  const { engineRequests: _engineRequests, ...work } = actual;
  return association
    ? association.run(`semantic.public-filter-collection-reduction.${id}`, work, () => query.run(client, input))
    : query.run(client, input);
}
