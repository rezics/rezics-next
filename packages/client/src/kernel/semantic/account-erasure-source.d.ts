import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import type { PublicFilterReadContext } from './public-filter-source-contract.ts';
import type { SubjectErasurePageReceipt, SubjectErasureSourceFactory, SubjectErasureSourceProof } from './account-erasure-source-contract.ts';
import { type HistoryBarrier } from '../history/contract/index.ts';
export type { SubjectErasureSourceOverflow, SubjectErasureSourceProof } from './account-erasure-source-contract.ts';
/** Advance a separate Source-owned cursor. Search discovery/consumption cannot mint this proof.
 * Each call transfers at most one native role or one sealed home under the same 100-input budget.
 */
export declare function readSubjectErasureSourceProof(deps: Readonly<{
    pool: Pool;
    clock?: () => Date;
}>, barrier: HistoryBarrier, context: PublicFilterReadContext): Promise<SubjectErasureSourceProof | null>;
/** Resolve the privately transferred all-home terminal chain in the account command. */
export declare function verifySubjectErasureSourceProof(tx: CommandTransaction, barrier: HistoryBarrier, proof: SubjectErasureSourceProof): Promise<boolean>;
/** Receipts are native row locators. No object identity or caller brand participates in verification.
 * Accept custody in Search's existing account-home command before requesting the next page.
 */
export declare function verifySubjectErasureSourcePage(tx: CommandTransaction, barrier: HistoryBarrier, receipt: SubjectErasurePageReceipt): Promise<boolean>;
export declare const createSubjectErasureSource: SubjectErasureSourceFactory;
