import { type AttemptResult, type BulkDependencies, type TargetCommand } from './bulk-contract.ts';
/** Read only the exact owner-home removal receipt; never restore authority or issue another write. */
export declare function reconcileLibraryRemovalTarget(deps: BulkDependencies, command: TargetCommand): Promise<AttemptResult | null>;
/** Native personal entry effects always share the initiating owner's home with their terminal result. */
export declare function executeLibraryRemovalTarget(deps: BulkDependencies, original: TargetCommand): Promise<AttemptResult>;
