/** Consumer composition types, not native DTOs. Publication must replace the unavailable adapter. */
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
      episode: string;
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
      episode: string;
      membership: 'current' | 'pending';
    }
  | { kind: 'concealed' | 'denied' | 'unavailable' | 'failed' | 'changed' };

export type MemberAddress = { realmId: string; cursor: string | null };
export type MemberSelectionAddress = {
  realmId: string;
  accountId: string;
  episode: string;
  authority: string;
};

export interface RealmMembersSource {
  /** Set only from the installed producer's admitted caps, never from UI fixture size. */
  readonly pageBound: number;
  readonly readPage: (address: MemberAddress) => Promise<MemberPageRead>;
  readonly readSelected: (address: MemberSelectionAddress) => Promise<MemberSelectionRead>;
}

/** No enumeration or selected-account API is installed on the retained base. No HTTP is invented here. */
export const boundedRealmMemberPage: RealmMembersSource = Object.freeze({
  pageBound: 0,
  readPage: async () => ({ kind: 'unavailable' as const }),
  readSelected: async () => ({ kind: 'unavailable' as const }),
});
