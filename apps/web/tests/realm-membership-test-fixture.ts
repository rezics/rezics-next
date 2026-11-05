import type { RealmJoinAdvice } from '../src/community/native-operations';
import type { RealmViewer } from '../src/community/realm-membership-queries';

export const realmMembershipTestReaders: {
  readMembership(realmId: string): Promise<RealmViewer | null>;
  readJoinAdvice(realmId: string): Promise<RealmJoinAdvice>;
} = {
  readMembership: async () => null,
  readJoinAdvice: async () => ({ state: 'current', allowed: true }),
};
