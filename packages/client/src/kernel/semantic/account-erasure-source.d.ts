import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import type { PublicFilterReadContext } from './public-filter-source-contract.ts';
import type { SubjectErasurePageReceipt, SubjectErasureSourceFactory, SubjectErasureSourceProof } from './account-erasure-source-contract.ts';
import { type HistoryBarrier } from '../history/contract/index.ts';
export type { SubjectErasureSourceOverflow, SubjectErasureSourceProof } from './account-erasure-source-contract.ts';
/** Advance a separate Source-owned cursor. Search discovery/consumption cannot mint this proof.
 * Each call transfers at most one native role or a funded run of sealed empty homes under the same 100-input budget.
 */
export declare function readSubjectErasureSourceProof(deps: Readonly<{
    pool: Pool;
    clock?: () => Date;
}>, barrier: HistoryBarrier, context: PublicFilterReadContext): Promise<SubjectErasureSourceProof | null>;
/** A committed nonterminal transfer has another runnable page. Only a complete chain carries a proof. */
export declare function advanceSubjectErasureSourceProof(deps: Readonly<{
    pool: Pool;
    clock?: () => Date;
}>, barrier: HistoryBarrier, context: PublicFilterReadContext): Promise<{
    status: 'progress' | 'pending';
} | {
    status: 'complete';
    proof: SubjectErasureSourceProof;
}>;
/** Resolve the separate Source terminal and, when requested, the receiver's exact consumed terminal. */
export declare function verifySubjectErasureSourceProof(tx: CommandTransaction, barrier: HistoryBarrier, proof: SubjectErasureSourceProof, consumedPageId?: string): Promise<boolean>;
/** Receipts are native row locators. No object identity or caller brand participates in verification.
 * Accept custody in Search's existing account-home command before requesting the next page.
 */
export declare function verifySubjectErasureSourcePage(tx: CommandTransaction, barrier: HistoryBarrier, receipt: SubjectErasurePageReceipt): Promise<boolean>;
export declare const createSubjectErasureSource: SubjectErasureSourceFactory;
