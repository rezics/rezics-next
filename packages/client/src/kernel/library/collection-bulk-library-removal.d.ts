import { type AttemptResult, type BulkDependencies, type TargetCommand } from './bulk-contract.ts';
/** Native personal entry effects always share the initiating owner's home with their terminal result. */
export declare function executeLibraryRemovalTarget(deps: BulkDependencies, original: TargetCommand): Promise<AttemptResult>;
