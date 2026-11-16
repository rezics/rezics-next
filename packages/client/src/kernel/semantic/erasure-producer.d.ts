import { type CommandTransaction } from '../command/command.ts';
export { SEMANTIC_RECEIVING_ERASURE_STORES } from './account-erasure-stores.ts';
/** Explicit account input of a native platform producer, in the producer's own home/transaction.
 * No account registry or business payload is copied. Deferred source hooks attach exact record ordinals.
 */
export declare function recordSemanticProducerRole(tx: CommandTransaction, transactionId: string, accountId: string, role: 'subject' | 'operator'): Promise<void>;
export type SemanticCopyRole = {
    account_id: string;
    role: string;
};
export declare const bindSemanticProducerRolesSql = "INSERT INTO semantic.erasure_source_role(partition_no,transaction_id,account_id,role)\n      SELECT $1,$2,account_id,role FROM unnest($3::uuid[],$4::text[]) AS input(account_id,role) ON CONFLICT DO NOTHING";
/** Exact source/provenance join before opening the receiving home. */
export declare function semanticCopyRoles(pool: import('pg').Pool, subjectId: string, candidateId: string): Promise<SemanticCopyRole[]>;
export declare const identityErasureRolesSql = "SELECT l.account_id::text,l.role FROM semantic.identity_epoch_job j\n     JOIN semantic.erasure_locator l\n       ON l.partition_no=j.partition_no AND l.store='identity_epoch_job' AND l.record_key=j.erasure_key\n     WHERE j.partition_no=$1 AND j.job_id=$2 ORDER BY l.account_id,l.role LIMIT 9";
export declare const identityErasureRolePairSql = "SELECT l.account_id::text,l.role FROM semantic.identity_epoch_job j\n     JOIN semantic.erasure_locator l\n       ON l.partition_no=j.partition_no AND l.store='identity_epoch_job' AND l.record_key=j.erasure_key\n     WHERE j.partition_no=$1 AND j.job_id=$2 ORDER BY l.account_id,l.role LIMIT 2";
/** Bounded real job-home provenance, loaded before a receiving-home command is opened. */
export declare function identityErasureRoles(pool: import('pg').Pool, jobId: string, options?: Readonly<{
    preferSingleRole: boolean;
}>): Promise<SemanticCopyRole[]>;
/** Typed provenance travels with actual admission input and commits in the receiving source transaction. */
export declare function bindSemanticProducerRoles(tx: CommandTransaction, roles: readonly SemanticCopyRole[]): void;
/** Bind a Source receipt to this executor's real fence. A deferred native constraint
 * checks the same-transaction write basis after the executor appends its commit.
 */
export declare function recordSemanticSourceCommit(tx: CommandTransaction, transactionId: string): Promise<void>;
/** Recheck real payload and minimizer custody in the actual same-home command. Missing
 * payload is accepted only with its real native removal receipt, never by absence alone.
 */
export declare function readSemanticSourceDisposition(tx: CommandTransaction, store: string, key: string): Promise<'removed' | 'retained-nonpersonal' | null>;
/** Persist only after the owner's real minimizer has run in this same source command. */
export declare function recordSemanticSourceDisposition(tx: CommandTransaction, store: string, recordKey: string, disposition: 'removed' | 'retained-nonpersonal'): void;
