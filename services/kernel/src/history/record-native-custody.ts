import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { RecordPurgeAuthority, RecordPurgeSource } from '../semantic/record-purge-authority.ts';
import type { NativeRecordPurgeReference } from './record-resource-adapter.ts';

// Provisional dependency adapter for the exact Source-owned declarations in the contract.
// There is deliberately no issuer, durable Source state, fallback lock or completion here.
declare const recordReceivingHold: unique symbol;
declare const recordInventoryCut: unique symbol;
export type RecordPurgeReceivingHold = Readonly<{ [recordReceivingHold]: true }>;
export type RecordPurgeInventoryCut = Readonly<{ [recordInventoryCut]: true }>;
type Dependencies = Readonly<{ pool: Pool; clock?: () => Date }>;
type Context = Readonly<{ deadline: number }>;
export type RecordPurgeReceivingTarget = Readonly<{ partition: number; receivingId: string }>;
export type RecordPurgeNativeCustody = Readonly<{
  prepareRecordPurgeReceivingHold(
    deps: Dependencies,
    authority: RecordPurgeAuthority,
    target: RecordPurgeReceivingTarget,
    context: Context,
  ): Promise<RecordPurgeReceivingHold | null>;
  readRecordPurgeReceivingHold(
    deps: Dependencies,
    reference: NativeRecordPurgeReference,
    target: RecordPurgeReceivingTarget,
    context: Context,
  ): Promise<RecordPurgeReceivingHold | null>;
  lockRecordPurgeReceivingHold(
    tx: CommandTransaction,
    hold: RecordPurgeReceivingHold,
  ): Promise<RecordPurgeSource | null>;
  recordRecordPurgeReceivingCompletion(tx: CommandTransaction, hold: RecordPurgeReceivingHold): void;
  releaseRecordPurgeReceivingHold(
    deps: Dependencies,
    reference: NativeRecordPurgeReference,
    target: RecordPurgeReceivingTarget,
    context: Context,
  ): Promise<Readonly<{ state: 'pending' | 'released' }>>;
  sealRecordPurgeSourceInventory(
    deps: Dependencies,
    authority: RecordPurgeAuthority,
    context: Context,
  ): Promise<
    | Readonly<{ state: 'pending'; frontier: string | null; examined: number }>
    | Readonly<{ state: 'sealed'; cut: RecordPurgeInventoryCut; examined: number }>
  >;
  verifyRecordPurgeSourceInventory(
    tx: CommandTransaction,
    authority: RecordPurgeAuthority,
    cut: RecordPurgeInventoryCut,
  ): Promise<boolean>;
}>;

/** Source's actual module is absent at this base. Never mint a hold/cut or treat that absence
 * as native effect, permission, released custody or a sealed source inventory. */
export async function nativeRecordPurgeCustody(): Promise<RecordPurgeNativeCustody | null> {
  const path = '../semantic/record-purge-custody.ts';
  if (!(await Bun.file(new URL(path, import.meta.url)).exists())) return null;
  // The native module owns every handle and all durable validation. Import failures propagate;
  // only the genuinely absent dependency is unavailable, never an alternate implementation.
  return (await import(path)) as RecordPurgeNativeCustody;
}
