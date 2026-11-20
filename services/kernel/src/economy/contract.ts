export function isEconomyBookId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value);
}

export type EconomyAsset = Readonly<{
  id: string;
  scale: number;
  transferable: boolean;
}>;

export type WalletBalance = Readonly<{
  asset: EconomyAsset;
  posted: string;
  held: string;
  restricted: string;
  available: string;
}>;

export type WalletEntry = Readonly<{
  position: string;
  operationId: string;
  kind: 'issue' | 'transfer' | 'reserve' | 'capture' | 'release' | 'expire';
  postedDelta: string;
  heldDelta: string;
  recordedAt: string;
}>;

export type WalletStatement = Readonly<{
  entries: readonly WalletEntry[];
  next: string | null;
}>;

export type EconomyFailure =
  | 'asset_missing'
  | 'operation_conflict'
  | 'insufficient_funds'
  | 'asset_not_transferable'
  | 'hold_missing'
  | 'hold_closed'
  | 'allocation_missing'
  | 'allocation_closed'
  | 'invalid_amount'
  | 'invalid_operation'
  | 'unavailable';

export type EconomyResult<T> = Readonly<{ kind: 'ok'; value: T }> | Readonly<{ kind: EconomyFailure }>;
export type EconomyReceipt = Readonly<{ operationId: string }>;

type WalletKey = Readonly<{ accountId: string; assetId: string }>;
type WalletCommand = WalletKey & Readonly<{ operationId: string }>;
type WalletHold = WalletCommand & Readonly<{ holdId: string }>;

export type HoldAllocationPurpose = 'spot_fill' | 'market_trade' | 'withdrawal';
export type HoldAllocationKey = WalletKey &
  Readonly<{ holdId: string; purpose: HoldAllocationPurpose; reference: string }>;
export type HoldAllocation = Readonly<{
  purpose: HoldAllocationPurpose;
  reference: string;
  amount: string;
  status: 'protected' | 'captured' | 'released';
  recipientId: string | null;
  allocatedAt: string;
  resolvedAt: string | null;
}>;
type AllocationCommand = HoldAllocationKey & Pick<WalletCommand, 'operationId'>;

export interface EconomyWalletPort {
  readBalance(input: WalletKey): Promise<EconomyResult<WalletBalance>>;
  readStatement(
    input: WalletKey & Readonly<{ before?: string; limit: number }>,
  ): Promise<EconomyResult<WalletStatement>>;
  transfer(
    input: WalletCommand & Readonly<{ recipientId: string; amount: string }>,
  ): Promise<EconomyResult<EconomyReceipt>>;
}

/** Trusted owner operations. HTTP entry points use EconomyWalletPort. */
export interface EconomyLedger extends EconomyWalletPort {
  provisionAsset(input: EconomyAsset): Promise<EconomyResult<EconomyAsset>>;
  issue(input: WalletCommand & Readonly<{ amount: string }>): Promise<EconomyResult<EconomyReceipt>>;
  reserve(input: WalletHold & Readonly<{ amount: string; expiresAt: string }>): Promise<EconomyResult<EconomyReceipt>>;
  capture(
    input: WalletHold & Readonly<{ recipientId: string; amount: string; final: boolean }>,
  ): Promise<EconomyResult<EconomyReceipt>>;
  release(input: WalletHold): Promise<EconomyResult<EconomyReceipt>>;
  expire(input: WalletHold): Promise<EconomyResult<EconomyReceipt>>;
  releaseAmount(input: WalletHold & Readonly<{ amount: string }>): Promise<EconomyResult<EconomyReceipt>>;
  allocate(input: AllocationCommand & Readonly<{ amount: string }>): Promise<EconomyResult<EconomyReceipt>>;
  readAllocation(input: HoldAllocationKey): Promise<EconomyResult<HoldAllocation>>;
  captureAllocation(
    input: AllocationCommand & Readonly<{ recipientId: string }>,
  ): Promise<EconomyResult<EconomyReceipt>>;
  releaseAllocation(input: AllocationCommand): Promise<EconomyResult<EconomyReceipt>>;
}
