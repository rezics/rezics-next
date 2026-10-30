import { type CommandTransaction } from '../command/command.ts';
import type { ShelfDerivedPage } from './shelf-maintenance-ops-contract.ts';
import type { ShelfTypeKeys } from './shelf-contract.ts';
import type { TypePreparationContinuationDependencies, TypePreparationDependencies, TypePreparationPorts } from './type-preparation-contract.ts';
/** Only the native runner's live WeakMap page can enter the shared dictionary core during rebuilding. */
export declare function withShelfDerivedTypePreparation<T>(tx: CommandTransaction, page: ShelfDerivedPage, reservationId: string | null, body: () => Promise<T>): Promise<T>;
export declare function createShelfTypeKeys(): ShelfTypeKeys;
/** Admission closure is private: callers cannot turn a constructed evidence object into writer authority. */
export declare function createTypePreparationPorts(dependencies: TypePreparationDependencies): TypePreparationPorts;
export declare function createTypePreparationContinuation(dependencies: TypePreparationContinuationDependencies): Pick<TypePreparationPorts, 'continue'>;
export default createShelfTypeKeys;
