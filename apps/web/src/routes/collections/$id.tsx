import { createFileRoute, isNotFound } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import * as v from 'valibot';
import { CollectionPage, collectionPageHead } from '../../library/collection-page';
import { DynamicCollectionPage } from '../../library/dynamic-collection-page';
import type { DynamicCollectionPage as DynamicCollectionPageData } from '../../library/dynamic-collection';
import {
  collectionRenderPolicy,
  collectionRequestVariant,
  collectionResultMatches,
  type CollectionPageResult,
  type CollectionReadAddress,
} from '../../library/collection-load';
import {
  collectionPageQuery,
  viewerCollectionPageQuery,
  readCollectionPage,
  readDynamicCollectionMembers,
} from '../../library/collection-queries';
import { libraryTitleValue } from '../../library/title';
import { pageText } from '../../features/pages/shared';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { pageHead, pageLinks } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { sessionQuery, useSession } from '../../session/query';
import { useOperationAdmission } from '../../kernel/exposure';
import { viewerExposureLifetime, viewerExposureQuery } from '../../kernel/viewer-exposure';
import { CollectionAccessState } from '../../library/collection-access';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { getLocale } from '../../paraglide/runtime.js';
import {
  admitSavedQueryResultsWindow,
  cancelSavedQueryResultsWindowFocus,
  failPendingSavedQueryResultsWindowMove,
  failSavedQueryResultsWindowMove,
  hasPendingSavedQueryResultsWindowTarget,
  readSavedQueryResultsWindow,
  retireSavedQueryResultsWindows,
  retireSavedQueryResultsWindowReading,
  savedQueryResultsWindowBase,
  savedQueryResultsWindowScope,
  stageSavedQueryResultsWindowMove,
  type ResultsWindowMove,
} from '../../library/saved-query-results-windows';
import { isOrdinarySavedQuery } from '../../library/saved-query-results';

export const Route = createFileRoute('/collections/$id')({
  staticData: { publicCache: true },
  validateSearch: (search: Record<string, unknown>) => {
    const { cursor } = v.parse(
      v.object({
        cursor: v.fallback(v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))), undefined),
      }),
      search,
    );
    const filters: Record<string, string | string[]> = {};
    const returnTo =
      typeof search.returnTo === 'string' && search.returnTo.length <= 4096 ? search.returnTo : undefined;
    for (const [key, value] of Object.entries(search))
      if (key === 'type' && typeof value === 'string' && value.length <= 128) filters[key] = value;
      else if (
        /^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) &&
        (typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))
      )
        filters[key] = value as string | string[];
    const layout: 'grid' | 'list' | undefined =
      search.layout === 'grid' || search.layout === 'list' ? search.layout : undefined;
    return {
      ...(cursor === undefined ? {} : { cursor }),
      ...(layout ? { layout } : {}),
      ...(returnTo ? { returnTo } : {}),
      ...(Object.keys(filters).length ? { filters } : {}),
    };
  },
  loaderDeps: ({ search }) => ({
    cursor: search.cursor,
    filters: search.filters,
  }),
  loader: ({ params, deps, context }) => {
    return context.queryClient.ensureQueryData(collectionPageQuery(params.id, deps.cursor, 'anonymous', deps.filters));
  },
  head: ({ loaderData, match }) => {
    if (!loaderData)
      return pageHead({ title: m.not_found_heading(), robots: 'noindex, follow' }, pageHeadContext(match.pathname));
    const context = pageHeadContext(match.pathname);
    const base = collectionPageHead(loaderData, context, loaderData.cursor !== undefined);
    const title = pageText(libraryTitleValue(loaderData.title), context.locale).text;
    const canonical = pageLinks(context.origin, context.locale, context.path)[0]!.href;
    const itemList =
      !('preparing' in loaderData) && collectionRenderPolicy(loaderData).completeItemList
        ? {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            name: title,
            ...(loaderData.description ? { description: loaderData.description } : {}),
            url: canonical,
            itemListOrder: 'https://schema.org/ItemListOrderAscending',
            numberOfItems: loaderData.members.filter((member) => member.subject != null).length,
            itemListElement: loaderData.members
              .filter((member) => member.subject != null)
              .map((member, index) => {
                const subject = member.subject!;
                const label = pageText(libraryTitleValue(subject.label), context.locale).text;
                const itemPath = subjectHref({ id: subject.id, label }, context.locale).href;
                return {
                  '@type': 'ListItem',
                  position: index + 1,
                  item: {
                    '@id': new URL(itemPath, context.origin).href,
                    name: label,
                  },
                  ...(member.note ? { description: member.note } : {}),
                };
              }),
          }
        : undefined;
    const scripts = itemList === undefined ? [] : pageHead({ title, jsonLd: itemList }, context).scripts;
    return { ...base, scripts: [...(scripts ?? []), ...(base.scripts ?? [])] };
  },
  component: CollectionRoute,
  notFoundComponent: PrivateCollectionRoute,
});

