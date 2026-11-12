import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { prepareExposure } from '../../kernel/exposure';
import { requireSignedIn } from '../../session/guard';
import { sessionQueryKey } from '../../session/browser-state';
import { ContinueSection, useContinueRefresh, type ContinueWindowAction } from '../../library/continue';
import { readContinueEntries } from '../../library/continue-read';
import { HostedCheckpointBooks } from '../../library/hosted-checkpoint-books';
import { hostedBookHref } from '../../books/reader/route';
import { continueAddress, continueCursorHref, continueNewestHref } from '../../library/continue-address';
import {
  CONTINUE_WINDOW_QUERY_KEY,
  abandonContinueWindowStage,
  acceptContinueWindow,
  continueWindowOwner,
  continueWindowPrevious,
  continueWindowVisit,
  isContinueSessionQuery,
  retireContinueWindow,
  sameContinueWindowOwner,
  stageContinueWindow,
  type ContinueWindowVisit,
} from '../../library/continue-window-navigation';
import { LibraryNavigation } from '../../library/library-nav';
import { useCurrentLibraryNavigation } from '../../library/pins-current';
import { m } from '../../paraglide/messages.js';
import { getLocale, type Locale } from '../../paraglide/runtime.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { PageHeading } from '../../shell/page-heading';

type ContinueLoaderData = {
  address: ReturnType<typeof continueAddress>;
  result: Awaited<ReturnType<typeof readContinueEntries>>;
};

