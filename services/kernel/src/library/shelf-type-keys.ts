/** Compatibility facade; allocator consumers import the dictionary leaf. */
export {
  createShelfTypeKeys,
  createShelfTypeKeys as default,
  SHELF_TYPE_DIGEST_ENV,
  sha256ShelfTypeDigest,
  applyShelfTypeDigest,
  shelfTypeDigestFromEnvironment,
  withShelfDerivedTypePreparation,
} from './shelf-type-dictionary.ts';
export type { ShelfTypeDigest, ShelfTypeKeysOptions } from './shelf-type-dictionary.ts';
import { createNativeTypePreparationPorts } from './type-preparation.ts';
import { withShelfTypePreparation } from './shelf-type-dictionary.ts';
import type {
  TypePreparationDependencies,
  TypePreparationContinuationDependencies,
  TypePreparationPorts,
} from './type-preparation-contract.ts';

export function createTypePreparationPorts(dependencies: TypePreparationDependencies): TypePreparationPorts {
  return createNativeTypePreparationPorts(dependencies, withShelfTypePreparation);
}
export function createTypePreparationContinuation(
  dependencies: TypePreparationContinuationDependencies,
): Pick<TypePreparationPorts, 'continue'> {
  return { continue: createNativeTypePreparationPorts(dependencies, withShelfTypePreparation).continue };
}
