import { Cover } from '@rezics/ui/cover';
import { coverSrc } from '../media/cover-src';
import { FilteredLibraryRemovalControl } from './bulk-filtered-library-removal-view';
import { CollectionFilteredStatus } from './bulk-filtered-status-view';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import { displayLibraryTitle } from './title';
import type { DynamicCollectionPage as DynamicCollectionPageData } from './dynamic-collection';
import type { DynamicMembersResult } from './collection-load';
import { CollectionFilterFeedback, CollectionFilters } from './collection-filters';
import { PinControlView, usePinControlActions } from './pin-control';
import { LibraryNavigation } from './library-nav';
import { useCurrentLibraryNavigation } from './pins-current';
import { FollowTargetControl } from './follow-target-control';
import { CollectionReadActions, CollectionReadMembers } from './collection-page';
import { CollectionPresentationSummary } from './showcase-collection/presentation';
import { AccountRef } from './account-ref';
import { CollectionDescriptionReader } from './collection-description-reader';
import { BulkFilteredAdd } from './bulk-filtered-add-view';
import { isOrdinarySavedQuery, RuleEditLink, savedQueryResultsAddress } from './saved-query-results';
import { admitsCollectionOperation } from './collection-records';
import { CollectionAccessState } from './collection-access';
import { useOperation } from '../kernel/exposure';
import { SavedQueryManagement } from './saved-query-management';
import { SavedFilterReviewEntry, SavedFilterReviewScopeBoundary } from './saved-filter-review';
import type { ManagedSavedQuery } from './saved-query-management/controller';
import type { QueryKey } from '@tanstack/react-query';
import type { RulePage } from './collection-rule-read';
import { DynamicRuleResultsReview } from './dynamic-rule-review';

type DynamicCollectionPageProps = {
  page: DynamicCollectionPageData;
  search?: Record<string, string | string[]>;
  readMembers?: (id: string, cursor?: string) => Promise<DynamicMembersResult>;
  readCurrent?: (() => Promise<DynamicCollectionPageData>) | undefined;
  queryKey?: QueryKey | undefined;
  returnTo?: string | undefined;
  layout?: 'grid' | 'list' | undefined;
  viewerId?: string | null;
  readRule?: ((id: string) => Promise<RulePage>) | undefined;
};

export function DynamicCollectionPage(props: DynamicCollectionPageProps) {
  const identity = JSON.stringify([props.page.id, props.page.cursor, props.search, props.viewerId, props.queryKey]);
  const [source, setSource] = useState({ page: props.page, identity, lifetime: 0 });
  const navigation = useCurrentLibraryNavigation(
    getLocale(),
    100,
    JSON.stringify([props.page.id, props.page.cursor, props.search]),
  );
  const pinActions = usePinControlActions({
    collectionId: props.page.id,
    pins: navigation.data.pins,
    mode: 'collection',
    origin: navigation.pinsOrigin,
  });
  // A newly observed loader object starts a page before any of its children render, even at the same URL.
  if (source.page !== props.page || source.identity !== identity)
    setSource({ page: props.page, identity, lifetime: source.lifetime + 1 });
  return (
    <DynamicCollectionPageLifetime
      key={source.lifetime}
      {...props}
      pins={navigation.data.pins}
      pinActions={pinActions}
      collections={navigation.data.collections}
    />
  );
}

