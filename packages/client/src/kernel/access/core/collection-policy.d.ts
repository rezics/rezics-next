/** Pure Collection list residual interpretation and owner/public fact selection.
 * Native catalogue compilation, specializePolicy and SQL stay in Access adapters.
 */
import { type CollectionListPolicyFacts, type CollectionListPolicyOutcome, type CollectionListPolicyRequest, type CollectionListResourceOperand } from '../contract/collection-policy.ts';
import type { AccessWorkDimensions } from '../contract/bounds.ts';
export declare function collectionListPolicyRequest(fullView: boolean): CollectionListPolicyRequest;
export declare function collectionListPolicyFacts(fullView: boolean): CollectionListPolicyFacts;
export declare function collectionListRequiredResiduals(fullView: boolean): readonly CollectionListResourceOperand[];
/** Lower only the two residual shapes admitted by the current indexed list profile. */
export declare function interpretCollectionListResidual(residual: unknown): CollectionListPolicyOutcome;
export declare function admitCollectionListOutcome(outcome: CollectionListPolicyOutcome, fullView: boolean): CollectionListPolicyOutcome;
export declare function sumCollectionAuthorizationWork(parts: readonly AccessWorkDimensions[]): AccessWorkDimensions;
