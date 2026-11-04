import { useQuery } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { unreadCountFetchBlocked, unreadCountQueryFor, unreadCountRetryAt } from './inbox-query';
import type { NativeInboxFailure, UnreadCount } from './inbox-read';
import { useInboxViewer } from './inbox-viewer';
import { m } from '../paraglide/messages.js';
import { usePreferenceRetry } from '../settings/preference-failure-retry';

export function unreadBadgeLabel(count: {
  count: number;
  capped: boolean;
  basis?: 'current-visible-unread' | 'current-visible-lower-bound';
}): string | null {
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

function unreadCountDenied(failure: NativeInboxFailure | undefined) {
  return (
    failure?.status === 401 ||
    failure?.status === 403 ||
    failure?.code === 'unauthorized' ||
    failure?.code === 'forbidden'
  );
}

function unreadSummaryCopy(
  data: UnreadCount | undefined,
  pending: boolean,
  failed: boolean,
): { status: string; retry: boolean; zero?: boolean } {
  if (pending && !data) return { status: m.inbox_unread_loading(), retry: false };
  if (data && !data.signedIn) return { status: m.inbox_unread_signed_out(), retry: false };
  if (failed || (data?.signedIn && data.state === 'unavailable')) {
    const failure = data?.signedIn && data.state === 'unavailable' ? data.failure : undefined;
    if (failure?.code === 'platform_closed') return { status: m.inbox_unread_closed(), retry: false };
    if (unreadCountDenied(failure)) return { status: m.inbox_unread_denied(), retry: true };
    return { status: m.inbox_unread_unavailable(), retry: true };
  }
  if (data?.signedIn && data.state === 'ready') {
    if (data.basis === 'current-visible-lower-bound' || data.capped)
      return { status: m.inbox_unread_lower_bound({ count: String(data.count) }), retry: false };
    if (data.count === 0) return { status: m.inbox_unread_none(), retry: false, zero: true };
    return { status: m.inbox_unread_count({ count: String(data.count) }), retry: false };
  }
  return { status: m.inbox_unread_loading(), retry: false };
}

export function InboxUnreadSummary() {
  const { viewer, data, isPending, isError, isFetching, refetch } = useInboxUnreadCount();
  const failure = data?.signedIn && data.state === 'unavailable' ? data.failure : undefined;
  usePreferenceRetry(failure, viewer ? unreadCountRetryAt(viewer) : 0);
  if (!viewer) return null;
  const blocked = unreadCountFetchBlocked(viewer);
  const copy = unreadSummaryCopy(data, isPending, isError);
  return (
    <section
      role="status"
      aria-label={m.inbox_unread_summary()}
      aria-busy={isFetching}
      className="mt-4 space-y-2"
    >
      <p className="text-sm text-muted-foreground">{copy.status}</p>
      {copy.zero ? <p className="text-sm text-muted-foreground">{m.inbox_unread_none_not_empty()}</p> : null}
      {blocked ? <p className="text-sm text-muted-foreground">{m.settings_retry_wait()}</p> : null}
      {copy.retry ? (
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 max-w-full whitespace-normal py-2"
          disabled={blocked || isFetching || !viewer.isCurrent()}
          onClick={() => {
            if (!viewer.isCurrent() || unreadCountFetchBlocked(viewer) || isFetching) return;
            void refetch({ cancelRefetch: false });
          }}
        >
          {m.inbox_unread_retry()}
        </Button>
      ) : null}
    </section>
  );
}
