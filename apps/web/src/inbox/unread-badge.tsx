import { useQuery } from '@tanstack/react-query';
import { unreadCountQueryFor } from './inbox-query';
import type { UnreadCount } from './inbox-read';
import { useInboxViewer } from './inbox-viewer';
import { m } from '../paraglide/messages.js';

export function unreadBadgeLabel(
  count: { count: number; capped: boolean; basis?: 'current-visible-unread' | 'current-visible-lower-bound' },
): string | null {
  const lowerBound = count.basis === 'current-visible-lower-bound' || count.capped;
  if (count.count <= 0 && !count.capped && !lowerBound) return null;
  if (count.count >= 100) return '99+';
  return lowerBound ? `≥${count.count}` : String(count.count);
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

export function useInboxUnreadCount() {
  const { viewer } = useInboxViewer();
  const query = useQuery(unreadCountQueryFor(viewer));
  const current = viewer?.isCurrent() ? viewer : null;
  return { ...query, data: current ? query.data : undefined, viewer: current };
}

export function UnreadBadge() {
  const { viewer, data, isError } = useInboxUnreadCount();
  return viewer ? <UnreadBadgeView data={data} failed={isError} /> : null;
}
