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
  useHistoryReadOrigin,
  type HistoryOrigin,
} from './history-current-origin';
import { readMineFollowingForViewer, type MineFollowingRead } from './mine-following-actions';
import { PERSONAL_DIRECTORY_CURSOR_LIMITS, personalDirectoryAddress } from './personal-directory-address';
import type { FollowState } from './follow-records';

type ReviewFollow = (targetId: string) => Promise<FollowState | null>;

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
    staleTime: Infinity,
    refetchOnMount: true,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

function matches(read: MineFollowingRead, subject: string, cursor: string | null, locale: string): boolean {
  return (
    read.page.signedIn &&
    !read.page.addressInvalid &&
    read.subject === subject &&
    read.cursor === cursor &&
    read.locale === locale
  );
}

/** Retained router data is a candidate, never authority for the browser's current viewer. */
export function CurrentViewerMineFollowingPage({
  initial,
  cursor,
  invalidAddress = false,
}: {
  initial: MineFollowingRead;
  cursor?: string | undefined;
  invalidAddress?: boolean;
}) {
  useOperation('follow.list');
  const locale = getLocale();
  const requestedAddress = personalDirectoryAddress(cursor, PERSONAL_DIRECTORY_CURSOR_LIMITS.following);
  const addressInvalid = invalidAddress || !requestedAddress.valid;
  const address = useHistoryAddress('/library/following', requestedAddress.cursor ?? undefined, locale);
  const originAddress = addressInvalid ? `${address.key}:invalid` : address.key;
  const origin = useHistoryCurrentOrigin(
    originAddress,
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
      enabled:
        personalRead.enabled &&
        !addressInvalid &&
        origin.hydrated &&
        !!origin.subject &&
        origin.allowed[0] === true &&
        address.isCurrent(),
      ...(!addressInvalid && origin.seed && origin.subject && matches(initial, origin.subject, address.cursor, locale)
        ? { initialData: initial }
        : {}),
    },
    origin.client,
  );
  const readCurrent = useHistoryReadOrigin(
    origin.client,
    options.queryKey,
    (value) =>
      !!value && !!origin.subject && matches(value as MineFollowingRead, origin.subject, address.cursor, locale),
  );
  const previousLoader = useRef(initial);
  useEffect(() => {
    if (previousLoader.current === initial) return;
    previousLoader.current = initial;
    if (current()) void read.refetch();
  }, [initial, read.refetch, origin.lifetime(0)]);
  const page =
    !addressInvalid &&
    read.data &&
    origin.subject &&
    origin.retained[0] === true &&
    address.isCurrent() &&
    matches(read.data, origin.subject, address.cursor, locale)
      ? read.data.page
      : retiredPage;
  const rowOrigin: HistoryOrigin = {
    lifetime: origin.boundary.lifetime,
    isCurrent: () => current() && readCurrent(),
  };
  const retryState = origin.client.getQueryState(options.queryKey);
  const status =
    !addressInvalid && origin.subject && origin.allowed[0] === true && (read.isError || !page.signedIn)
      ? read.isError || read.data
        ? 'unavailable'
        : 'preparing'
      : undefined;
  return (
    <div hidden={origin.hydrated && !origin.allowed[0]}>
      <MineFollowingPageView
        page={page}
        cursor={address.cursor}
        invalidAddress={addressInvalid}
        origin={rowOrigin}
        status={status}
        onReview={async (targetId) => {
          if (addressInvalid || !current() || !readCurrent()) return null;
          const result = await read.refetch();
          if (
            !current() ||
            result.isError ||
            !result.data ||
            !origin.subject ||
            !matches(result.data, origin.subject, address.cursor, locale) ||
            origin.client.getQueryState(options.queryKey)?.status !== 'success' ||
            origin.client.getQueryData(options.queryKey) !== result.data
          )
            return null;
          // Absence on a bounded page is not proof that the owner has no edge.
          return result.data.page.follows.some((follow) => follow.targetId === targetId && follow.state === 'following')
            ? { state: 'ready', following: true }
            : null;
        }}
        onRetry={
          status === 'unavailable'
            ? () => {
                if (current() && origin.client.getQueryState(options.queryKey) === retryState) void read.refetch();
              }
            : undefined
        }
      />
    </div>
  );
}

