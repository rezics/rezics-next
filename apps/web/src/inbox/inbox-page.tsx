import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { ListRow, ListRowLink } from '@rezics/ui/list-row';
import { RelativeTime } from '@rezics/ui/relative-time';
import { Avatar, AvatarFallback } from '@rezics/ui/shadcn/avatar';
import { Flag, Gavel, MessageCircleReply } from 'lucide-react';
import { personalRead, readQueryKey } from '../kernel/query';
import { useSession } from '../session/query';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { initials } from '../threads/initials';
import { markInboxSeen, readInboxPage, type InboxPage, type ResolvedInboxPage } from './inbox-read';

function kindLabel(item: ResolvedInboxPage['items'][number]) {
  if (item.reportId || item.kind === 'moderation_decision') return m.inbox_kind_moderation();
  return item.kind === 'mention' ? m.inbox_kind_mention() : m.inbox_kind_reply();
}

const queryKey = readQueryKey(['notifications', 'inbox'], 'session');

export function InboxRows({
  page,
  onLoadMore,
  loading = false,
}: {
  page: ResolvedInboxPage;
  onLoadMore?: () => void;
  loading?: boolean;
}) {
  return (
    <>
      <ol aria-label={m.inbox_heading()} className="mt-6 space-y-1">
        {page.items.map((item) => (
          <ListRow
            key={item.id}
            data-notice-id={item.id}
            data-unread={item.unread}
            data-kind={item.reportId ? 'report_outcome' : item.kind}
            data-actor-id={item.actorId ?? undefined}
            className={`flex items-start gap-3 py-4 ${item.unread ? 'bg-muted/50' : ''}`}
          >
            {item.actorId ? (
              <Avatar aria-hidden="true" size="sm" className="mt-0.5 shrink-0">
                <AvatarFallback>{initials(item.actorId)}</AvatarFallback>
              </Avatar>
            ) : (
              <span
                data-icon-kind={item.reportId ? 'report_outcome' : item.kind}
                aria-hidden="true"
                className="mt-1 shrink-0 text-muted-foreground"
              >
                {item.reportId ? (
                  <Flag aria-hidden="true" size={18} />
                ) : item.kind === 'moderation_decision' ? (
                  <Gavel aria-hidden="true" size={18} />
                ) : (
                  <MessageCircleReply aria-hidden="true" size={18} />
                )}
              </span>
            )}
            <div className="min-w-0 flex-1">
              {item.unavailable ? (
                <p className="text-sm text-muted-foreground">{m.inbox_unavailable_item()}</p>
              ) : item.href ? (
                <>
                  <ListRowLink href={item.href}>{item.text}</ListRowLink>
                  <p aria-hidden="true" className="text-sm leading-6">
                    {item.text}
                  </p>
                </>
              ) : (
                <p className="text-sm leading-6">{item.text}</p>
              )}
              <span className="sr-only">{item.unread ? 'Unread notification' : 'Read notification'}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                <span data-notice-byline="true">
                  {item.actorName || (item.actorId ? m.inbox_actor_unknown() : m.inbox_actor_moderation())}
                  <span aria-hidden="true"> · </span>
                  {kindLabel(item)}
                </span>
                <span aria-hidden="true"> · </span>
                <RelativeTime value={item.createdAt} locale={getLocale()} timeZone="UTC" />
                <span className="sr-only">
                  {new Intl.DateTimeFormat(getLocale(), {
                    dateStyle: 'full',
                    timeStyle: 'long',
                    timeZone: 'UTC',
                  }).format(new Date(item.createdAt))}
                </span>
              </span>
            </div>
          </ListRow>
        ))}
      </ol>
      {page.next && onLoadMore ? (
        <Button variant="outline" className="mt-5" onClick={onLoadMore} disabled={loading}>
          {m.inbox_load_more()}
        </Button>
      ) : null}
    </>
  );
}

export function InboxPageView() {
  const { state } = useSession();
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | undefined>();
  const [older, setOlder] = useState<ResolvedInboxPage | null>(null);
  const marked = useRef<string | null>(null);
  const accumulatedCursor = useRef<string | undefined>(undefined);
  const pageQuery = useQuery({
    queryKey: [...queryKey, cursor ?? null],
    queryFn: () => readInboxPage({ data: cursor ? { cursor } : {} }) as Promise<InboxPage>,
    ...personalRead,
    enabled: personalRead.enabled && state === 'signed-in',
  });
  const page = pageQuery.data?.signedIn && pageQuery.data.state === 'ready' ? pageQuery.data : null;
  const operationState = pageQuery.data?.signedIn && pageQuery.data.state !== 'ready' ? pageQuery.data : null;
  const pageSignedOut = pageQuery.data !== undefined && !pageQuery.data.signedIn;

  useEffect(() => {
    if (!cursor || !page || accumulatedCursor.current === cursor) return;
    accumulatedCursor.current = cursor;
    setOlder((previous) => ({ items: [...(previous?.items ?? []), ...page.items], next: page.next }));
  }, [cursor, page]);

  useEffect(() => {
    if (cursor !== undefined) return;
    const newest = page?.items[0];
    if (!newest || marked.current === newest.id) return;
    marked.current = newest.id;
    void markInboxSeen({ data: { through: newest.id } }).then(() =>
      queryClient.invalidateQueries({ queryKey: readQueryKey(['notifications', 'count'], 'session') }),
    );
  }, [cursor, page?.items, queryClient]);

  const loadMore = () => {
    if (!page?.next) return;
    setOlder((previous) => previous ?? page);
    setCursor(page.next);
  };
  const items = older?.items ?? page?.items ?? [];
  const next = page?.next ?? null;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{m.inbox_heading()}</h1>
      {state !== 'signed-in' || pageSignedOut ? (
        <p className="mt-6 text-muted-foreground">{m.inbox_sign_in()}</p>
      ) : pageQuery.isPending ? (
        <p className="mt-6 text-muted-foreground">{m.inbox_loading()}</p>
      ) : pageQuery.isError || operationState ? (
        <section
          role="status"
          data-response-status={operationState?.failure.status ?? ''}
          data-response-code={operationState?.failure.code ?? ''}
          className="mt-6 rounded-lg border border-border p-5"
        >
          <p className="text-muted-foreground">
            {operationState?.state === 'closed'
              ? m.inbox_closed()
              : operationState?.state === 'preparing'
                ? m.inbox_preparing()
                : m.inbox_unavailable()}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => void pageQuery.refetch()}
            disabled={pageQuery.isFetching}
          >
            {m.inbox_retry()}
          </Button>
        </section>
      ) : items.length === 0 && !next ? (
        <p className="mt-6 text-muted-foreground">{m.inbox_empty()}</p>
      ) : (
        <InboxRows page={{ items, next }} {...(next ? { onLoadMore: loadMore } : {})} loading={pageQuery.isFetching} />
      )}
    </main>
  );
}
