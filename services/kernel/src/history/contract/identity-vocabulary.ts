import { routeOf } from '../../route/contract.ts';
import { ACCOUNT_ROLE_BITS } from './contracts.ts';
import type { AccountReference } from './locator.ts';
import { encodeLocator } from './locator.ts';
import type { AgentIdentityReceipt } from './identity-types.ts';

/** Exact original Accounts key, independent of a deletion generation or Semantic job. */
export type AgentIdentitySourceKey = Readonly<{
  route: number;
  accountId: string;
  direction: 'account-agent.verify' | 'account-agent.unverify';
  receiptId: string;
}>;

export function agentIdentitySourceKey(key: AgentIdentitySourceKey): string {
  if (
    Object.keys(key).length !== 4 ||
    routeOf(key.accountId) !== key.route ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(key.accountId) ||
    !Number.isInteger(key.route) ||
    key.route < 0 ||
    key.route > 65535 ||
    !['account-agent.verify', 'account-agent.unverify'].includes(key.direction) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(key.receiptId)
  )
    throw new TypeError('Invalid original Agent identity source key');
  return JSON.stringify([key.route, key.accountId, key.direction, key.receiptId]);
}

export function agentIdentityAccounts(
  subject: string,
  requester: string,
  decider: string | null,
): readonly AccountReference[] {
  const union = new Map<string, number>();
  for (const [id, roles] of [
    [subject, ACCOUNT_ROLE_BITS.subject],
    [requester, ACCOUNT_ROLE_BITS.actor | ACCOUNT_ROLE_BITS.principal],
    ...(decider ? [[decider, ACCOUNT_ROLE_BITS.reviewer | ACCOUNT_ROLE_BITS.principal] as const] : []),
  ] as const) {
    if (routeOf(id) === null) throw new TypeError('Identity custody requires native account roles');
    union.set(id, (union.get(id) ?? 0) | roles);
  }
  return [...union]
    .map(([accountId, roles]) => ({ accountRoute: routeOf(accountId)!, accountId, roles }))
    .sort((a, b) => a.accountRoute - b.accountRoute || a.accountId.localeCompare(b.accountId));
}

export function agentIdentityWorkLocator(custodyId: string): Buffer {
  return Buffer.from(encodeLocator({ artifactType: 'durable-work/v1', workId: custodyId }));
}

export const agentIdentityWorkSourceKey = (receipt: AgentIdentityReceipt): string =>
  JSON.stringify([receipt.kind, receipt.account, receipt.receipt]);
