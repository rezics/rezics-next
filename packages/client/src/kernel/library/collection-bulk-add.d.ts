import type { AttemptResult, BulkDependencies, TargetCommand } from './bulk-contract.ts';
/** Execute one exact captured subject add. Same-home effects and outcomes share one command;
 * remote Collection commands return their durable receipt evidence for source-side acknowledgement.
 */
export declare function executeCollectionAddTarget(dependencies: BulkDependencies, command: TargetCommand): Promise<AttemptResult>;
