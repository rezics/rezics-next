import { useLocation, useRouter } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useOperation } from '../../kernel/exposure';
import { m } from '../../paraglide/messages.js';
import type { useSession } from '../../session/query';
import type { DiaryPage } from '@rezics/client';
import type { PrivateDiaryLoad, PrivateDiaryLoadResult } from './server';
import { cancelPrivateDiary } from './server';
import { PRIVATE_DIARY_PAGE_BYTES, PRIVATE_DIARY_PAGE_LIMIT } from './native';
import { ReadingOccurrence } from './reading-occurrence';
import { ReadingPeriod } from './reading-period';
import { PrivateDiaryWindowNavigation } from './window-navigation';

type ReaderSession = ReturnType<typeof useSession>;
const useReviewCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
type NonPageDiaryRead = Exclude<PrivateDiaryLoad['diary'], { kind: 'ready' }>;
export type PrivateDiaryReadingLoadResult =
  | (Omit<PrivateDiaryLoad, 'diary'> & {
      diary: { kind: 'ready'; page: DiaryPage } | NonPageDiaryRead;
    })
  | Exclude<PrivateDiaryLoadResult, PrivateDiaryLoad>;

import { diarySearch, diaryReturnContext, sameDiaryAddress, safeReturnTo, type DiaryAddress } from './address';
import { ReportedYearPanel } from './year-summary';

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
  const reviewIdentity = {
    loaded,
    authorizedLoad,
    page: visiblePage,
    year: address.year,
    month: address.month,
    cursor: address.cursor,
    snapshot: address.snapshot,
  };
  const previousReviewIdentity = useRef(reviewIdentity);
  const [reviewGeneration, setReviewGeneration] = useState(0);
  useReviewCommitEffect(() => {
    const previous = previousReviewIdentity.current;
    if (
      previous.loaded === loaded &&
      previous.authorizedLoad === authorizedLoad &&
      previous.page === visiblePage &&
      previous.year === address.year &&
      previous.month === address.month &&
      previous.cursor === address.cursor &&
      previous.snapshot === address.snapshot
    )
      return;
    previousReviewIdentity.current = reviewIdentity;
    setReviewGeneration((generation) => generation + 1);
  }, [loaded, authorizedLoad, visiblePage, address.year, address.month, address.cursor, address.snapshot]);
  const reviewPageKey = `${authorizedLoad?.viewer ?? 'unavailable'}:${reviewGeneration}`;
  useEffect(() => {
    if (visiblePage && address.focus && visiblePage.occurrences.some((row) => row.id === address.focus))
      document.getElementById('diary-occurrence-' + address.focus)?.focus();
  }, [visiblePage, address.focus]);
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
            <button
              type="button"
              className="min-h-11 rounded-md border px-3"
              disabled={closing}
              onClick={() => void closeDiary()}
            >
              {closing
                ? m.library_diary_closing()
                : activeCloseRetry
                  ? m.library_selection_retry()
                  : m.library_diary_return()}
            </button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{m.library_diary_help()}</p>
        {activeCloseRetry || activeReplacementRetry ? (
          <p role="status">{m.library_diary_cancel_unavailable()}</p>
        ) : null}
        {activeReplacementRetry ? (
          <button
            type="button"
            className="min-h-11 rounded-md border px-3"
            onClick={() => void retryReplacementCancellation()}
          >
            {m.library_selection_retry()}
          </button>
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
            <input
              className="min-h-11 w-32 rounded-md border bg-background px-3"
              inputMode="numeric"
              pattern="[0-9]{1,4}"
              required
              value={yearInput}
              onChange={(event) => setYearInput(event.currentTarget.value)}
            />
          </label>
          <button type="submit" className="min-h-11 rounded-md border px-3">
            {m.library_diary_year_show()}
          </button>
          <Link
            className="inline-flex min-h-11 items-center rounded-md border px-3"
            to="/library/history"
            search={{ returnTo: currentReturn }}
          >
            {m.library_diary_all_time()}
          </Link>
        </form>
      ) : null}
      {address.year !== undefined && authenticated && !retired && routeNavigationAvailable ? (
        <ReportedYearPanel
          year={address.year}
          address={{ ...address, returnTo: currentReturn }}
          result={authorizedLoad?.reportedYear ?? { kind: 'unavailable' }}
          retry={() => void router.invalidate()}
        />
      ) : null}
      {authenticated && !retired && authorizedLoad && routeNavigationAvailable ? (
        <ReadingPeriod
          address={address}
          returnTo={currentReturn}
          allTime={authorizedLoad.summary}
          reportedYear={authorizedLoad.reportedYear}
          retry={() => void router.invalidate()}
        />
      ) : null}

      {!authenticated ? (
        <p role="status" className="rounded-md border p-4">
          {m.library_diary_unavailable()}
        </p>
      ) : retired ? null : stalePage ? (
        <section className="rounded-md border p-4">
          <p>{m.library_diary_stale()}</p>
          <Link
            className="mt-2 inline-flex min-h-11 items-center rounded-md border px-3"
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
        <p role="status" className="rounded-md border p-4">
          {pageRefusal === 'closed' ? m.platform_closed_message() : m.ctxw_denied()}
        </p>
      ) : authorizedLoad?.diary.kind === 'unavailable' || (page && !currentPage) ? (
        <section className="rounded-md border p-4">
          <p>{m.library_diary_read_unavailable()}</p>
          <button
            type="button"
            className="mt-2 min-h-11 rounded-md border px-3"
            onClick={() => void router.invalidate()}
          >
            {m.library_selection_retry()}
          </button>
        </section>
      ) : visiblePage ? (
        <section aria-labelledby="library-diary-occurrences" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 id="library-diary-occurrences" ref={occurrencesHeading} tabIndex={-1} className="text-lg font-semibold">
              {m.library_diary_occurrences()}
            </h2>
            <p className="text-sm text-muted-foreground">
              {m.library_diary_page_bound({
                count: Math.min(PRIVATE_DIARY_PAGE_LIMIT, visiblePage.occurrences.length),
                bytes: PRIVATE_DIARY_PAGE_BYTES,
              })}
            </p>
          </div>
          {visiblePage.occurrences.length === 0 ? (
            <p className="rounded-md border p-4">{m.library_diary_page_empty()}</p>
          ) : (
            <ol className="space-y-3">
              {visiblePage.occurrences.map((occurrence) => (
                <ReadingOccurrence
                  key={`${reviewPageKey}:${occurrence.id}`}
                  occurrence={occurrence}
                  page={visiblePage}
                  address={address}
                  returnTo={currentReturn}
                />
              ))}
            </ol>
          )}
          <div className="flex flex-wrap gap-2">
            {navigationReady ? (
              <>
                {previousAddress ? (
                  <button
                    type="button"
                    className="min-h-11 rounded-md border px-4"
                    onClick={(event) => moveWindow('previous', previousAddress, event.detail === 0)}
                  >
                    {m.library_continue_previous_window()}
                  </button>
                ) : null}
                {canStartFirst ? (
                  <button
                    type="button"
                    className="min-h-11 rounded-md border px-4"
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
                  </button>
                ) : null}
                {visiblePage.next ? (
                  <button
                    type="button"
                    className="min-h-11 rounded-md border px-4"
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
                  </button>
                ) : (
                  <p className="self-center text-sm text-muted-foreground">{m.library_diary_end()}</p>
                )}
              </>
            ) : null}
          </div>
        </section>
      ) : null}
    </main>
  );
}
