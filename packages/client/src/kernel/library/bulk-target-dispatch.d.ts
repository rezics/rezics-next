import type { BulkDependencies, TargetCommand, AttemptResult } from './bulk-contract.ts';
export declare function executeStatusTarget(_dependencies: BulkDependencies, _command: TargetCommand): Promise<AttemptResult>;
export declare function executeCollectionRemoveTarget(dependencies: BulkDependencies, command: TargetCommand): Promise<AttemptResult>;
/** Private source-bound accounting; can recover prior commits after revocation,
 * cannot restore an initiator, issue personal effects or disclose target data.
 */
export declare function reconcileBulkTarget(dependencies: BulkDependencies, command: TargetCommand): Promise<AttemptResult | null>;
