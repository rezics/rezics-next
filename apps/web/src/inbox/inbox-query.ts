import { queryOptions } from '@tanstack/react-query';
import { personalRead, readQueryKey } from '../kernel/query';
import { readUnreadCount } from './inbox-read';

export const unreadCountQuery = queryOptions({
  ...personalRead,
  queryKey: readQueryKey(['notifications', 'count'], 'session'),
  queryFn: () => readUnreadCount(),
  staleTime: 60_000,
  retry: false,
});
