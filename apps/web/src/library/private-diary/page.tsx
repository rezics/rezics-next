import { useLocation, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useOperation } from '../application';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { useSession } from '../application';
import type { DiaryPage } from '@rezics/client';
import type { PrivateDiaryLoad, PrivateDiaryLoadResult } from './server';
import { cancelPrivateDiary } from './server';
import { PRIVATE_DIARY_PAGE_BYTES, PRIVATE_DIARY_PAGE_LIMIT } from './native';
import { ReadingOccurrence } from './reading-occurrence';
import { chronologicalGroups, recordedDayLabel } from './timeline';
import { ReadingPeriod } from './reading-period';
import { ReadingWorkspace } from './reading-workspace';
import { PrivateDiaryWindowNavigation } from './window-navigation';

type ReaderSession = ReturnType<typeof useSession>;
type NonPageDiaryRead = Exclude<PrivateDiaryLoad['diary'], { kind: 'ready' }>;
export type PrivateDiaryReadingLoadResult =
  | (Omit<PrivateDiaryLoad, 'diary'> & {
      diary: { kind: 'ready'; page: DiaryPage } | NonPageDiaryRead;
    })
  | Exclude<PrivateDiaryLoadResult, PrivateDiaryLoad>;

import { diarySearch, sameDiaryAddress, safeReturnTo, type DiaryAddress } from './address';
import { ReportedYearPanel } from './year-summary';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';