export function MineFollowingPageView({
  page,
  cursor,
  invalidAddress = false,
  origin,
  status,
  onRetry,
  onReview,
}: {
  page: MineFollowingPage;
  cursor?: string | null | undefined;
  invalidAddress?: boolean;
  origin?: HistoryOrigin;
  status?: 'unavailable' | 'preparing' | undefined;
  onRetry?: (() => void) | undefined;
  onReview?: ReviewFollow | undefined;
}) {
  const requestedAddress = personalDirectoryAddress(cursor, PERSONAL_DIRECTORY_CURSOR_LIMITS.following);
  const addressRejected = invalidAddress || page.addressInvalid || !requestedAddress.valid;
  const requestedCursor = requestedAddress.cursor;
  // A meaningful row/page replacement retires local removal callbacks during render. Equivalent
  // refetches (including freshly issued keys) preserve the native control's uncertain intent.
  const lifetime = JSON.stringify({
    ...page,
    cursor: requestedCursor,
    follows: page.follows.map(({ idempotencyKey: _key, ...follow }) => follow),
  });
  const ref = useRef({
    key: lifetime,
    id: crypto.randomUUID(),
    parent: origin?.lifetime,
    active: true,
    mounted: false,
  });
  if (ref.current.key !== lifetime || ref.current.parent !== origin?.lifetime) {
    ref.current.active = false;
    ref.current = { key: lifetime, id: crypto.randomUUID(), parent: origin?.lifetime, active: true, mounted: false };
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
  return (
    <MineFollowingPageState
      key={row.id}
      page={page}
      cursor={requestedCursor}
      addressRejected={addressRejected}
      origin={originating}
      status={status}
      onRetry={onRetry}
      onReview={onReview}
    />
  );
}

function MineFollowingPageState({
  page,
  cursor,
  addressRejected,
  origin,
  status,
  onRetry,
  onReview,
}: {
  page: MineFollowingPage;
  cursor: string | null;
  addressRejected: boolean;
  origin: HistoryOrigin;
  status?: 'unavailable' | 'preparing' | undefined;
  onRetry?: (() => void) | undefined;
  onReview?: ReviewFollow | undefined;
}) {
  const canUnfollow = useOperation('follow.delete');
  const canReadCollection = useOperation('collection.get');
  const [follows, setFollows] = useState(page.follows);
  const [removed, setRemoved] = useState(false);

  const active = page.signedIn ? follows.filter((follow) => follow.state === 'following') : [];
  const restart = !addressRejected && (!!cursor || !!page.cursorReset || removed);
  const firstPageEmpty = !restart && !page.next;
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
      {!addressRejected && status ? (
        <div className="space-y-3">
          <p role="status">{status === 'preparing' ? m.library_follow_loading() : m.library_follow_unavailable()}</p>
          {onRetry ? (
            <Button variant="outline" onClick={onRetry}>
              {m.library_follow_retry()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {addressRejected ? (
        <div className="space-y-3">
          <p role="alert">{m.library_directory_address_invalid()}</p>
          <a href={`/${getLocale()}/library/following`} className={buttonVariants({ variant: 'outline' })}>
            {m.library_directory_address_first_page()}
          </a>
        </div>
      ) : null}
      {!addressRejected && page.signedIn && page.cursorReset ? (
        <p role="status">{m.library_collections_cursor_reset()}</p>
      ) : null}
      {!addressRejected && page.signedIn && removed ? <p role="status">{m.library_follow_removed()}</p> : null}
      {!addressRejected && active.length ? (
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
                          <span hidden={!canUnfollow}>
                            <FollowTargetControl
                              origin={origin}
                              targetId={follow.targetId}
                              following
                              disabled={!!status}
                              idempotencyKey={follow.idempotencyKey}
                              menuTitle={m.library_follow_more_actions({ title: title.text })}
                              onReview={onReview ? () => onReview(follow.targetId) : undefined}
                              onRemoved={() => {
                                if (!origin.isCurrent()) return;
                                setFollows((items) => items.filter((item) => item.targetId !== follow.targetId));
                                setRemoved(true);
                              }}
                            />
                          </span>
                        }
                      />
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      ) : !addressRejected && page.signedIn ? (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              {firstPageEmpty ? m.library_following_empty() : m.library_following_page_empty()}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <a href={`/${getLocale()}/search`} className={buttonVariants({ variant: 'outline' })}>
              {m.search_heading()}
            </a>
          </EmptyContent>
        </Empty>
      ) : null}
      {!addressRejected && page.signedIn && (page.next || restart) ? (
        <Exposure operation="follow.list">
          <nav aria-label={m.library_following_heading()} className="flex flex-wrap items-center gap-3">
            {page.next ? (
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
            ) : null}
            {restart ? (
              <Link
                to="/library/following"
                search={{}}
                onClick={(event) => {
                  if (!origin.isCurrent()) event.preventDefault();
                }}
                className={buttonVariants({ variant: 'outline' })}
              >
                {m.library_collections_first_page()}
              </Link>
            ) : null}
          </nav>
        </Exposure>
      ) : null}
    </article>
  );
}
