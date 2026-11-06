export { ScopeWork, scopeAllowance, scopeWorkAxes, zeroScopeWork } from './scope-work.ts';
import { ScopeWork } from './scope-work.ts';
import type { Pool } from 'pg';
import { readOwnerFilterCandidate, readOwnerFilterCandidateClosure } from '../library/owner-filter-plan.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from '../library/collection-source.ts';
import { type LeafOptions, type LeafWork } from '../semantic/scope-leaf-evidence.ts';
import type { IdentityScopeWork } from '../semantic/identity-scope-types.ts';
import type { PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import { type CurrentOwnerFilterPlan } from './current-filter-plan.ts';
import type { ScopeEvaluationProgress, ScopeEvaluationReservation } from './scope-source.ts';
import type { RelationFacetMatch } from './source.ts';
import { type MembersExecution } from './scope-members-work.ts';
export type { WorkAllowance, WorkDimensions, WorkReceipt, IdentityScopeWork, PublicFilterCost, LeafWork };
/** Retained raw native position only; it contains no cached verdict or authority. */
export type ScopeLeafResume = Readonly<{
    progress: ScopeEvaluationProgress;
    nativeBasis: string;
}>;
/** Native current evidence, one matcher and one shared ledger across subjects/leaves/replay.
 * No engine hit, sampled SubjectSnapshot, callback verdict or point mapping certifies absence.
 */
export declare function evaluateScopeSubjects(input: Readonly<{
    pool: Pool;
    options: LeafOptions;
    plan: CurrentOwnerFilterPlan;
    basis: string;
    subjects: readonly string[];
    reservation: ScopeEvaluationReservation;
    work: ScopeWork;
    resume?: ScopeLeafResume | null;
    members?: MembersExecution;
    owner?: Readonly<{
        admission: Parameters<typeof readOwnerFilterCandidate>[1];
        binding: Parameters<typeof readOwnerFilterCandidateClosure>[0];
        source: Parameters<typeof readOwnerFilterCandidateClosure>[1];
    }> | undefined;
}>): Promise<{
    values: RelationFacetMatch[];
    evidence: string[];
    progress: ScopeEvaluationProgress | null;
    resume: Readonly<{
        progress: ScopeEvaluationProgress;
        nativeBasis: string;
    }> | null;
}>;
