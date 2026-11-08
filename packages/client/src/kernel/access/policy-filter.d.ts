import type { PolicyResidual } from '@rezics/access';
import type { CollectionListFilter } from '../library/contract/index.ts';
import type { CollectionListPolicyOutcome } from './contract/index.ts';
export type { CollectionListFilter };
/** Bind Access residual outcomes onto Library's admitted directory parameter map. */
export declare function bindCollectionListFilter(outcome: CollectionListPolicyOutcome): CollectionListFilter;
/** Lower only the two residual shapes admitted by the current indexed list profile. */
export declare function lowerCollectionListResidual(residual: PolicyResidual): CollectionListFilter;
