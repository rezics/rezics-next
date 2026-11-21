import type { EconomyReceipt, EconomyResult } from '../contract.ts';

type CreatorAsset = Readonly<{ creatorId: string; assetId: string }>;
export type CreatorRail = Readonly<{
  namespace: string;
  mode: 'test' | 'live';
  destinationRef: string;
}>;

/** A trusted owner identifies an already-attributed, immutable accrual component. */
export type CreatorAccrual = CreatorAsset &
  Readonly<{
    units: string;
    source: Readonly<{ namespace: string; id: string }>;
    expenseReference: string;
  }>;

export type CreatorPayoutReservation = CreatorAsset &
  Readonly<{
    payoutId: string;
    units: string;
    provider: CreatorRail;
  }>;

/** A verified, independently named provider outcome. Uncertain transport results do not release payable. */
export type CreatorPayoutObservation = Readonly<{
  payoutId: string;
  provider: CreatorRail;
  assetId: string;
  units: string;
}> &
  (
    | Readonly<{ kind: 'paid'; movementId: string }>
    | Readonly<{ kind: 'refused'; evidenceId: string }>
    | Readonly<{ kind: 'returned'; movementId: string; originalMovementId: string }>
  );

export type CreatorPayable = Readonly<{ posted: string; reserved: string; available: string }>;
export type CreatorPayoutStatus = CreatorPayoutReservation &
  Readonly<{
    status: 'reserved' | 'paid' | 'released';
    paidMovementId: string | null;
    returnedUnits: string;
  }>;

/** Book owner interface. Admission and evidence authenticity are established before this boundary. */
export interface CreatorClearing {
  readPayable(input: CreatorAsset): Promise<EconomyResult<CreatorPayable>>;
  readPayout(payoutId: string): Promise<EconomyResult<CreatorPayoutStatus | null>>;
  accrue(input: CreatorAccrual): Promise<EconomyResult<EconomyReceipt>>;
  reservePayout(input: CreatorPayoutReservation): Promise<EconomyResult<EconomyReceipt>>;
  observePayout(input: CreatorPayoutObservation): Promise<EconomyResult<EconomyReceipt>>;
}
