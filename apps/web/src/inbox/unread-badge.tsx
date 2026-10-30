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
  if (!failed && data?.signedIn === false) return null;
  if (failed || !data?.signedIn || data.state !== 'ready')
    return (
      <span
        role="img"
        aria-label={m.inbox_unread_unavailable()}
        title={m.inbox_unread_unavailable()}
        className="ms-auto inline-block size-2 shrink-0 rounded-full bg-primary"
      />
    );
  const label = unreadBadgeLabel(data);
  return label ? (
    <span
      aria-label={m.inbox_unread_count({ count: label })}
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
