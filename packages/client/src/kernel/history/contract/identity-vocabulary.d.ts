import type { AccountReference } from './locator.ts';
import type { AgentIdentityReceipt } from './identity-types.ts';
/** Exact original Accounts key, independent of a deletion generation or Semantic job. */
export type AgentIdentitySourceKey = Readonly<{
    route: number;
    accountId: string;
    direction: 'account-agent.verify' | 'account-agent.unverify';
    receiptId: string;
}>;
export declare function agentIdentitySourceKey(key: AgentIdentitySourceKey): string;
export declare function agentIdentityAccounts(subject: string, requester: string, decider: string | null): readonly AccountReference[];
export declare function agentIdentityWorkLocator(custodyId: string): Buffer;
export declare const agentIdentityWorkSourceKey: (receipt: AgentIdentityReceipt) => string;
