/** Consumer composition types, not native DTOs. */
export type MemberIdentity = {
  accountId: string;
  reference: string;
  /** The current producer supplies a safe label, including its private-presentation fallback. */
  label: string;
};

export type MemberRow =
  | { kind: 'concealed' }
  | {
      kind: 'disclosed';
      identity: MemberIdentity;
      /** Opaque producer-owned proof for this exact current membership interval. */
      membershipInterval: string;
      membership: 'current' | 'pending';
    };

export type MemberPage = {
  realm: { id: string; label: string };
  /** Changes in disclosure or management authority invalidate the entire observation. */
  authority: string;
  rows: readonly MemberRow[];
  next: string | null;
};

export type MemberPageRead =
  | { kind: 'ready'; page: MemberPage }
  | { kind: 'denied' | 'unavailable' | 'failed' | 'preparing' };

export type MemberSelectionRead =
  | {
      kind: 'ready';
      realmId: string;
      authority: string;
      identity: MemberIdentity;
      /** Opaque selected Account interval proof, or null when no current interval can be asserted. */
      membershipInterval: string | null;
      /** Exact producer episode for the selected observation, including absence. */
      membershipEpisode: string;
      membership: 'current' | 'pending' | 'none' | 'unknown';
      /** Consumer composition advice; this is not a proposed native response shape. */
      advice: {
        add: 'available' | 'unavailable' | 'unknown';
        ban: 'available' | 'unavailable' | 'unknown';
        unban: 'available' | 'unavailable' | 'unknown';
      };
    }
  | { kind: 'concealed' | 'denied' | 'unavailable' | 'failed' | 'changed' };

export type MemberAddress = { realmId: string; cursor: string | null };
export type MemberSelectionAddress = {
  realmId: string;
  accountId: string;
  /** Present only when selection began from a disclosed roster row. */
  membershipInterval?: string;
  authority: string;
};

export type MemberAdditionIntent = Readonly<{
  realmId: string;
  accountId: string;
  membershipInterval: string | null;
  membershipEpisode: string;
  authority: string;
  idempotencyKey: string;
}>;

export type MemberAdditionResult = { kind: 'accepted'; workflowId: string } | { kind: 'rejected' | 'unknown' };

export interface RealmMembersSource {
  /**
   * Optional producer-owned lifetime for one connected visit. Capture before any read.
   * A disclosure, account, Realm or interval change permanently invalidates this observation,
   * even if the source later returns to the same values. Notifications perform no reads.
   * This is a composition seam, not a wire revision or a substitute for a native interval.
   */
  readonly observe?: () => {
    current: () => boolean;
    subscribe: (listener: () => void) => () => void;
  };
  /** Set only from the installed producer's admitted caps, never from UI fixture size. */
  readonly pageBound: number;
  readonly readPage: (address: MemberAddress) => Promise<MemberPageRead>;
  readonly readSelected: (address: MemberSelectionAddress) => Promise<MemberSelectionRead>;
  /** Installed only after the membership command owner and exact selected readback are available. */
  readonly addMember?: (intent: MemberAdditionIntent) => Promise<MemberAdditionResult>;
}

/** Explicitly unavailable fixture for compositions that have not installed the native source. */
export const boundedRealmMemberPage: RealmMembersSource = Object.freeze({
  pageBound: 0,
  readPage: async () => ({ kind: 'unavailable' as const }),
  readSelected: async () => ({ kind: 'unavailable' as const }),
});
