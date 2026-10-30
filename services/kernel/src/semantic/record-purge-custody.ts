import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { RecordPurgeAuthority, RecordPurgeSource, NativeRecordPurgeReference } from './record-purge-authority.ts';

export type RecordPurgeCustodyDependencies = Readonly<{ pool: Pool; clock?: () => Date }>;
export type RecordPurgeCustodyContext = Readonly<{ deadline: number }>;
export type RecordPurgeReceivingTarget = Readonly<{ partition: number; receivingId: string }>;
declare const recordReceivingHold: unique symbol;
declare const recordInventoryCut: unique symbol;
export type RecordPurgeReceivingHold = Readonly<{ [recordReceivingHold]: true }>;
export type RecordPurgeInventoryCut = Readonly<{ [recordInventoryCut]: true }>;

export declare function prepareRecordPurgeReceivingHold(
  deps: RecordPurgeCustodyDependencies, authority: RecordPurgeAuthority,
  target: RecordPurgeReceivingTarget, context: RecordPurgeCustodyContext,
): Promise<RecordPurgeReceivingHold | null>;
export declare function readRecordPurgeReceivingHold(
  deps: RecordPurgeCustodyDependencies, reference: NativeRecordPurgeReference,
  target: RecordPurgeReceivingTarget, context: RecordPurgeCustodyContext,
): Promise<RecordPurgeReceivingHold | null>;
export declare function lockRecordPurgeReceivingHold(
  tx: CommandTransaction, hold: RecordPurgeReceivingHold,
): Promise<RecordPurgeSource | null>;
export declare function recordRecordPurgeReceivingCompletion(
  tx: CommandTransaction, hold: RecordPurgeReceivingHold,
): void;
export declare function releaseRecordPurgeReceivingHold(
  deps: RecordPurgeCustodyDependencies, reference: NativeRecordPurgeReference,
  target: RecordPurgeReceivingTarget, context: RecordPurgeCustodyContext,
): Promise<Readonly<{ state: 'pending' | 'released' }>>;
export declare function sealRecordPurgeSourceInventory(
  deps: RecordPurgeCustodyDependencies, authority: RecordPurgeAuthority, context: RecordPurgeCustodyContext,
): Promise<Readonly<{ state: 'pending'; frontier: string | null; examined: number }> |
  Readonly<{ state: 'sealed'; cut: RecordPurgeInventoryCut; examined: number }>>;
export declare function verifyRecordPurgeSourceInventory(
  tx: CommandTransaction, authority: RecordPurgeAuthority, cut: RecordPurgeInventoryCut,
): Promise<boolean>;
