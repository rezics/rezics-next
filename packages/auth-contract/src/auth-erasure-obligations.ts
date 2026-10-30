/** Original Access tombstone and its native tombstone receipt floor. T is not a floor. */
export type AuthErasureObligation = Readonly<{
  route: number;
  accountId: string;
  version: number;
  at: string;
  minimumAuthnEpoch: string;
  receiptId: string;
  ordinal: string;
}>;

/** Source coverage versions are independent of the account erasure version. */
export type AuthErasureObligationCut = Readonly<{
  cutId: string;
  participant: 'auth';
  inventoryVersion: 1;
  producerVersion: 1;
  partitions: 4096;
  sealedPartitions: number;
}>;
export type AuthErasureObligationCursor = Readonly<{ partition: number; afterOrdinal: string }>;
export type AuthErasureObligationPoint =
  | Readonly<{ state: 'ready'; obligation: AuthErasureObligation }>
  | Readonly<{
      state: 'pending';
      route: number;
      accountId: string;
      version: number;
      at: string;
      reason: 'original-floor-unavailable' | 'source-unavailable';
    }>
  | Readonly<{ state: 'absent' }>;
export type AuthErasureObligationPage = Readonly<{
  cut: AuthErasureObligationCut;
  cursor: AuthErasureObligationCursor;
  obligations: readonly AuthErasureObligation[];
  pending: readonly Exclude<AuthErasureObligationPoint, { state: 'ready' } | { state: 'absent' }>[];
  next: AuthErasureObligationCursor | null;
  state: 'initializing' | 'pending' | 'page' | 'partition-end';
  reason?: 'source-unavailable' | 'original-floor-unavailable';
}>;
export type AuthErasureObligationVerification = Readonly<{
  cutId: string;
  partition: number;
  state: 'current' | 'pending';
  sourceGeneration: string | null;
  sourceEpoch: number | null;
  sourceOwner: string | null;
  highWater: string | null;
  liveHighWater: string | null;
}>;
/** Fixed trusted Auth capability; all deadlines are absolute Unix milliseconds.
 * A cut locator or an empty page proves neither consumption nor external/backup closure.
 */
export type AuthErasureObligationPorts = {
  readAuthErasureObligation(input: { accountId: string; deadline: number }): Promise<AuthErasureObligationPoint>;
  startAuthErasureObligationCut(input: { cutId: string; deadline: number }): Promise<AuthErasureObligationCut>;
  pageAuthErasureObligations(input: {
    cutId: string;
    cursor: AuthErasureObligationCursor;
    deadline: number;
  }): Promise<AuthErasureObligationPage>;
  verifyAuthErasureObligationCut(input: {
    cutId: string;
    partition: number;
    deadline: number;
  }): Promise<AuthErasureObligationVerification>;
};
