import { createContext } from 'react';

/** Narrow bridge for the existing Realm ban Panel; it carries one current selected identity only. */
export type SelectedRealmMember = Readonly<{
  realmId: string;
  realmLabel: string;
  accountId: string;
  reference: string;
  label: string;
  membershipInterval: string | null;
  authority: string;
  advice: { ban: 'available' | 'unavailable' | 'unknown'; unban: 'available' | 'unavailable' | 'unknown' };
  current: () => boolean;
  subscribe: (listener: () => void) => () => void;
}>;

export const SelectedRealmMemberContext = createContext<SelectedRealmMember | null>(null);
