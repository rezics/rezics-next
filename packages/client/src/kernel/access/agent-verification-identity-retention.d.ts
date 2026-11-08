import type { WorkContext } from '../work/registry.ts';
import type { Pool } from 'pg';
import { agentIdentityCopyRetention } from './shared-history-agent-identity.ts';
import { type CommandTransaction } from '../command/command.ts';
import type { IdentityNativeReceipt, IdentityReceipt } from '../semantic/identity-epoch-contract.ts';
import type { IdentitySourceConsumerReference } from '../semantic/identity-source-consumer-custody.ts';
import { type AccountIdentitySource } from './agent-verification-identity.ts';
import { type AgentIdentitySourceKey, type HistoryBarrier } from '../history/contract/index.ts';
type AccountReceipt = Exclude<IdentityReceipt, {
    kind: 'subject.merge';
}>;
/** Native-only receiver lookup. It does not recurse through the personal source and cannot
 * mint the ordinary source admission capability. The accepted reader owns the claim lock.
 */
export declare function readAccountIdentityTechnicalSource(tx: CommandTransaction, receipt: AccountReceipt): Promise<AccountIdentitySource | null>;
export declare function acceptTechnicalSource(tx: CommandTransaction, reference: IdentitySourceConsumerReference): Promise<IdentityNativeReceipt | null>;
export declare function verifyTechnicalSource(tx: CommandTransaction, reference: IdentitySourceConsumerReference, native: IdentityNativeReceipt): Promise<boolean>;
export type AgentIdentitySourceRole = 'account_id' | 'requested_by' | 'decided_by';
export declare function MAX_AGENT_IDENTITY_RETENTION_KEYS(): number;
/** A pending consumer branch, never a declaration that the installed owner is a stub.
 * Only the original Source read and same-command verifier can settle this dependency.
 */
export type AgentIdentityConsumerCustodyPending = Readonly<{
    state: 'pending';
    dependency: 'semantic.identity-epoch.account-source-terminal-custody';
}>;
export declare const agentIdentityConsumerCustody: AgentIdentityConsumerCustodyPending;
export type AgentIdentityRetentionPending = Readonly<{
    state: 'pending';
    key: AgentIdentitySourceKey;
    gap: 'native-erasure-root-unavailable' | 'native-source-missing' | 'native-source-role-unavailable' | 'native-source-owner-unavailable' | 'native-erasure-source-home-root-custody-unavailable' | 'native-source-job-unavailable' | 'native-source-copies-pending' | 'native-source-recovery-copies-unavailable' | 'identity-history-native-funding-unavailable' | 'identity-history-current-unit-unavailable' | AgentIdentityConsumerCustodyPending['dependency'];
    copies: ReturnType<typeof agentIdentityCopyRetention>;
    receiving?: 'unavailable' | 'verified';
}>;
export type AgentIdentityRetentionResult = AgentIdentityRetentionPending | Readonly<{
    state: 'minimized';
    key: AgentIdentitySourceKey;
    gap: null;
    copies: ReturnType<typeof agentIdentityCopyRetention>;
    receiving: 'verified';
}>;
export type AgentIdentityRetentionDependencies = Pick<WorkContext, 'client' | 'env' | 'clock'>;
export type AgentIdentityRetentionInput = Readonly<{
    barrier: HistoryBarrier;
    role: AgentIdentitySourceRole;
    keys: readonly AgentIdentitySourceKey[];
}>;
/** Native preparation/validator only. It deliberately cannot mint foreign consumer or copy custody.
 * No discovery EOF, missing row, caller flag or current Actor can release the original source.
 * At most eight exact native keys; no history, JSON or role-prefix scan and no second coordinator.
 */
export declare function prepareAgentIdentityRetention(tx: CommandTransaction, input: AgentIdentityRetentionInput): Promise<readonly AgentIdentityRetentionResult[]>;
export declare function AGENT_IDENTITY_RECOVERY_RETENTION_CHECK_COST(): Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: number;
}>;
export declare function AGENT_IDENTITY_ROLE_TRANSITION_COST(): Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: number;
}>;
export declare function AGENT_IDENTITY_ROLE_TRANSITION_RECOVERY_COST(): Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: number;
}>;
/** Bounded native role minimizer. Foreign probes release before the final home
 * command. The original Source frame remains live through the guarded COMMIT. */
export declare function minimizeAgentIdentityRetention(pool: Pool, input: AgentIdentityRetentionInput, deps?: AgentIdentityRetentionDependencies): Promise<readonly AgentIdentityRetentionResult[]>;
export {};