function CollectionRoute() {
  const initialPage = Route.useLoaderData();
  return <CollectionContent initialPage={initialPage} />;
}

/** Concealed public 404s can recover an authorized private Collection after hydration. */
function PrivateCollectionRoute() {
  return <CollectionContent />;
}

function CollectionContent({ initialPage }: { initialPage?: CollectionPageResult | undefined }) {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const { state, subject, csrfToken } = useSession();
  const getAdmission = useOperationAdmission('collection.get');
  const membersAdmission = useOperationAdmission('collection_member.list');
  const getAdmitted = getAdmission === 'available';
  const membersAdmitted = membersAdmission === 'available';
  const viewerId = state === 'signed-in' && subject ? subject : null;
  const canRead = state === 'signed-in' && viewerId !== null && Boolean(csrfToken) && getAdmitted && membersAdmitted;
  const exposure = viewerExposureLifetime(queryClient).getSnapshot();
  const exposureKey =
    exposure.state === 'signed-in'
      ? viewerExposureQuery(exposure.observation).queryKey
      : (['exposure', 'anonymous'] as const);
  const sessionUpdateCount = queryClient.getQueryState(sessionQuery.queryKey)?.dataUpdateCount ?? 0;
  const exposureUpdateCount = queryClient.getQueryState(exposureKey)?.dataUpdateCount ?? 0;
  const identity = JSON.stringify([
    collectionRequestVariant({ id, cursor: search.cursor, search: search.filters }),
    state,
    viewerId,
    csrfToken ?? null,
    getAdmission,
    membersAdmission,
  ]);
  const windowIdentity = JSON.stringify([
    id,
    search.filters ?? null,
    getLocale(),
    state,
    viewerId,
    csrfToken ?? null,
    getAdmission,
    membersAdmission,
    sessionUpdateCount,
    exposureUpdateCount,
  ]);
  const [observed, setObserved] = useState({
    identity,
    windowIdentity,
    queryClient,
    generation: 0,
    windowGeneration: 0,
  });
  const windowChanged = observed.windowIdentity !== windowIdentity || observed.queryClient !== queryClient;
  // Retire replacement visits before they reach children; only a staged cursor destination continues this visit.
  if (observed.identity !== identity || windowChanged) {
    if (windowChanged) {
      retireSavedQueryResultsWindows(observed.queryClient);
      retireSavedQueryResultsWindows(queryClient);
    } else {
      const currentBase = savedQueryResultsWindowBase({
        id,
        ...(search.filters ? { search: search.filters } : {}),
        locale: getLocale(),
        admission: observed.windowGeneration,
      });
      const deliberateMove = (['anonymous', 'session'] as const).some((mode) =>
        hasPendingSavedQueryResultsWindowTarget(queryClient, currentBase, mode, search.cursor),
      );
      if (!deliberateMove) retireSavedQueryResultsWindows(queryClient);
    }
    setObserved({
      identity,
      windowIdentity,
      queryClient,
      generation: observed.generation + 1,
      windowGeneration: observed.windowGeneration + (windowChanged ? 1 : 0),
    });
  }
  const windowGeneration = observed.windowGeneration + (windowChanged ? 1 : 0);
  const windowBase = savedQueryResultsWindowBase({
    id,
    ...(search.filters ? { search: search.filters } : {}),
    locale: getLocale(),
    admission: windowGeneration,
  });
  useLayoutEffect(() => () => retireSavedQueryResultsWindows(queryClient), [queryClient]);
  const navigateWindow = (cursor: string | undefined) =>
    navigate({
      to: '/collections/$id',
      params: { id },
      search: (previous) => ({ ...previous, cursor }),
    });
  return (
    <CollectionContentLifetime
      key={observed.generation}
      id={id}
      search={search}
      initialPage={initialPage}
      session={state}
      viewerId={viewerId}
      canRead={canRead}
      queryClient={queryClient}
      windowBase={windowBase}
      navigateWindow={navigateWindow}
      readerGeneration={observed.generation}
    />
  );
}

