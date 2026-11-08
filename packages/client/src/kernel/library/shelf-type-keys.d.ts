/** Compatibility facade; allocator consumers import the dictionary leaf. */
export { createShelfTypeKeys, createShelfTypeKeys as default, SHELF_TYPE_DIGEST_ENV, sha256ShelfTypeDigest, applyShelfTypeDigest, shelfTypeDigestFromEnvironment, withShelfDerivedTypePreparation, } from './shelf-type-dictionary.ts';
export type { ShelfTypeDigest, ShelfTypeKeysOptions } from './shelf-type-dictionary.ts';
import type { TypePreparationDependencies, TypePreparationContinuationDependencies, TypePreparationPorts } from './type-preparation-contract.ts';
export declare function createTypePreparationPorts(dependencies: TypePreparationDependencies): TypePreparationPorts;
export declare function createTypePreparationContinuation(dependencies: TypePreparationContinuationDependencies): Pick<TypePreparationPorts, 'continue'>;
