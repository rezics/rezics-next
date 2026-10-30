import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import type { IdentityJobRef, IdentityNativeReceipt, IdentityReceipt } from './identity-epoch-contract.ts';

export type IdentitySourceConsumerReference = Readonly<{
  receipt: Exclude<IdentityReceipt, { kind: 'subject.merge' }>;
  job: IdentityJobRef;
  source: IdentityNativeReceipt;
  sourceDigest: string;
  barrier: HistoryBarrier;
  /** subject is the original source key's account, distinct from requester/decider. */
  erasedRole: 'subject' | 'requester' | 'decider';
}>;
declare const identitySourceConsumerCustody: unique symbol;
export type IdentitySourceConsumerCustody = Readonly<{
  [identitySourceConsumerCustody]: true;
}>;

/** Provisional declaration: unavailable until durable native terminal custody is established. */
export async function readIdentitySourceConsumerCustody(
  _pool: Pool,
  _reference: IdentitySourceConsumerReference,
  _context: Readonly<{ deadline: number }>,
): Promise<IdentitySourceConsumerCustody | null> {
  return null;
}

/** A declaration alone never permits source minimization. */
export async function verifyIdentitySourceConsumerCustody(
  _tx: CommandTransaction,
  _reference: IdentitySourceConsumerReference,
  _proof: IdentitySourceConsumerCustody,
): Promise<boolean> {
  return false;
}