export function PrivateDiaryPage({
  loaded,
  session,
  returnTo,
  address = {},
}: {
  loaded: PrivateDiaryReadingLoadResult;
  session: ReaderSession;
  returnTo?: string | undefined;
  address?: DiaryAddress;
}) {
  const router = useRouter();
  const location = useLocation();
  const allowed = useOperation('progress_session.list');
  const [yearInput, setYearInput] = useState(address.year === undefined ? '' : String(address.year));
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const [closing, setClosing] = useState(false);
  const [closeRetry, setCloseRetry] = useState<{
    source: string;
    viewer: string;
    csrfToken: string;
    continuation: string;
  } | null>(null);
  const [replacementRetry, setReplacementRetry] = useState<{
    source: string;
    viewer: string;
    csrfToken: string;
    continuation: string;
  } | null>(null);
  const [windowVersion, setWindowVersion] = useState(0);
  const occurrencesHeading = useRef<HTMLHeadingElement>(null);
  const focusedReturn = useRef<{ request: string; done: boolean } | null>(null);
  const currentReturn = safeReturnTo(returnTo ?? address.returnTo);
  const load =
    allowed &&
    location.pathname.endsWith('/library/history') &&
    loaded.kind === 'ready' &&
    sameDiaryAddress(loaded.address, address) &&
    sameDiaryAddress(address, diarySearch(location.search)) &&
    session.state === 'signed-in' &&
    loaded.viewer === session.subject &&
    loaded.csrfToken === session.csrfToken;
  const authorizedLoad = load ? loaded : null;
  const authenticated = authorizedLoad !== null;
  const sourceKey = JSON.stringify([
    session.state,
    session.subject,
    session.csrfToken,
    allowed,
    loaded.kind === 'ready' ? loaded.viewer : null,
    loaded.kind === 'ready' ? loaded.csrfToken : null,
  ]);
  const navigationRef = useRef<PrivateDiaryWindowNavigation | null>(null);
  if (!navigationRef.current) navigationRef.current = new PrivateDiaryWindowNavigation(sourceKey);
  const navigation = navigationRef.current;
  if (navigation.source !== sourceKey) navigation.resetSource(sourceKey);
  const binding = useRef({ loaded, address, session, href: location.href, source: sourceKey });
  binding.current = { loaded, address, session, href: location.href, source: sourceKey };
  const retired =
    authorizedLoad?.diary.kind === 'retired' ||
    authorizedLoad?.summary.kind === 'retired' ||
    authorizedLoad?.reportedYear?.kind === 'retired';
  const page = !retired && authorizedLoad?.diary.kind === 'ready' ? authorizedLoad.diary.page : null;
  const yearSummary = authorizedLoad?.reportedYear;
  const currentPage =
    address.year === undefined ||
    (yearSummary?.kind === 'ready' &&
      page?.currentness?.revision === yearSummary.value.currentness.revision &&
      (address.snapshot === undefined || address.snapshot === page.currentness?.revision));
  const stalePage =
    authorizedLoad?.diary.kind === 'stale' ||
    (page !== null &&
      ((address.snapshot !== undefined && address.snapshot !== page.currentness?.revision) ||
        (address.year !== undefined &&
          yearSummary?.kind === 'ready' &&
          page.currentness?.revision !== yearSummary.value.currentness.revision)));
  const visiblePage = currentPage ? page : null;
  const pageRefusal =
    authorizedLoad?.diary.kind === 'denied' || authorizedLoad?.diary.kind === 'closed'
      ? authorizedLoad.diary.kind
      : page && !currentPage && (yearSummary?.kind === 'denied' || yearSummary?.kind === 'closed')
        ? yearSummary.kind
        : null;
  const admitted = authenticated && !retired && authorizedLoad?.diary.kind === 'ready' && page !== null && currentPage;
  const activeCloseRetry = closeRetry?.source === sourceKey ? closeRetry : null;
  const activeReplacementRetry = replacementRetry?.source === sourceKey ? replacementRetry : null;
  const navigationReady =
    admitted &&
    navigation.source === sourceKey &&
    navigation.canUse(address) &&
    !closing &&
    !activeCloseRetry &&
    !activeReplacementRetry;
  const previousAddress = navigationReady ? navigation.previousAddress() : null;
  const canStartFirst = navigationReady && navigation.canStartFirst(address);
  useEffect(() => {
    if (!address.focus) {
      focusedReturn.current = null;
      return;
    }
    const request = JSON.stringify([
      address.year,
      address.month,
      address.cursor,
      address.snapshot,
      address.focus,
    ]);
    let focusRequest: { request: string; done: boolean };
    if (focusedReturn.current?.request === request) {
      focusRequest = focusedReturn.current;
    } else {
      focusRequest = { request, done: false };
      focusedReturn.current = focusRequest;
    }
    if (focusRequest.done) return;
    if (visiblePage?.occurrences.some((row) => row.id === address.focus)) {
      const target = document.getElementById('diary-occurrence-' + address.focus);
      if (target) {
        target.focus();
        focusRequest.done = true;
      }
    }
  }, [visiblePage, address.focus, address.year, address.month, address.cursor, address.snapshot]);
  useEffect(() => {
    const change = navigation.observe({
      source: sourceKey,
      address,
      admitted: Boolean(admitted),
      continuation: page?.continuation,
      load: loaded,
      retire: retired || stalePage || pageRefusal !== null,
    });
    if (change.changed) setWindowVersion((version) => version + 1);
    if (change.focus && admitted && navigation.canUse(address) && location.pathname.endsWith('/library/history'))
      occurrencesHeading.current?.focus();
    if (change.cancelContinuation && authorizedLoad) {
      const identity = authorizedLoad;
      const expected = binding.current;
      const continuation = change.cancelContinuation;
      void cancelPrivateDiary({
        data: { viewer: identity.viewer, csrfToken: identity.csrfToken, continuation },
      })
        .catch(() => 'unavailable' as const)
        .then((result) => {
          const current = binding.current;
          if (
            !live.current ||
            current.href !== expected.href ||
            current.loaded !== expected.loaded ||
            current.source !== expected.source ||
            current.session.subject !== expected.session.subject ||
            current.session.csrfToken !== expected.session.csrfToken ||
            !navigation.canUse(current.address)
          )
            return;
          if (result === 'unavailable')
            setReplacementRetry({
              source: sourceKey,
              viewer: identity.viewer,
              csrfToken: identity.csrfToken,
              continuation,
            });
        });
    }
  }, [
    admitted,
    address,
    authorizedLoad,
    loaded,
    location.href,
    location.pathname,
    navigation,
    page?.continuation,
    pageRefusal,
    retired,
    sourceKey,
    stalePage,
    windowVersion,
  ]);
  useEffect(() => {
    if (retired) window.location.assign(currentReturn);
  }, [currentReturn, retired]);

  useEffect(() => {
    setCloseRetry(null);
    setReplacementRetry(null);
  }, [sourceKey]);

  function moveWindow(movement: 'next' | 'previous' | 'first', target: DiaryAddress, focus: boolean) {
    if (!navigationReady || !navigation.stage(movement, { ...target, returnTo: currentReturn }, focus)) return;
    setWindowVersion((version) => version + 1);
    void router.navigate({
      to: '/library/history',
      replace: true,
      search: { ...target, returnTo: currentReturn },
    });
  }

  async function retryReplacementCancellation() {
    if (!activeReplacementRetry || !authorizedLoad) return;
    const attempt = activeReplacementRetry;
    const expected = binding.current;
    const result = await cancelPrivateDiary({
      data: { viewer: attempt.viewer, csrfToken: attempt.csrfToken, continuation: attempt.continuation },
    }).catch(() => 'unavailable' as const);
    const current = binding.current;
    if (
      !live.current ||
      current.href !== expected.href ||
      current.loaded !== expected.loaded ||
      current.source !== expected.source ||
      current.session.subject !== expected.session.subject ||
      current.session.csrfToken !== expected.session.csrfToken
    )
      return;
    if (result !== 'unavailable') setReplacementRetry(null);
  }

  async function closeDiary() {
    const continuation = activeCloseRetry?.continuation ?? navigation.continuation ?? page?.continuation;
    if (!authorizedLoad || retired || !continuation || closing) {
      window.location.assign(currentReturn);
      return;
    }
    const identity = activeCloseRetry ?? {
      source: sourceKey,
      viewer: authorizedLoad.viewer,
      csrfToken: authorizedLoad.csrfToken,
      continuation,
    };
    const expected = binding.current;
    setClosing(true);
    const result = await cancelPrivateDiary({
      data: {
        viewer: identity.viewer,
        csrfToken: identity.csrfToken,
        continuation: identity.continuation,
      },
    }).catch(() => 'unavailable' as const);
    const current = binding.current;
    if (
      !live.current ||
      current.href !== expected.href ||
      current.loaded !== expected.loaded ||
      current.source !== expected.source ||
      current.session.subject !== expected.session.subject ||
      current.session.csrfToken !== expected.session.csrfToken ||
      !sameDiaryAddress(current.address, expected.address)
    )
      return;
    setClosing(false);
    if (result === 'unavailable') {
      setCloseRetry(identity);
      return;
    }
    setCloseRetry(null);
    window.location.assign(currentReturn);
  }

  const routeNavigationAvailable = !closing && !activeCloseRetry && !activeReplacementRetry;

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">{m.library_diary_heading()}</h1>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={closing}
              onClick={() => void closeDiary()}
            >
              {closing
                ? m.library_diary_closing()
                : activeCloseRetry
                  ? m.library_selection_retry()
                  : m.library_diary_return()}
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{m.library_diary_help()}</p>
        {activeCloseRetry || activeReplacementRetry ? (
          <p role="status">{m.library_diary_cancel_unavailable()}</p>
        ) : null}
        {activeReplacementRetry ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void retryReplacementCancellation()}
          >
            {m.library_selection_retry()}
          </Button>
        ) : null}
      </header>

      {retired ? (
        <p role="status" className="rounded-md border p-4">
          {m.library_diary_session_ended()}
        </p>
      ) : null}

      {authenticated && !retired && routeNavigationAvailable ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const selection = diarySearch({ year: yearInput });
            if (selection.year !== undefined)
              void router.navigate({
                to: '/library/history',
                search: { year: selection.year, returnTo: currentReturn },
              });
          }}
        >
          <label className="block">
            <span className="mb-1 block text-sm font-medium">{m.library_diary_year_select()}</span>
            <Input
              className='w-32'
              inputMode="numeric"
              pattern="[0-9]{1,4}"
              required
              value={yearInput}
              onChange={(event) => setYearInput(event.currentTarget.value)}
            />
          </label>
          <Button type="submit" variant="outline">
            {m.library_diary_year_show()}
          </Button>
          <Link
            className={buttonVariants({ variant: 'outline', className: 'h-auto min-h-7 max-w-full whitespace-normal [overflow-wrap:anywhere]' })}
            to="/library/history"
            search={{ returnTo: currentReturn }}
          >
            {m.library_diary_all_time()}
          </Link>
        </form>
      ) : null}
      {!authenticated ? (
        <p role="status" className="rounded-md border p-4">
          {m.library_diary_unavailable()}
        </p>
      ) : retired ? null : (
        <ReadingWorkspace
          periodContext={
            routeNavigationAvailable && authorizedLoad ? (
              <div className="min-w-0 space-y-4">
                <ReadingPeriod
                  address={address}
                  returnTo={currentReturn}
                  allTime={authorizedLoad.summary}
                  reportedYear={authorizedLoad.reportedYear}
                  retry={() => void router.invalidate()}
                />
                {address.year !== undefined ? (
                  <details
                    className={[
                      'min-w-0 [&_h2]:sr-only [&_dl]:min-w-0 [&_dt]:[overflow-wrap:anywhere]',
                      '[&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_a]:min-w-0 [&_a]:max-w-full',
                      '[&_a]:whitespace-normal [&_a]:[overflow-wrap:anywhere] [&_p]:[overflow-wrap:anywhere]',
                    ].join(' ')}
                  >
                    <summary className={buttonVariants({ variant: 'outline', className: 'h-auto min-h-7 max-w-full cursor-pointer whitespace-normal [overflow-wrap:anywhere]' })}>
                      {m.library_diary_year_heading({ year: address.year })}
                    </summary>
                    <div className="mt-3 min-w-0">
                      <ReportedYearPanel
                        year={address.year}
                        address={{ ...address, returnTo: currentReturn }}
                        result={authorizedLoad.reportedYear ?? { kind: 'unavailable' }}
                        retry={() => void router.invalidate()}
                      />
                    </div>
                  </details>
                ) : null}
              </div>
            ) : null
          }
          timeline={
            visiblePage ? (
              <section aria-labelledby="library-diary-occurrences" className="min-w-0 space-y-4">
                <h2
                  id="library-diary-occurrences"
                  ref={occurrencesHeading}
                  tabIndex={-1}
                  className="h-auto min-w-0 text-lg font-semibold [overflow-wrap:anywhere]"
                >
                  {m.library_diary_occurrences()}
                </h2>
                {visiblePage.occurrences.length === 0 ? (
                  <div className="min-w-0 space-y-3 rounded-xl border border-dashed p-6 sm:p-8">
                    <p className="font-medium">{m.library_diary_page_empty()}</p>
                    {!address.cursor && !visiblePage.next && address.year === undefined ? (
                      <>
                        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
                          {m.library_history_first_use()}
                        </p>
                        <Link
                          to="/library"
                          className={buttonVariants({ variant: 'outline', className: 'h-auto min-h-7 max-w-full whitespace-normal [overflow-wrap:anywhere]' })}
                        >
                          {m.library_history_open_library()}
                        </Link>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <div className="min-w-0 space-y-7">
                    {chronologicalGroups(visiblePage.occurrences, (row) => row.recordedStartedAt).map((group) => (
                      <section
                        key={`${group.date}:${group.offset}`}
                        aria-label={recordedDayLabel(group.date, getLocale())}
                        className="min-w-0 space-y-3"
                      >
                        <p className="flex min-w-0 items-center gap-3 text-sm font-medium text-muted-foreground">
                          <time dateTime={group.date} className="h-auto min-w-0 [overflow-wrap:anywhere]">
                            {recordedDayLabel(group.date, getLocale())}
                          </time>
                          <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-border" />
                        </p>
                        <ol className="min-w-0 space-y-3">
                          {group.rows.map((occurrence, index) => (
                            <ReadingOccurrence
                              key={`${group.date}:${group.offset + index}:${occurrence.id}`}
                              occurrence={occurrence}
                              page={visiblePage}
                              address={address}
                              returnTo={currentReturn}
                              position={group.offset + index + 1}
                              total={visiblePage.occurrences.length}
                            />
                          ))}
                        </ol>
                      </section>
                    ))}
                  </div>
                )}
              </section>
            ) : null
          }
          recovery={
            stalePage ? (
              <section className="min-w-0 rounded-md border p-4">
                <p>{m.library_diary_stale()}</p>
                <Link
                  className={buttonVariants({ variant: 'outline', className: 'mt-2 h-auto min-h-7 max-w-full whitespace-normal [overflow-wrap:anywhere]' })}
                  to="/library/history"
                  search={{
                    year: address.year,
                    month: address.month,
                    returnTo: currentReturn,
                  }}
                >
                  {m.library_diary_restart()}
                </Link>
              </section>
            ) : pageRefusal ? (
              <p role="status" className="h-auto min-w-0 rounded-md border p-4 [overflow-wrap:anywhere]">
                {pageRefusal === 'closed' ? m.platform_closed_message() : m.ctxw_denied()}
              </p>
            ) : authorizedLoad?.diary.kind === 'unavailable' || (page && !currentPage) ? (
              <section className="min-w-0 rounded-md border p-4">
                <p>{m.library_diary_read_unavailable()}</p>
                <Button
                  type="button"
                  variant="outline" className='h-auto min-h-7 mt-2 max-w-full [overflow-wrap:anywhere]'
                  onClick={() => void router.invalidate()}
                >
                  {m.library_selection_retry()}
                </Button>
              </section>
            ) : null
          }
          windowNavigation={
            visiblePage ? (
              <section className="min-w-0 space-y-3">
                <div className="flex min-w-0 flex-wrap gap-2">
                  {navigationReady ? (
                    <>
                      {previousAddress ? (
                        <Button
                          type="button"
                          variant="outline" className='h-auto min-h-7 max-w-full [overflow-wrap:anywhere]'
                          onClick={(event) => moveWindow('previous', previousAddress, event.detail === 0)}
                        >
                          {m.library_continue_previous_window()}
                        </Button>
                      ) : null}
                      {canStartFirst ? (
                        <Button
                          type="button"
                          variant="outline" className='h-auto min-h-7 max-w-full [overflow-wrap:anywhere]'
                          onClick={(event) =>
                            moveWindow(
                              'first',
                              {
                                year: address.year,
                                month: address.month,
                                snapshot: address.snapshot,
                              },
                              event.detail === 0,
                            )
                          }
                        >
                          {m.library_continue_first_window()}
                        </Button>
                      ) : null}
                      {visiblePage.next ? (
                        <Button
                          type="button"
                          variant="outline" className='h-auto min-h-7 max-w-full [overflow-wrap:anywhere]'
                          onClick={(event) =>
                            moveWindow(
                              'next',
                              {
                                cursor: visiblePage.next!,
                                year: address.year,
                                month: address.month,
                                snapshot: address.snapshot,
                              },
                              event.detail === 0,
                            )
                          }
                        >
                          {m.library_diary_next()}
                        </Button>
                      ) : (
                        <p className="h-auto min-w-0 self-center text-sm text-muted-foreground [overflow-wrap:anywhere]">
                          {m.library_diary_end()}
                        </p>
                      )}
                    </>
                  ) : null}
                </div>
                {visiblePage.occurrences.length ? (
                  <aside
                    aria-label={m.library_history_window_details()}
                    className="h-auto min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]"
                  >
                    {m.library_diary_page_bound({
                      count: Math.min(PRIVATE_DIARY_PAGE_LIMIT, visiblePage.occurrences.length),
                      bytes: PRIVATE_DIARY_PAGE_BYTES,
                    })}
                  </aside>
                ) : null}
              </section>
            ) : null
          }
        />
      )}
    </main>
  );
}
