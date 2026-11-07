/** Exact locator projection without loading preparation implementations. */
import type { TypePreparationInput, TypePreparationBinding } from './type-preparation-contract.ts';
export function typePreparationBinding(input: TypePreparationInput): TypePreparationBinding {
  if (input.source.position < 0n || input.ownerEpoch < 0n)
    throw new RangeError('Preparation positions and owner epochs must be nonnegative');
  return Object.freeze({
    accountId: input.accountId,
    subjectId: input.subjectId,
    requestKey: input.requestKey,
    sourceId: input.sourceId,
    sourcePartition: input.source.partition,
    sourceEpoch: input.source.epoch,
    sourcePosition: input.source.position.toString(10),
    ownerEpoch: input.ownerEpoch.toString(10),
  });
}
