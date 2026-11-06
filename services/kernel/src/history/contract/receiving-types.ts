import type { HistoryHandle, HistoryPool } from './transaction.ts';
import type { HistoryReceivingDiscriminant, ZoneHistoryEventType } from './contracts.ts';

declare const ownerCoverage: unique symbol;

declare const receivingReceipt: unique symbol;

export type HistoryReceivingDependencies = Readonly<{
  pool: HistoryPool;
  clock?: () => Date;
}>;

export type HistoryReceivingContext = Readonly<{
  deadline: number;
  discriminant?: HistoryReceivingDiscriminant;
  identityConsumerWork?: HistoryHandle;
  accountErasureSearchObservation?: HistoryHandle;
  recoveryReceivingReserved?: boolean;
}>;

export type HistoryOwnerCoverage = { readonly [ownerCoverage]: true };

export type HistoryReceivingReceipt = { readonly [receivingReceipt]: true };

export type HistoryOwnerCoverageResult =
  | Readonly<{ state: 'pending'; gaps: readonly string[] }>
  | Readonly<{ state: 'complete'; coverage: HistoryOwnerCoverage }>;

export type ZoneHistoryConsumerObservation =
  | Readonly<{ state: 'pending'; gap: string }>
  | Readonly<{
      state: 'closed';
      zoneId: string;
      sourceKey: string;
      sourceTransactionId: string;
      sourcePosition: string;
      eventType: ZoneHistoryEventType;
      eventPosition: string;
      eventSeq: number;
      consumer: 'semantic_erasure_locator';
      receivingHolds: 'released';
    }>;