function DynamicCollectionPageLifetime({
  page,
  readMembers,
  search,
  readCurrent,
  queryKey,
  returnTo,
  layout,
  viewerId = null,
  readRule: propsReadRule,
  pins,
  pinActions,
  collections,
}: DynamicCollectionPageProps & {
  pins: NonNullable<DynamicCollectionPageData['pins']>;
  pinActions: ReturnType<typeof usePinControlActions>;
  collections: NonNullable<DynamicCollectionPageData['navigationCollections']>;
}) {
  const [current, setCurrent] = useState(page);
  const [retries, setRetries] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [copyFailure, setCopyFailure] = useState(false);
  const [access, setAccess] = useState<'denied' | 'closed' | null>(null);
  const [observation, setObservation] = useState(0);
  const observed = useRef(0);
  const locked = useRef(false);
  const [explicitRetry, setExplicitRetry] = useState(false);
  const retryButton = useRef<HTMLButtonElement>(null);
  const resultNotice = useRef<HTMLParagraphElement>(null);
  const focusResult = useRef(false);
  const ruleRead = useOperation('collection.get');
  const ruleUpdate = useOperation('collection.update');
  // The route's reader closes over the originating filter; callback churn must not retarget a timer.
  const origin = useRef({ read: readMembers, id: page.id, cursor: page.cursor });
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { id, preparing, unavailable, retryAfterMs } = current;
  // Both paths use the same captured reader/address. An explicit retry is a read, never a command replay.
  async function refreshMembers(explicit = false) {
    const { read, id, cursor } = origin.current;
    if (!active.current || locked.current || !read || access) return;
    locked.current = true;
    setRetrying(true);
    if (explicit) {
      setRetries(0);
      setExplicitRetry(true);
    }
    try {
      const result = await read(id, cursor);
      if (!active.current) return;
      if (result.access) {
        setAccess(result.access);
        return;
      }
      if (result.page && result.page.id !== id) {
        setAccess('denied');
        return;
      }
      // A production read replaces the complete admitted page, including definition-bound filters and actions.
      // Standalone readers retain their originating shell and explicitly clear former response status.
      const replacement = result.page ?? {
        ...current,
        ...result,
        filterStatus: result.filterStatus,
        cursorRestarted: result.cursorRestarted === true,
      };
      setCurrent({
        ...replacement,
        ...(replacement.preparing ||
        replacement.unavailable ||
        replacement.filterStatus ||
        replacement.filterIgnored?.length
          ? { members: [], next: null }
          : {}),
      });
      focusResult.current = explicit && document.activeElement === retryButton.current;
      observed.current += 1;
      setCopyFailure(false);
      setObservation(observed.current);
    } catch {
      if (active.current) {
        setCurrent((value) => ({
          ...value,
          members: [],
          next: null,
          preparing: false,
          unavailable: true,
          filterStatus: undefined,
        }));
        observed.current += 1;
        setCopyFailure(false);
        setObservation(observed.current);
      }
    } finally {
      if (active.current) {
        setRetries((count) => count + 1);
        setRetrying(false);
        setExplicitRetry(false);
        locked.current = false;
      }
    }
  }
  useEffect(() => {
    if (!preparing || unavailable || retries >= 3 || retrying || !origin.current.read || access) return;
    const timer = setTimeout(
      () => void refreshMembers(),
      Math.max(1000, Math.min(30_000, Number.isFinite(retryAfterMs) ? retryAfterMs : 1000)),
    );
    return () => clearTimeout(timer);
  }, [preparing, unavailable, retryAfterMs, retries, retrying, access]);
  useLayoutEffect(() => {
    if (!focusResult.current) return;
    focusResult.current = false;
    // A visitor who moved focus during the read keeps it. Only the retry action's own completion moves it.
    if (document.activeElement === retryButton.current || document.activeElement === document.body)
      resultNotice.current?.focus();
  }, [observation]);
  const empty =
    current.builtinKind === 'everything'
      ? m.library_dynamic_empty_everything()
      : current.builtinKind === 'liked'
        ? m.library_dynamic_empty_liked()
        : m.library_collection_empty();
  const incompleteFilter = (current.filterIgnored?.length ?? 0) > 0;
  const membersReady = !current.preparing && !current.unavailable && !current.filterStatus && !incompleteFilter;
  const laterPage = current.cursor !== undefined;
  async function copyLink(href: string) {
    if (!active.current) return;
    setCopyFailure(false);
    const source = observed.current;
    try {
      await navigator.clipboard.writeText(`${location.origin}${href}`);
    } catch {
      if (active.current && observed.current === source) setCopyFailure(true);
    }
  }
  const locale = getLocale();
  const saved = isOrdinarySavedQuery(current);
  const resultsHref = savedQueryResultsAddress(locale, current.id, current.cursor, search, { layout, returnTo });
  const firstPageHref = savedQueryResultsAddress(locale, current.id, undefined, search, { layout, returnTo });
  if (access === 'denied') return <CollectionAccessState state="not-found" />;
  if (access === 'closed') return <p role="alert">{m.platform_closed_message()}</p>;
  const reviewScope =
    saved && viewerId && current.curatorAccountId === viewerId
      ? { id: current.id, title: current.title, ownerId: current.curatorAccountId, viewerId }
      : null;
  return (
    <div className="w-full min-w-0 space-y-6 text-foreground">
      <LibraryNavigation current={{ collectionId: current.id }} pins={pins} collections={collections} />
      <article className="w-full min-w-0 space-y-6 text-foreground">
        <header className="rounded-2xl bg-card p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="w-16 shrink-0 sm:w-24" data-collection-cover-source={current.coverSource}>
                <Cover
                  subject={{
                    id: current.id,
                    title: current.title,
                    types: current.presentationKind ? [current.presentationKind] : [],
                  }}
                  cover={current.cover ?? null}
                  src={coverSrc}
                  size="fill"
                  decorative
                />
              </div>
              <PageHeading>{current.title}</PageHeading>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <PinControlView control={pinActions} />
              <RuleEditLink
                collection={{
                  id: current.id,
                  curatorAccountId: current.curatorAccountId ?? null,
                  membershipKind: 'dynamic',
                  ...(current.builtinKind ? { builtinKind: current.builtinKind } : {}),
                }}
                viewerId={viewerId}
                allowed={
                  ruleRead &&
                  ruleUpdate &&
                  admitsCollectionOperation(current.viewerActions, 'collection:update', 'collection_rule.update')
                }
                resultsHref={resultsHref}
              />
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
          <CollectionDescriptionReader description={current.description} className="mt-3" />
          <CollectionPresentationSummary
            dynamic
            kind={current.presentationKindSource === 'owner' ? current.presentationKind : null}
          />
          <FollowTargetControl targetId={current.id} following={current.following ?? null} />
        </header>
        <SavedQueryManagement
          key={observation}
          page={current}
          viewerId={viewerId}
          {...(queryKey === undefined ? {} : { queryKey })}
          {...(readCurrent === undefined ? {} : { readCurrent })}
          {...(returnTo === undefined ? {} : { returnTo })}
          onMetadata={(metadata: ManagedSavedQuery) => {
            if (!active.current || observed.current !== observation || metadata.id !== id) return;
            setCurrent((value) =>
              value.id !== metadata.id
                ? value
                : {
                    ...value,
                    title: metadata.title,
                    description: metadata.description ?? null,
                    ...(metadata.revision === undefined ? {} : { revision: metadata.revision }),
                    ...(metadata.curatorAccountId === undefined ? {} : { curatorAccountId: metadata.curatorAccountId }),
                    ...(metadata.visibility === undefined ? {} : { visibility: metadata.visibility }),
                    ...(metadata.viewerActions === undefined ? {} : { viewerActions: metadata.viewerActions }),
                  },
            );
          }}
        />
        <p className="text-sm text-muted-foreground">{m.library_collection_social_unavailable()}</p>
        {copyFailure ? <p role="alert">{m.error_message()}</p> : null}
        {saved ? null : <p className="text-sm text-muted-foreground">{m.library_collection_builtin_rule()}</p>}
        <p ref={resultNotice} tabIndex={-1} role="status" aria-live="polite" className="outline-offset-4">
          {retrying
            ? m.library_dynamic_retry_pending()
            : observation > 0 && membersReady
              ? m.library_dynamic_retry_ready()
              : null}
        </p>
        <nav aria-label={m.library_layout()} className="flex min-w-0 flex-wrap gap-2">
          {(['list', 'grid'] as const).map((choice) => (
            <a
              key={choice}
              href={savedQueryResultsAddress(locale, current.id, current.cursor, search, { layout: choice, returnTo })}
              aria-current={(layout ?? 'list') === choice ? 'true' : undefined}
              className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 py-2 text-primary aria-[current=true]:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {choice === 'list' ? m.library_layout_list() : m.library_layout_grid()}
            </a>
          ))}
        </nav>
        {current.cursorRestarted ? <p role="status">{m.library_collections_cursor_reset()}</p> : null}
        {saved && viewerId && current.curatorAccountId === viewerId ? (
          <DynamicRuleResultsReview
            key={observation}
            page={current}
            viewerId={viewerId}
            resultsHref={resultsHref}
            {...(propsReadRule === undefined ? {} : { read: propsReadRule })}
          />
        ) : null}
        <SavedFilterReviewScopeBoundary key={observation} scope={reviewScope}>
          {current.filterProperties && current.filterParams ? (
            <CollectionFilters
              id={current.id}
              type={current.filterType ?? 'schema:Book'}
              properties={current.filterProperties}
              params={current.filterParams}
              {...(current.filterReleaseKey ? { filterReleaseKey: current.filterReleaseKey } : {})}
              viewerKey={viewerId ?? 'anonymous'}
            />
          ) : (
            <SavedFilterReviewEntry />
          )}
        </SavedFilterReviewScopeBoundary>
        <FilteredLibraryRemovalControl
          key={`remove:${observation}`}
          source={{ id: current.id, ...(current.filter === undefined ? {} : { filter: current.filter }) }}
          boundary={JSON.stringify([current.visibility, current.cursor, search])}
          eligible={membersReady && !current.filterIgnored?.length}
        />
        <CollectionFilterFeedback
          id={current.id}
          {...(current.filter === undefined ? {} : { filter: current.filter })}
          {...(current.filterIgnored === undefined ? {} : { ignored: current.filterIgnored })}
          {...(current.filterStatus === undefined ? {} : { status: current.filterStatus })}
          {...(current.filterType === undefined ? {} : { filterType: current.filterType })}
          empty={membersReady && current.members.length === 0 && !laterPage && !current.next}
          emptyLabel={empty}
          {...(current.unavailable !== undefined ? { unavailable: current.unavailable } : {})}
        />
        <BulkFilteredAdd
          key={`add:${observation}`}
          source={{ id: current.id, ...(current.filter === undefined ? {} : { filter: current.filter }) }}
          address={JSON.stringify([current.id, current.cursor, search, queryKey])}
          disabled={!membersReady || (current.filterIgnored?.length ?? 0) > 0}
          isCurrent={() => active.current}
        />
        {membersReady && current.members.length === 0 && (laterPage || current.next) ? (
          <p role="status" className="text-muted-foreground">
            {m.library_dynamic_page_reader_empty()}
          </p>
        ) : null}
        <CollectionFilteredStatus
          key={`status:${observation}`}
          page={current}
          address={JSON.stringify([current.id, current.cursor, search, queryKey])}
          ready={membersReady}
          isCurrent={() => active.current}
        />
        {current.preparing ? (
          current.filterStatus === 'preparing' ? null : (
            <p role="status">{m.library_dynamic_preparing()}</p>
          )
        ) : current.unavailable ? (
          <p role="alert">{m.library_dynamic_unavailable()}</p>
        ) : membersReady && current.members.length ? (
          <CollectionReadMembers
            members={current.members}
            layout={layout ?? 'list'}
            returnSource={current}
            typeRatios={current.typeRatios}
            listPresentations={current.listPresentations}
            comparisonDefinitions={current.comparisonDefinitions}
            currentHref={resultsHref}
            onCopy={({ subject }) => {
              if (!subject) return;
              const title = displayLibraryTitle(subject.label, locale).text;
              copyLink(subjectHref({ id: subject.id, label: title }, locale).href);
            }}
          />
        ) : null}
        {incompleteFilter || current.filterStatus === 'unsupported' || current.filterStatus === 'failed' ? (
          <div className="min-w-0 space-y-2">
            {incompleteFilter ? <p role="alert">{m.collection_filter_address_rejected()}</p> : null}
            <a
              className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 py-2 text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
              href={savedQueryResultsAddress(
                locale,
                current.id,
                undefined,
                current.filterType && !current.filterIgnored?.includes('type') ? { type: current.filterType } : {},
                { layout, returnTo },
              )}
            >
              {m.collection_filter_clear()}
            </a>
          </div>
        ) : null}
        {current.unavailable || (current.preparing && retries >= 3) || explicitRetry ? (
          <div className="min-w-0 space-y-2" aria-busy={retrying}>
            {current.preparing && !retrying && retries >= 3 ? (
              <p role="status">{m.library_dynamic_try_later()}</p>
            ) : null}
            {!retrying ? (
              <p className="text-sm text-muted-foreground">
                {current.unavailable
                  ? m.library_dynamic_retry_unavailable_help()
                  : m.library_dynamic_retry_preparing_help()}
              </p>
            ) : null}
            <button
              className="inline-flex min-h-11 min-w-0 items-center justify-center rounded-lg border border-border px-4 py-2 text-primary underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
              type="button"
              ref={retryButton}
              disabled={retrying || !origin.current.read}
              onClick={() => void refreshMembers(true)}
            >
              {retrying
                ? m.library_dynamic_retry_pending()
                : current.unavailable
                  ? m.library_dynamic_retry_unavailable()
                  : m.library_collection_reload()}
            </button>
          </div>
        ) : null}
        {membersReady && (laterPage || current.next) ? (
          <nav aria-label={m.library_collection_members()} className="flex min-w-0 flex-wrap gap-2">
            {laterPage ? (
              <a
                href={firstPageHref}
                className="inline-flex min-h-11 min-w-0 max-w-full items-center justify-center break-words rounded-lg border border-border px-4 py-2 text-primary underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {m.library_dynamic_page_reader_first_page()}
              </a>
            ) : null}
            {current.next ? (
              <a
                href={savedQueryResultsAddress(locale, current.id, current.next, search, { layout, returnTo })}
                className="inline-flex min-h-11 min-w-0 max-w-full items-center justify-center break-words rounded-lg border border-border px-4 py-2 text-primary underline-offset-4 hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {m.library_collection_more()}
              </a>
            ) : null}
          </nav>
        ) : null}
      </article>
    </div>
  );
}