function CollectionContentLifetime({
  id,
  search,
  initialPage,
  session,
  viewerId,
  canRead,
  queryClient,
  windowBase,
  navigateWindow,
  readerGeneration,
}: {
  id: string;
  search: {
    cursor?: string;
    filters?: Record<string, string | string[]>;
    layout?: 'grid' | 'list';
    returnTo?: string;
  };
  initialPage?: CollectionPageResult | undefined;
  session: ReturnType<typeof useSession>['state'];
  viewerId: string | null;
  canRead: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
  windowBase: string;
  navigateWindow: (cursor: string | undefined) => Promise<void>;
  readerGeneration: number;
}) {
  const lifetime = `${readerGeneration}:${useId()}`;
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const input = {
    id,
    ...(search.cursor ? { cursor: search.cursor } : {}),
    ...(search.filters ? { search: search.filters } : {}),
  };
  const privateQuery = viewerCollectionPageQuery(
    id,
    search.cursor,
    viewerId,
    search.filters,
    () => active.current && canRead,
    lifetime,
  );
  const sessionPage = useQuery({ ...privateQuery, enabled: canRead, retry: false });
  // A loader is only an explicit anonymous representation, never a private-data fallback.
  const publicPage =
    initialPage && collectionResultMatches(initialPage, input, 'anonymous', null) ? initialPage : undefined;
  const privatePage =
    canRead && sessionPage.data && collectionResultMatches(sessionPage.data, input, 'session', viewerId)
      ? sessionPage.data
      : undefined;
  if (canRead && sessionPage.error) {
    if (isNotFound(sessionPage.error)) {
      retireSavedQueryResultsWindowReading(queryClient, windowBase, 'session');
      return <CollectionAccessState state="not-found" />;
    }
    failPendingSavedQueryResultsWindowMove(queryClient, windowBase, 'session', search.cursor);
    const retryPendingMove = hasPendingSavedQueryResultsWindowTarget(queryClient, windowBase, 'session', search.cursor);
    return (
      <div className="space-y-3">
        <CollectionAccessState state="unavailable" />
        {retryPendingMove ? (
          <button
            className="mx-auto inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 py-2 text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
            type="button"
            disabled={sessionPage.isFetching}
            onClick={() => void queryClient.refetchQueries({ queryKey: privateQuery.queryKey, exact: true })}
          >
            {m.library_dynamic_retry_unavailable()}
          </button>
        ) : null}
      </div>
    );
  }
  const page = privatePage ?? publicPage;
  if (!page) {
    const state =
      session === 'unavailable'
        ? 'unavailable'
        : session === 'unknown' || (canRead && sessionPage.isPending)
          ? 'loading'
          : 'not-found';
    return <CollectionAccessState state={state} />;
  }
  const mode = privatePage ? ('session' as const) : ('anonymous' as const);
  const authority =
    'preparing' in page
      ? null
      : [
          page.visibility,
          page.viewerActions?.state,
          page.viewerActions?.state === 'ready'
            ? page.viewerActions.actions.map(({ action, operations }) => [action, [...operations].sort()]).sort()
            : null,
        ];
  return (
    <CollectionResultLifetime
      key={JSON.stringify([mode, authority])}
      page={page}
      input={input}
      {...(search.returnTo === undefined ? {} : { returnTo: search.returnTo })}
      layout={search.layout ?? 'list'}
      mode={mode}
      viewerId={viewerId}
      canRead={canRead}
      queryClient={queryClient}
      windowBase={windowBase}
      navigateWindow={navigateWindow}
      queryKey={
        mode === 'session'
          ? privateQuery.queryKey
          : collectionPageQuery(id, search.cursor, 'anonymous', search.filters).queryKey
      }
    />
  );
}

