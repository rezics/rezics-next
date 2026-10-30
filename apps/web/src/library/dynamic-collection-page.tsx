import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
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
import { Exposure, useOperation } from '../kernel/exposure';
import { useSession } from '../session/query';
import { setCollectionFollow } from './collection-edit';
import { csrfHeaders } from '../threads/composer';
import { CollectionSubjectList } from './collection-editor';
import { AccountRef } from './account-ref';

export function DynamicCollectionPage({
  page,
  readMembers,
}: {
  page: DynamicCollectionPageData;
  readMembers?: (id: string, cursor?: string) => Promise<DynamicMembersResult>;
}) {
  const [current, setCurrent] = useState(page);
  const [retries, setRetries] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [following, setFollowing] = useState(page.following ?? null);
  const [followPending, setFollowPending] = useState(false);
  const [followFailure, setFollowFailure] = useState(false);
  const navigation = useQuery(libraryNavigationQuery(getLocale(), 100));
  const pins = current.pins ?? navigation.data?.pins ?? { state: 'closed' as const };
  const collections = current.navigationCollections ?? navigation.data?.collections ?? [];
  const canFollow = useOperation('follow.put');
  const { csrfToken } = useSession();
  useEffect(() => {
    setCurrent(page);
    setRetries(0);
    setRetrying(false);
    setFollowing(page.following ?? null);
    setFollowFailure(false);
  }, [page]);
  useEffect(() => {
    if (!current.preparing || retries >= 3 || retrying || !readMembers) return;
    const timer = setTimeout(
      () => {
        setRetrying(true);
        void readMembers(current.id, current.cursor)
          .then(
            (result) => {
              setCurrent((value) => ({ ...value, ...result }));
            },
            () => {
              setCurrent((value) => ({
                ...value,
                preparing: false,
                unavailable: true,
              }));
            },
          )
          .finally(() => {
            setRetries((count) => count + 1);
            setRetrying(false);
          });
      },
      Math.max(1000, Math.min(30_000, current.retryAfterMs)),
    );
    return () => clearTimeout(timer);
  }, [current, readMembers, retries, retrying]);
  const empty =
    current.builtinKind === 'everything'
      ? m.library_dynamic_empty_everything()
      : current.builtinKind === 'liked'
        ? m.library_dynamic_empty_liked()
        : m.library_collection_empty();
  async function toggleFollow() {
    if (!csrfToken || following === null || followPending) return;
    setFollowPending(true);
    setFollowFailure(false);
    try {
      const result = await setCollectionFollow({
        data: { collectionId: current.id, follow: !following, idempotencyKey: crypto.randomUUID() },
        headers: csrfHeaders(),
      });
      if (result.ok) setFollowing(!following);
      else setFollowFailure(true);
    } catch {
      setFollowFailure(true);
    } finally {
      setFollowPending(false);
    }
  }
  const locale = getLocale();
  return (
    <div className="w-full min-w-0 space-y-6 text-foreground">
      <LibraryNavigation current={{ collectionId: current.id }} pins={pins} collections={collections} />
      <article className="w-full min-w-0 space-y-6 text-foreground">
        <header className="rounded-2xl bg-card p-4 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <PageHeading>{current.title}</PageHeading>
            <PinControl collectionId={current.id} pins={pins} mode="collection" />
          </div>
          {current.curator ? (
            <div className="mt-3">
              <AccountRef account={current.curator} avatar />
            </div>
          ) : null}
          {current.description ? <p className="mt-3 whitespace-pre-wrap">{current.description}</p> : null}
          {canFollow && following !== null ? (
            <Exposure operation="follow.put">
              <div className="flex flex-wrap items-center gap-3">
                {following ? <p>{m.library_following()}</p> : null}
                <button
                  className="inline-flex min-h-10 items-center rounded-lg border border-border px-3 text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!csrfToken || followPending}
                  onClick={() => void toggleFollow()}
                  type="button"
                >
                  {following ? m.library_follow_unfollow() : m.library_follow()}
                </button>
                {followFailure ? <p role="alert">{m.error_message()}</p> : null}
              </div>
            </Exposure>
          ) : null}
        </header>
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
          empty={current.members.length === 0}
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
          <CollectionSubjectList
            subjects={current.members.map((member) => member.subject)}
            typeRatios={current.typeRatios}
            onCopy={(subject) => {
              const title = displayLibraryTitle(subject.label, locale).text;
              void navigator.clipboard
                .writeText(`${location.origin}${subjectHref({ id: subject.id, label: title }, locale).href}`)
                .catch(() => undefined);
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
                setRetries(0);
                setRetrying(false);
              }}
            >
              {m.library_collection_reload()}
            </button>
          </div>
        ) : null}
        {current.next ? (
          <nav aria-label={m.library_collection_members()}>
            <Link
              to="/collections/$id"
              params={{ id: current.id }}
              search={{ cursor: current.next }}
              className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
            >
              {m.library_collection_more()}
            </Link>
          </nav>
        ) : null}
      </article>
    </div>
  );
}
