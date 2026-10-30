import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { IdentityEffect, IdentityJobRef, IdentityNativeReceipt, IdentityFrontier } from './identity-epoch-contract.ts';

export type IdentityReceivingEffect = Extract<IdentityEffect, { kind: 'receiving' }>;
export type IdentityReceivingDisposition = 'OLD' | 'NEW' | 'first-apply' | 'handoff';
/** Selects one Source-owned effect. None of these caller keys constitute proof. */
export type IdentityReceivingSelection = Readonly<{
  job: IdentityJobRef;
  original: string;
  effectKey: string;
  owner: string;
  sourceId: string;
  scope: string;
  disposition: IdentityReceivingDisposition;
}>;
/** Source-owned native provenance. Never accepted as an argument to the public preparation producer. */
export type IdentityReceivingSource = Readonly<{
  id: string;
  incarnation: string;
  generation: string;
  scope: string;
  owner: string;
  home: number;
  receivingHome: number;
  receivingEpoch: number;
  original: string;
  effectKey: string;
  disposition: IdentityReceivingDisposition;
  provenance: IdentityNativeReceipt;
}>;
/** Fixed version and participant; each scope/disposition has its own retained effect key. */
export type IdentityReceivingBinding = Readonly<{
  job: IdentityJobRef;
  original: string;
  effectKey: string;
  owner: string;
  step: 'library-private-follow-counts';
  version: 1;
  scopeDigest: string;
  source: IdentityReceivingSource;
}>;
export type IdentityReceivingRecord = IdentityReceivingBinding & Readonly<{
  plan: IdentityNativeReceipt;
  sourceHold: IdentityNativeReceipt;
  receipt: IdentityNativeReceipt;
}>;
export type IdentityReceivingProgress = Readonly<{
  frontier: IdentityFrontier;
}>;
/** The sole Source owner implements these exact operations in library/identity-receiving-source.ts.
 * Every pool operation releases all source homes before returning. Native receipts are verified by that
 * owner against its committed provenance, never minted from the supplied keys/JSON. A hold survives
 * source mutation/move until effect + control custody; it cannot be disposed by a lease or timeout.
 */
export type IdentityReceivingSourceProducer = Readonly<{
  readIdentityReceivingSource(pool: Pool, selection: IdentityReceivingSelection): Promise<IdentityReceivingSource | null>;
  holdIdentityReceivingSource(pool: Pool, binding: IdentityReceivingBinding): Promise<IdentityNativeReceipt>;
  /** Exact current owner/scope/disposition, source hold and first-apply fence, in the effect transaction.
   * Must retain the actual Source-owned hold in this transaction along with the native effect receipt.
   * Remote source provenance was held and released before this call; no foreign checkout or SQL here.
   */
  lockIdentityReceivingSource(tx: CommandTransaction, record: IdentityReceivingRecord): Promise<void>;
  /** Resolve actual control custody before releasing the exact held source obligation. No job-wide ACK. */
  acknowledgeIdentityReceivingSource(
    pool: Pool, record: IdentityReceivingRecord, custody: IdentityNativeReceipt,
  ): Promise<void>;
}>;
