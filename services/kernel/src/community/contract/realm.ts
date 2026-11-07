export type RealmContinuity = Readonly<{
  ownershipState: 'owned' | 'orphaned';
  orphanedAt: string | null;
  claimEligibleAt: string | null;
  governanceReadOnly: boolean;
}>;
