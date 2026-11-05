import { type FilterDocument } from '@rezics/filter';
import type { Pool, PoolClient } from 'pg';
import { type AuthoritativeTime, type CommandAttempt, type CommandTransaction } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { type Access, type AccessCheck, type AccountActor } from '../request/access.ts';
import type { CollectionDraft } from './collection-model.ts';
import type { PreparationDefinition } from './members-preparation.ts';
/** Uses the actual common preparation order declaration; no caller-local sort language. */
export type CollectionRule = Readonly<{
    filter: FilterDocument;
    sort: Extract<PreparationDefinition['sort'], 'id'>;
}>;
export type AdmittedCollectionRule = CollectionRule & Readonly<{
    releaseDigest: string;
}>;
export type SavedCollectionRule = AdmittedCollectionRule & Readonly<{
    revision: number;
    collectionRevision: number;
    sourceGeneration: string;
}>;
type Client = Pick<PoolClient, 'query'>;
/** Shared parser owns every predicate node, including nested and saved-filter operands. */
export declare function parseCollectionRule(input: unknown): CollectionRule;
/** All expanded leaves count, including negative and nonmatching branches. No fact IO or grant inference. */
export declare function collectionRuleActions(filter: FilterDocument): readonly string[];
/** Meaning admission is independent of native execution admission and never certifies completeness. */
export declare function admitCollectionRule(pool: Pool, rule: CollectionRule): Promise<AdmittedCollectionRule>;
export type PreparedCollectionRuleWrite = Readonly<{
    rule: AdmittedCollectionRule | null;
    failure: ProblemError | null;
    checks: readonly AccessCheck[];
}>;
/** An exact retry needs current authority, but need not admit a new meaning or perform another CAS. */
export declare function prepareCollectionRuleWrite(config: {
    pool: Pool;
    access: Access;
}, actor: AccountActor, rule: CollectionRule, attempt: CommandAttempt, deadline: number): Promise<PreparedCollectionRuleWrite>;
/** Prepare the actual private-family checks before the owning transaction takes its connection. */
export declare function prepareCollectionRuleAuthority(config: {
    pool: Pool;
    access: Access;
}, actor: AccountActor, filter: FilterDocument, attempt: CommandAttempt | {
    time: AuthoritativeTime;
    read: true;
}, deadline: number): Promise<readonly AccessCheck[]>;
/** Reevaluate at native current T BEFORE the executor may disclose an old receipt. */
export declare function authorizeCollectionRule(tx: CommandTransaction, attempt: Pick<CommandAttempt, 'time'>, checks: readonly AccessCheck[]): Promise<void>;
/**
 * Private point read for the common Source/editor owner. The caller supplies current native Collection/editor
 * AND private-family authority; this DAO grants none. No public Collection projection selects these columns.
 */
export declare function readSavedCollectionRule(client: Client, route: number, collectionId: string): Promise<SavedCollectionRule | null>;
/** Single-partition insert used by the existing Collection creator, before its ordinary grants/finalization. */
export declare function insertSavedCollection(tx: CommandTransaction, route: number, draft: CollectionDraft, rule: AdmittedCollectionRule, command: {
    transactionId: string;
    time: string;
}): Promise<void>;
/** One header CAS advances the rule's own revision and Source generation exactly once. */
export declare function updateSavedCollectionRule(tx: CommandTransaction, route: number, collectionId: string, revision: number, rule: AdmittedCollectionRule, command: {
    transactionId: string;
    time: string;
}): Promise<void>;
export {};