export const Route = createFileRoute('/library/continue')({
  beforeLoad: async (context) => {
    await requireSignedIn(context);
    await prepareExposure(context.context.queryClient);
  },
  validateSearch: (search: Record<string, unknown>) => ({ ...search, cursor: search.cursor }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: async ({ deps }): Promise<ContinueLoaderData> => ({
    address: continueAddress(deps),
    result: await readContinueEntries({ data: deps }),
  }),
  head: ({ match }) =>
    pageHead({ title: m.library_continue(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: ContinuePage,
});

function ContinuePage() {
  const locale = getLocale();
  const search = Route.useSearch();
  const loaderData = Route.useLoaderData();
  const location = useLocation();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const address = continueAddress({ cursor: search.cursor });
  const currentCursor = address.cursor ?? null;
  const routeState = location.state as { continueWindowVisit?: string } | undefined;
  const visitId = routeState?.continueWindowVisit;
  const sessionQuery = queryClient.getQueryCache().find({ queryKey: sessionQueryKey, exact: true });
  const sessionState = queryClient.getQueryState(sessionQueryKey);
  const owner = useMemo(
    () => continueWindowOwner(queryClient, locale, readContinueEntries),
    [queryClient, locale, sessionQuery, sessionState?.dataUpdateCount, sessionState?.dataUpdatedAt],
  );

  const requestOwner = useRef({ searchStr: location.searchStr, owner });
  if (requestOwner.current.searchStr !== location.searchStr)
    requestOwner.current = { searchStr: location.searchStr, owner };

  const loaderOwner = useRef({ data: loaderData, owner });
  if (loaderOwner.current.data !== loaderData)
    loaderOwner.current = {
      data: loaderData,
      owner: requestOwner.current.searchStr === location.searchStr ? requestOwner.current.owner : owner,
    };
  const loaderAddressMatches =
    loaderData.address.cursor === address.cursor && loaderData.address.malformed === address.malformed;
  const loaderOwnerMatches = sameContinueWindowOwner(loaderOwner.current.owner, owner);
  const savedVisit = queryClient.getQueryData<ContinueWindowVisit>(CONTINUE_WINDOW_QUERY_KEY);
  const savedVisitOwnerChanged =
    savedVisit !== undefined && savedVisit.visitId === visitId && !sameContinueWindowOwner(savedVisit.owner, owner);
  const initial = loaderAddressMatches && loaderOwnerMatches && !savedVisitOwnerChanged ? loaderData.result : undefined;
  const ownerChangedForLoader =
    (loaderOwner.current.data === loaderData && !loaderOwnerMatches) || savedVisitOwnerChanged;

  const read = useCallback(() => {
    if (address.malformed) return Promise.resolve({ state: 'unavailable', reason: 'invalid-address' } as const);
    return readContinueEntries({ data: { cursor: address.cursor } });
  }, [address.cursor, address.malformed]);
  const scope = useMemo(
    () => ({ queryClient, owner, address: `${locale}:${location.searchStr}` }),
    [queryClient, owner, locale, location.searchStr],
  );
  const resume = useContinueRefresh(initial, read, scope);
  useEffect(() => {
    if (ownerChangedForLoader) void resume.refresh();
  }, [ownerChangedForLoader, resume.refresh]);

  const visit = continueWindowVisit(queryClient, visitId, owner);
  const previous = continueWindowPrevious(visit, currentCursor);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [moving, setMoving] = useState(false);
  const movingRef = useRef(false);
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  void navigationRevision;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const saved = queryClient.getQueryData<ContinueWindowVisit>(CONTINUE_WINDOW_QUERY_KEY);
    if (!visitId || (saved && !sameContinueWindowOwner(saved.owner, owner))) {
      if (saved) retireContinueWindow(queryClient);
    }
  }, [queryClient, visitId, owner]);

  useLayoutEffect(() => {
    const retireReplacedOwner = () => {
      const saved = queryClient.getQueryData<ContinueWindowVisit>(CONTINUE_WINDOW_QUERY_KEY);
      if (!saved || sameContinueWindowOwner(saved.owner, continueWindowOwner(queryClient, locale, readContinueEntries)))
        return;
      retireContinueWindow(queryClient);
      movingRef.current = false;
      setMoving(false);
      setNavigationRevision((revision) => revision + 1);
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (isContinueSessionQuery(event.query.queryKey)) retireReplacedOwner();
    });
    retireReplacedOwner();
    return unsubscribe;
  }, [queryClient, locale]);

  useLayoutEffect(() => {
    if (address.malformed) {
      retireContinueWindow(queryClient);
      movingRef.current = false;
      setMoving(false);
      setNavigationRevision((revision) => revision + 1);
      return;
    }
    if (
      resume.result.state === 'unavailable' &&
      (resume.result.reason === 'invalid-address' || resume.result.reason === 'stale-address')
    ) {
      retireContinueWindow(queryClient);
      movingRef.current = false;
      setMoving(false);
      setNavigationRevision((revision) => revision + 1);
      return;
    }
    if (resume.result.state !== 'loaded') return;
    const accepted = acceptContinueWindow(queryClient, {
      visitId,
      owner,
      current: currentCursor,
      loaded: true,
    });
    if (accepted.committed) {
      movingRef.current = false;
      setMoving(false);
      setNavigationRevision((revision) => revision + 1);
      if (accepted.restoreHeadingFocus && document.activeElement === document.body) heading.current?.focus();
      return;
    }
    const currentVisit = continueWindowVisit(queryClient, visitId, owner);
    if (
      currentVisit?.staged &&
      currentCursor !== currentVisit.staged.target &&
      (currentCursor !== currentVisit.staged.from || !movingRef.current)
    ) {
      if (abandonContinueWindowStage(queryClient, visitId)) {
        movingRef.current = false;
        setMoving(false);
        setNavigationRevision((revision) => revision + 1);
      }
    }
  }, [address.malformed, queryClient, visitId, owner, currentCursor, resume.result]);

  const navigateWindow = useCallback(
    async (target: string | null, nextVisitId: string, replaceCurrent: boolean) => {
      await navigate({
        to: '/library/continue',
        search: (current) => {
          if (replaceCurrent) return current;
          const updated = { ...current };
          if (target === null) delete updated.cursor;
          else updated.cursor = target;
          return updated;
        },
        hash: location.hash.replace(/^#/, ''),
        state: (current) => ({ ...current, continueWindowVisit: nextVisitId }),
        replace: replaceCurrent,
      });
    },
    [navigate, location.hash],
  );

  const actions = useMemo<ContinueWindowAction[]>(() => {
    if (resume.result.state !== 'loaded' || address.malformed) return [];
    const options = { locale: locale as Locale };
    const actions: ContinueWindowAction[] = [];
    const href = (target: string | null) => continueCursorHref(locale, location.searchStr, location.hash, target);
    if (previous)
      actions.push({
        direction: 'previous',
        target: previous.target,
        href: href(previous.target),
        label: m.library_continue_previous_window({}, options),
      });
    if (currentCursor !== null)
      actions.push({
        direction: 'first',
        target: null,
        href: href(null),
        label: m.library_continue_first_window({}, options),
      });
    if (resume.result.next !== null)
      actions.push({
        direction: 'next',
        target: resume.result.next,
        href: href(resume.result.next),
        label: m.library_next_page({}, options),
      });
    return actions;
  }, [resume.result, address.malformed, locale, location.searchStr, location.hash, previous, currentCursor]);

  const moveWindow = useCallback(
    (action: ContinueWindowAction, restoreHeadingFocus: boolean) => {
      if (movingRef.current || visit?.staged || resume.result.state !== 'loaded' || address.malformed) return;
      const nextVisitId = visitId ?? crypto.randomUUID();
      movingRef.current = true;
      setMoving(true);
      if (
        !stageContinueWindow(queryClient, {
          visitId: nextVisitId,
          owner,
          current: currentCursor,
          target: action.target,
          direction: action.direction,
          restoreHeadingFocus,
        })
      ) {
        movingRef.current = false;
        setMoving(false);
        return;
      }
      setNavigationRevision((revision) => revision + 1);
      const run = async () => {
        try {
          if (!visitId) await navigateWindow(currentCursor, nextVisitId, true);
          await navigateWindow(action.target, nextVisitId, false);
        } finally {
          movingRef.current = false;
          if (mounted.current) setMoving(false);
        }
      };
      void run();
    },
    [visit?.staged, resume.result, address.malformed, visitId, queryClient, owner, currentCursor, navigateWindow],
  );

  const navigationAddress = `${locale}:${location.searchStr}`;
  const navigation = useCurrentLibraryNavigation(locale, 8, navigationAddress);
  return (
    <div className="container mx-auto max-w-7xl space-y-8 px-4 py-8">
      <PageHeading
        ref={heading}
        tabIndex={-1}
        className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {m.library_continue()}
      </PageHeading>
      <LibraryNavigation
        current="continue"
        locale={locale}
        pins={navigation.data?.pins ?? { state: 'closed' }}
        collections={navigation.data?.collections ?? []}
      />
      <HostedCheckpointBooks locale={locale} bookHref={hostedBookHref} />
      <ContinueSection
        destination
        newestHref={continueNewestHref(locale, location.searchStr, location.hash)}
        state={resume.result}
        locale={locale}
        onRetry={() => void resume.refresh()}
        busy={resume.busy}
        windowActions={actions}
        windowBusy={moving || !!visit?.staged}
        onWindowNavigate={moveWindow}
        onNewest={() => {
          retireContinueWindow(queryClient);
          movingRef.current = false;
          setMoving(false);
        }}
      />
    </div>
  );
}
