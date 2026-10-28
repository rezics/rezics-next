import { useQuery } from '@tanstack/react-query';
import { readUnreadCount } from './inbox-read';
import { personalRead, readQueryKey } from '../kernel/query';
import { useSession } from '../session/query';
import { m } from '../paraglide/messages.js';

export function unreadBadgeLabel(count: { count: number; capped: boolean }): string | null {
  if (count.count <= 0 && !count.capped) return null;
  return count.capped || count.count > 99 ? '99+' : String(count.count);
}

export function UnreadBadge() {
  const { state } = useSession();
  const { data } = useQuery({
    queryKey: readQueryKey(['notifications', 'count'], 'session'),
    queryFn: () => readUnreadCount(),
    ...personalRead,
    staleTime: 60_000,
    enabled: personalRead.enabled && state === 'signed-in',
  });
  const label = data?.signedIn ? unreadBadgeLabel(data) : null;
  return label ? (
    <span
      aria-label={m.inbox_unread_count({ count: label })}
      className="ms-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold leading-none text-primary-foreground"
    >
      {label}
    </span>
  ) : null;
}
