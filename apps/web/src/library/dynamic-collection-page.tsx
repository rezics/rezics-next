import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import { displayLibraryTitle } from './title';
import type { DynamicCollectionPage as DynamicCollectionPageData } from './dynamic-collection';
import type { DynamicMembersResult } from './collection-load';
import { CollectionFilterFeedback, CollectionFilters } from './collection-filters';
import { PinControl } from './pin-control';
import { LibraryNavigation } from './library-nav';
import { libraryNavigationQuery } from './pins-read';
import { useQuery } from '@tanstack/react-query';
import { FollowTargetControl } from './follow-target-control';
import { CollectionReadActions, CollectionReadMembers } from './collection-page';
import { collectionPageAddress } from './collection-presentation';
import { AccountRef } from './account-ref';

type DynamicCollectionPageProps = {
  page: DynamicCollectionPageData;
  search?: Record<string, string | string[]>;
  readMembers?: (id: string, cursor?: string) => Promise<DynamicMembersResult>;
};

export function DynamicCollectionPage(props: DynamicCollectionPageProps) {
  const [source, setSource] = useState({ page: props.page, lifetime: 0 });
  // A newly observed loader object starts a page before any of its children render, even at the same URL.
  if (source.page !== props.page) setSource({ page: props.page, lifetime: source.lifetime + 1 });
  return <DynamicCollectionPageLifetime key={source.lifetime} {...props} />;
}

function DynamicCollectionPageLifetime({ page, readMembers, search }: DynamicCollectionPageProps) {
  const [current, setCurrent] = useState(page);
  const [retries, setRetries] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [copyFailure, setCopyFailure] = useState(false);
  // The route's reader closes over the originating filter; callback churn must not retarget a timer.
  const reader = useRef(readMembers);
  const active = useRef(false);
  const navigation = useQuery(libraryNavigationQuery(getLocale(), 100));
  const pins = current.pins ?? navigation.data?.pins ?? { state: 'closed' as const };
  const collections = current.navigationCollections ?? navigation.data?.collections ?? [];
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { id, cursor, preparing, unavailable, retryAfterMs } = current;
  useEffect(() => {
    const read = reader.current;
    if (!preparing || unavailable || retries >= 3 || retrying || !read) return;
    const timer = setTimeout(
      async () => {
        if (!active.current) return;
        setRetrying(true);
        try {
          const result = await read(id, cursor);
          if (active.current) setCurrent((value) => ({ ...value, ...result }));
        } catch {
          if (active.current) setCurrent((value) => ({ ...value, preparing: false, unavailable: true }));
        } finally {
          if (active.current) {
            setRetries((count) => count + 1);
            setRetrying(false);
          }
        }
      },
      Math.max(1000, Math.min(30_000, Number.isFinite(retryAfterMs) ? retryAfterMs : 1000)),
    );
    return () => clearTimeout(timer);
  }, [id, cursor, preparing, unavailable, retryAfterMs, retries, retrying]);
  const empty =
    current.builtinKind === 'everything'
      ? m.library_dynamic_empty_everything()
      : current.builtinKind === 'liked'
        ? m.library_dynamic_empty_liked()
        : m.library_collection_empty();
  async function copyLink(href: string) {
    if (!active.current) return;
    setCopyFailure(false);
    try {
      await navigator.clipboard.writeText(`${location.origin}${href}`);
    } catch {
      if (active.current) setCopyFailure(true);
    }
  }
  const locale = getLocale();
  return (
    <div className="w-full min-w-0 space-y-6 text-foreground">
      <LibraryNavigation current={{ collectionId: current.id }} pins={pins} collections={collections} />
      <article className="w-full min-w-0 space-y-6 text-foreground">
        <header className="rounded-2xl bg-card p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <PageHeading>{current.title}</PageHeading>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <PinControl collectionId={current.id} pins={pins} mode="collection" />
              <CollectionReadActions
                onShare={() => copyLink(`/${locale}/collections/${encodeURIComponent(current.id)}`)}
              />
            </div>
          </div>
          {current.curator ? (
            <div className="mt-3">
              <AccountRef account={current.curator} avatar />
            </div>
          ) : null}
          {current.description ? <p className="mt-3 whitespace-pre-wrap">{current.description}</p> : null}
          <FollowTargetControl targetId={current.id} following={current.following ?? null} />
        </header>
        <p className="text-sm text-muted-foreground">{m.library_collection_social_unavailable()}</p>
        {copyFailure ? <p role="alert">{m.error_message()}</p> : null}
        <p className="text-sm text-muted-foreground">{m.library_collection_builtin_rule()}</p>
        {current.filterProperties && current.filterParams ? (
          <CollectionFilters
            id={current.id}
            type={current.filterType ?? 'schema:Book'}
            properties={current.filterProperties}
            params={current.filterParams}
          />
        ) : null}
        <CollectionFilterFeedback
          id={current.id}
          {...(current.filter === undefined ? {} : { filter: current.filter })}
          {...(current.filterIgnored === undefined ? {} : { ignored: current.filterIgnored })}
          {...(current.filterStatus === undefined ? {} : { status: current.filterStatus })}
          {...(current.filterType === undefined ? {} : { filterType: current.filterType })}
          empty={!current.preparing && current.members.length === 0}
          emptyLabel={empty}
          {...(current.unavailable !== undefined ? { unavailable: current.unavailable } : {})}
        />
        {current.preparing ? (
          current.filterStatus === 'preparing' ? null : (
            <p role="status">{m.library_dynamic_preparing()}</p>
          )
        ) : current.unavailable ? (
          <p role="alert">{m.library_dynamic_unavailable()}</p>
        ) : current.members.length ? (
          <CollectionReadMembers
            members={current.members}
            typeRatios={current.typeRatios}
            listPresentations={current.listPresentations}
            onCopy={({ subject }) => {
              if (!subject) return;
              const title = displayLibraryTitle(subject.label, locale).text;
              copyLink(subjectHref({ id: subject.id, label: title }, locale).href);
            }}
          />
        ) : null}
        {current.preparing && retries >= 3 ? (
          <div>
            <p>{m.library_dynamic_try_later()}</p>
            <button
              className="underline"
              type="button"
              onClick={() => {
                if (!active.current || retrying) return;
                setRetries(0);
              }}
            >
              {m.library_collection_reload()}
            </button>
          </div>
        ) : null}
        {current.next ? (
          <nav aria-label={m.library_collection_members()}>
            <a
              href={collectionPageAddress(locale, current.id, current.next, search)}
              className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
            >
              {m.library_collection_more()}
            </a>
          </nav>
        ) : null}
      </article>
    </div>
  );
}