function CollectionResultLifetime({
  page,
  input,
  returnTo,
  layout,
  mode,
  viewerId,
  canRead,
  queryKey,
  queryClient,
  windowBase,
  navigateWindow,
}: {
  page: CollectionPageResult;
  input: CollectionReadAddress;
  returnTo?: string;
  layout: 'grid' | 'list';
  mode: 'session' | 'anonymous';
  viewerId: string | null;
  canRead: boolean;
  queryKey: readonly unknown[];
  queryClient: ReturnType<typeof useQueryClient>;
  windowBase: string;
  navigateWindow: (cursor: string | undefined) => Promise<void>;
}) {
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  function assertCurrent(privateRead = false) {
    if (!active.current || (privateRead && (!canRead || mode !== 'session')))
      throw new Error('Collection read retired');
  }
  async function refreshPage(editor = false) {
    assertCurrent(true);
    const request = { ...input, ...(editor ? { editor: true } : {}) };
    const result = await readCollectionPage({ data: { ...request, credentialMode: 'session' } });
    assertCurrent(true);
    if (!collectionResultMatches(result, request, 'session', viewerId) || 'preparing' in result)
      throw new Error('Collection response does not match the current viewer and request');
    return result;
  }
  async function readMembers(collectionId: string, cursor?: string) {
    assertCurrent(mode === 'session');
    // The dynamic retry reader addresses the same observed page, including a stale-cursor restart.
    if (collectionId !== input.id || cursor !== page.cursor) throw new Error('Collection member address changed');
    const request = {
      id: collectionId,
      ...(cursor ? { cursor } : {}),
      ...(input.search ? { search: input.search } : {}),
    };
    try {
      const result = await readDynamicCollectionMembers({ data: { ...request, credentialMode: mode } });
      assertCurrent(mode === 'session');
      if (!collectionResultMatches(result, request, mode, mode === 'session' ? viewerId : null, 'members'))
        throw new Error('Collection members do not match the current viewer and request');
      return result;
    } catch (error) {
      assertCurrent(mode === 'session');
      const access = isNotFound(error)
        ? ('denied' as const)
        : isPlatformClosedError(error)
          ? ('closed' as const)
          : null;
      if (!access) throw error;
      return { members: [], next: null, preparing: false, retryAfterMs: 1000, unavailable: false, access };
    }
  }
  async function readCurrentDynamicPage() {
    assertCurrent(true);
    const result = await readCollectionPage({ data: { ...input, credentialMode: 'session' } });
    assertCurrent(true);
    if (!collectionResultMatches(result, input, 'session', viewerId) || !('preparing' in result))
      throw new Error('Current dynamic Collection read does not match this viewer and page');
    return result;
  }
  const saved = 'preparing' in page && isOrdinarySavedQuery(page);
  if (!saved) retireSavedQueryResultsWindowReading(queryClient, windowBase, mode);
  const windowNavigation = saved
    ? {
        view: (current: DynamicCollectionPageData) => {
          const scope = savedQueryResultsWindowScope(windowBase, mode, viewerId, current);
          const cursor = current.cursorRestarted ? undefined : current.cursor;
          return readSavedQueryResultsWindow(queryClient, windowBase, mode, scope, cursor);
        },
        move: (
          current: DynamicCollectionPageData,
          target: string | undefined,
          movement: ResultsWindowMove,
          source?: HTMLElement,
        ) => {
          const scope = savedQueryResultsWindowScope(windowBase, mode, viewerId, current);
          const from = current.cursorRestarted ? undefined : current.cursor;
          const staged = stageSavedQueryResultsWindowMove(
            queryClient,
            windowBase,
            mode,
            scope,
            from,
            target,
            movement,
            source,
          );
          if (!staged) return false;
          void navigateWindow(target);
          return true;
        },
        admit: (current: DynamicCollectionPageData) => {
          const scope = savedQueryResultsWindowScope(windowBase, mode, viewerId, current);
          return admitSavedQueryResultsWindow(
            queryClient,
            windowBase,
            mode,
            scope,
            current.cursorRestarted ? undefined : current.cursor,
            current.cursorRestarted === true,
          );
        },
        fail: (current: DynamicCollectionPageData) =>
          failSavedQueryResultsWindowMove(
            queryClient,
            windowBase,
            mode,
            savedQueryResultsWindowScope(windowBase, mode, viewerId, current),
            current.cursorRestarted ? input.cursor : current.cursor,
          ),
        retireReplacement: (next: DynamicCollectionPageData) => {
          const cursor = next.cursorRestarted ? input.cursor : next.cursor;
          const scope = savedQueryResultsWindowScope(windowBase, mode, viewerId, next);
          const view = readSavedQueryResultsWindow(queryClient, windowBase, mode, scope, cursor);
          if (view.pendingTarget) cancelSavedQueryResultsWindowFocus(queryClient, windowBase, mode, scope, cursor);
          else retireSavedQueryResultsWindowReading(queryClient, windowBase, mode);
        },
      }
    : undefined;
  return 'preparing' in page ? (
    <DynamicCollectionPage
      page={page}
      {...(input.search ? { search: input.search } : {})}
      readMembers={readMembers}
      readCurrent={readCurrentDynamicPage}
      queryKey={queryKey}
      returnTo={returnTo}
      layout={layout}
      viewerId={mode === 'session' ? viewerId : null}
      {...(windowNavigation ? { windowNavigation } : {})}
    />
  ) : (
    <CollectionPage
      page={page}
      cursor={input.cursor}
      layout={layout}
      {...(input.search ? { search: input.search } : {})}
      queryKey={queryKey}
      isCurrent={() => active.current && mode === 'session' && canRead}
      refreshPage={() => refreshPage()}
      readEditorPage={() => refreshPage(true)}
    />
  );
}
