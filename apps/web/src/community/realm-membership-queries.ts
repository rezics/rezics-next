import { queryOptions } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';

export const realmMembershipQuery = (realmId: string) =>
  queryOptions({
    ...personalRead,
    queryKey: ['realm-membership', realmId],
    queryFn: async () => {
      const { readRealmMembership } = await import('./realm-membership-actions');
      return readRealmMembership({ data: { realmId } });
    },
    retry: false,
  });
