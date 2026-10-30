import { useQuery } from '@tanstack/react-query';
import { unreadCountQuery } from './inbox-query';
import { personalRead } from '../kernel/query';
import type { UnreadCount } from './inbox-read';
import { useSession } from '../session/query';
import { m } from '../paraglide/messages.js';

export function unreadBadgeLabel(count: { count: number; capped: boolean }): string | null {
  if (count.count <= 0 && !count.capped) return null;
  return count.capped || count.count > 99 ? '99+' : String(count.count);
}

export function UnreadBadgeView({ data, failed = false }: { data?: UnreadCount | undefined; failed?: boolean }) {
  const unavailable = failed || (data?.signedIn && data.state === 'unavailable');
  const label = unavailable ? '?' : data?.signedIn && data.state === 'ready' ? unreadBadgeLabel(data) : null;
  return label ? (
    <span
      aria-label={unavailable ? m.inbox_unread_unavailable() : m.inbox_unread_count({ count: label })}
      title={unavailable ? m.inbox_unread_unavailable() : undefined}
      className="ms-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold leading-none text-primary-foreground"
    >
      {label}
    </span>
  ) : null;
}

export function UnreadBadge() {
  const { state } = useSession();
  const query = useQuery({ ...unreadCountQuery, enabled: personalRead.enabled && state === 'signed-in' });
  return state === 'signed-in' ? <UnreadBadgeView data={query.data} failed={query.isError} /> : null;
}
