import type { Pool } from 'pg';
import type { AccountIdentitySource } from '../access/agent-verification-identity.ts';
import { type CommandTransaction } from '../command/command.ts';
import { type AccountReference } from './locator.ts';
import type { HistoryArtifact, HistoryBarrier } from './registry.ts';
import { type HistoryReceivingContext, type HistoryReceivingDependencies } from './receiving.ts';
/** Exact original Accounts key, independent of a deletion generation or Semantic job. */
export type AgentIdentitySourceKey = Readonly<{
    route: number;
    accountId: string;
    direction: 'account-agent.verify' | 'account-agent.unverify';
    receiptId: string;
}>;
type Declaration = Readonly<{
    original: ReturnType<typeof import('../access/agent-verification-identity.ts').originalAccountIdentitySource>;
    accounts: readonly AccountReference[];
    kind: string;
}>;
export declare const MAX_AGENT_IDENTITY_SOURCE_KEYS = 8;
export declare function agentIdentitySourceKey(key: AgentIdentitySourceKey): string;
/** DATA ownership only. The original native writer must already have issued this exact binding
 * on this transaction. Neither a historical read nor a caller assertion supplies source authority. */
export declare function declareAgentIdentitySource(tx: CommandTransaction, key: AgentIdentitySourceKey, digest: string): Promise<void>;
export declare function commandAgentIdentitySource(tx: CommandTransaction): Declaration | undefined;
export declare function beginAgentIdentitySerialization(tx: CommandTransaction): void;
export declare function releaseAgentIdentitySource(tx: CommandTransaction): void;
/** Only real native serializers call this, after the fence assigned the persisted position.
 * The SQL independently checks the exact physical artifact's original command, never a whole-tx guess. */
export declare function recordAgentIdentityCopy(tx: CommandTransaction, artifact: HistoryArtifact, position: bigint): Promise<void>;
export type AgentIdentityCopyCursor = Readonly<{
    artifactType: 'command-receipt/v1' | 'outbox-event/v1';
    locator: Uint8Array;
}>;
export type AgentIdentityCopyPage = Readonly<{
    /** Sealed means a current native producer cut exists for every key, independently of this page. */
    state: 'pending' | 'sealed';
    gap: 'agent-identity-original-inventory-unsealed' | null;
    artifact: HistoryArtifact | null;
    cursor: AgentIdentityCopyCursor | null;
}>;
/** Eight exact source keys, at most eight indexed candidate rows and ONE actual artifact.
 * All keys share a native home; there is no owner scan, transaction-wide attachment or JSON reconstruction. */
export declare function readAgentIdentityCopies(pool: Pool, keys: readonly AgentIdentitySourceKey[], context: HistoryReceivingContext, after?: AgentIdentityCopyCursor): Promise<AgentIdentityCopyPage>;
/** Release the lookup home before invoking the existing exact receiving API. Its result still
 * does not seal the original source inventory or discharge the independent Source consumer. */
export declare function readAgentIdentityCopyReceiving(deps: HistoryReceivingDependencies, barrier: HistoryBarrier, keys: readonly AgentIdentitySourceKey[], context: HistoryReceivingContext, after?: AgentIdentityCopyCursor): Promise<{
    state: 'pending' | 'sealed';
    gap: 'agent-identity-original-inventory-unsealed' | null;
    artifact: HistoryArtifact | null;
    cursor: AgentIdentityCopyCursor | null;
    receipt: import("./receiving.ts").HistoryReceivingReceipt | null;
}>;
/** Unconverted associations keep their original retention gap. A native seal permits the
 * independent physical owner to minimize its payload; source and SDK metadata remain retained. */
export declare function agentIdentityCopyRetentionGap(tx: CommandTransaction, partition: number, type: HistoryArtifact['locator']['artifactType'], locator: Buffer): Promise<string | null>;
export type AgentIdentityReceipt = AccountIdentitySource['input']['receipt'];
/** Technical native metadata only; neither an accepted Semantic input nor a closure proof. */
export type AgentIdentityWorkSource = Readonly<{
    key: string;
    partition: number;
    epoch: number;
    position: string;
    transactionId: string;
    digest: string;
    release: string;
    workflowId: string;
    accounts: readonly AccountReference[];
}>;
export type AgentIdentitySourceHandoff = Readonly<{
    custodyId: string;
    source: AgentIdentityWorkSource;
    generation: string;
}>;
export declare function assertAgentIdentitySourceHandoff(handoff: AgentIdentitySourceHandoff): void;
export declare const agentIdentityWorkSourceKey: (receipt: AgentIdentityReceipt) => string;
export declare function agentIdentityAccounts(subject: string, requester: string, decider: string | null): readonly AccountReference[];
/** Called only after the genuine original Source INSERT, in that SAME account-home command.
 * An older SDK receiver keeps its creation transaction; this appends a separate source intent. */
export declare function recordAgentIdentityWorkSource(tx: CommandTransaction, receipt: AgentIdentityReceipt, initialCustodyId: string | null): Promise<void>;
/** Released immutable Source -> original command association. No receiver is checked out here.
 * Old/recovered sources without the original recording seam stay precisely unavailable. */
export declare function readAgentIdentitySourceHandoff(pool: Pool, receipt: AgentIdentityReceipt): Promise<AgentIdentitySourceHandoff | null>;
export type AgentIdentityReceivingLookup = Readonly<{
    state: 'pending';
    gap: string;
}> | Readonly<{
    state: 'associated';
    artifact: import('./registry.ts').HistoryArtifact;
}>;
/** At most eight exact original keys and one artifact in total. This is copy lookup, never inventory EOF. */
export declare function lookupAgentIdentityReceivingCopies(pool: Pool, receipts: readonly AgentIdentityReceipt[]): Promise<readonly AgentIdentityReceivingLookup[]>;
export declare function agentIdentityWorkLocator(custodyId: string): Buffer;
export {};
