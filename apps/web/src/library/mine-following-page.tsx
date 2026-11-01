import { Exposure, useOperation } from '../kernel/exposure';
import { ContentItem } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from '@rezics/ui/shadcn/empty';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { displayLibraryTitle } from './title';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import type { MineFollowingPage } from './mine-following';
import { FollowTargetControl } from './follow-target-control';
import { personalRead } from '../kernel/query';
import {
  assertHistoryCurrent,
  useHistoryAddress,
  useHistoryCurrentOrigin,
  type HistoryOrigin,
} from './history-current-origin';
import { readMineFollowingForViewer, type MineFollowingRead } from './mine-following-actions';

const retiredPage: MineFollowingPage = { signedIn: false, follows: [], next: null };

const followingOperations = ['follow.list'] as const;

export const mineFollowingQuery = (
  subject: string,
  cursor: string | null,
  locale: string,
  origin?: HistoryOrigin & { key: string },
) =>
  queryOptions({
    ...personalRead,
    queryKey: ['mine-following', subject, 'follow.list', true, cursor, locale, ...(origin ? [origin.key] : [])],
    queryFn: async ({ signal }) => {
      const current = origin?.isCurrent ?? (() => true);
      assertHistoryCurrent(current, signal);
      try {
        const result = await readMineFollowingForViewer({ data: { cursor: cursor ?? undefined } });
        assertHistoryCurrent(current, signal);
        return result;
      } catch (error) {
        assertHistoryCurrent(current, signal);
        throw error;
      }
    },
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

function matches(read: MineFollowingRead, subject: string, cursor: string | null, locale: string): boolean {
  return read.page.signedIn && read.subject === subject && read.cursor === cursor && read.locale === locale;
}

/** Retained router data is a candidate, never authority for the browser's current viewer. */
export function CurrentViewerMineFollowingPage({
  initial,
  cursor,
}: {
  initial: MineFollowingRead;
  cursor?: string | undefined;
}) {
  useOperation('follow.list');
  const locale = getLocale();
  const address = useHistoryAddress('/library/following', cursor, locale);
  const origin = useHistoryCurrentOrigin(
    address.key,
    followingOperations,
    initial.page.signedIn ? initial.subject : null,
  );
  const current = () => address.isCurrent() && origin.current(0);
  const options = mineFollowingQuery(origin.subject ?? '', address.cursor, locale, {
    lifetime: origin.boundary.lifetime,
    key: origin.lifetime(0),
    isCurrent: current,
  });
  const read = useQuery(
    {
      ...options,
      enabled: personalRead.enabled && origin.hydrated && !!origin.subject && origin.allowed[0] && address.isCurrent(),
      ...(origin.seed && origin.subject && matches(initial, origin.subject, address.cursor, locale)
        ? { initialData: initial }
        : {}),
    },
    origin.client,
  );
  const previousLoader = useRef(initial);
  useEffect(() => {
    if (previousLoader.current === initial) return;
    previousLoader.current = initial;
    if (current()) void read.refetch();
  }, [initial, read.refetch, origin.lifetime(0)]);
  const page =
    !read.isError &&
    read.data &&
    origin.subject &&
    origin.current(0, false) &&
    address.isCurrent() &&
    matches(read.data, origin.subject, address.cursor, locale)
      ? read.data.page
      : retiredPage;
  const rowOrigin: HistoryOrigin = {
    lifetime: origin.boundary.lifetime,
    isCurrent: current,
  };
  const status =
    origin.subject && origin.allowed[0] && !page.signedIn
      ? read.isError || read.data
        ? 'unavailable'
        : 'preparing'
      : undefined;
  return (
    <MineFollowingPageView
      page={page}
      origin={rowOrigin}
      status={status}
      onRetry={
        status === 'unavailable'
          ? () => {
              if (current()) void read.refetch();
            }
          : undefined
      }
    />
  );
}

export function MineFollowingPageView({
  page,
  origin,
  status,
  onRetry,
}: {
  page: MineFollowingPage;
  origin?: HistoryOrigin;
  status?: 'unavailable' | 'preparing' | undefined;
  onRetry?: (() => void) | undefined;
}) {
  // A meaningful row/page replacement retires local removal callbacks during render. Equivalent
  // refetches (including freshly issued keys) preserve the native control's uncertain intent.
  const lifetime = JSON.stringify({
    ...page,
    follows: page.follows.map(({ idempotencyKey: _key, ...follow }) => follow),
  });
  const ref = useRef({ key: lifetime, parent: origin?.lifetime, active: true, mounted: false });
  if (ref.current.key !== lifetime || ref.current.parent !== origin?.lifetime) {
    ref.current.active = false;
    ref.current = { key: lifetime, parent: origin?.lifetime, active: true, mounted: false };
  }
  const row = ref.current;
  useLayoutEffect(() => {
    if (row.active) row.mounted = true;
    return () => {
      row.mounted = false;
    };
  }, [row]);
  const originating = {
    lifetime: row,
    isCurrent: () => row.active && row.mounted && (origin?.isCurrent() ?? true),
  };
  return <MineFollowingPageState key={lifetime} page={page} origin={originating} status={status} onRetry={onRetry} />;
}

function MineFollowingPageState({
  page,
  origin,
  status,
  onRetry,
}: {
  page: MineFollowingPage;
  origin: HistoryOrigin;
  status?: 'unavailable' | 'preparing' | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const canUnfollow = useOperation('follow.delete');
  const canReadCollection = useOperation('collection.get');
  const [follows, setFollows] = useState(page.follows);
  const [removed, setRemoved] = useState(false);

  const active = page.signedIn ? follows.filter((follow) => follow.state === 'following') : [];
  const groups = [
    { type: 'subject' as const, label: m.library_following_subjects() },
    { type: 'collection' as const, label: m.library_following_collections() },
    { type: 'space' as const, label: m.library_following_spaces() },
  ];

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header>
        <PageHeading>{m.library_following_heading()}</PageHeading>
      </header>
      {status ? (
        <div className="space-y-3">
          <p role="status">{status === 'preparing' ? m.library_follow_loading() : m.library_follow_unavailable()}</p>
          {onRetry ? (
            <Button variant="outline" onClick={onRetry}>
              {m.library_follow_retry()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {page.signedIn && removed ? <p role="status">{m.library_follow_removed()}</p> : null}
      {active.length ? (
        <div className="space-y-8">
          {groups.map(({ type, label }) => {
            const items = active.filter((follow) => follow.targetType === type);
            if (!items.length) return null;
            return (
              <section key={type} className="space-y-3" aria-labelledby={`following-${type}`}>
                <h2 id={`following-${type}`} className="text-xl font-semibold">
                  {label}
                </h2>
                <ul className="list-none space-y-1">
                  {items.map((follow) => {
                    const title = follow.target
                      ? displayLibraryTitle(follow.target.label, getLocale())
                      : { text: m.library_subject_unavailable(), lang: undefined };
                    const href =
                      follow.target && type === 'subject'
                        ? subjectHref({ id: follow.target.id, label: title.text }, getLocale()).href
                        : follow.target && type === 'collection' && canReadCollection
                          ? `/${getLocale()}/collections/${encodeURIComponent(follow.target.id)}`
                          : undefined;
                    const reason =
                      follow.reason === 'library'
                        ? m.library_follow_reason_library()
                        : follow.reason === 'membership'
                          ? m.library_follow_reason_membership()
                          : undefined;
                    return (
                      <ContentItem
                        key={`${type}:${follow.targetId}`}
                        className="px-4"
                        title={title.text}
                        {...(title.lang ? { titleLang: title.lang } : {})}
                        headingLevel={3}
                        {...(href ? { href } : {})}
                        metadata={
                          <div className="min-w-0 space-y-1">
                            <p>
                              {type === 'subject'
                                ? (follow.target?.typeLabel ?? label)
                                : type === 'collection'
                                  ? m.library_following_kind_collection()
                                  : m.library_following_kind_space()}
                            </p>
                            {reason ? <p>{reason}</p> : null}
                          </div>
                        }
                        actions={
                          canUnfollow ? (
                            <FollowTargetControl
                              origin={origin}
                              targetId={follow.targetId}
                              following
                              idempotencyKey={follow.idempotencyKey}
                              menuTitle={m.library_follow_more_actions({ title: title.text })}
                              onRemoved={() => {
                                if (!origin.isCurrent()) return;
                                setFollows((items) => items.filter((item) => item.targetId !== follow.targetId));
                                setRemoved(true);
                              }}
                            />
                          ) : null
                        }
                      />
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      ) : page.signedIn ? (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              {page.next ? m.library_following_page_empty() : m.library_following_empty()}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <a href={`/${getLocale()}/search`} className={buttonVariants({ variant: 'outline' })}>
              {m.search_heading()}
            </a>
          </EmptyContent>
        </Empty>
      ) : null}
      {page.signedIn && page.next ? (
        <Exposure operation="follow.list">
          <nav aria-label={m.library_following_heading()}>
            <Link
              to="/library/following"
              search={{ cursor: page.next }}
              onClick={(event) => {
                if (!origin.isCurrent()) event.preventDefault();
              }}
              className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
            >
              {m.library_collection_more()}
            </Link>
          </nav>
        </Exposure>
      ) : null}
    </article>
  );
}
