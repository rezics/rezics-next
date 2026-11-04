import { useLocation, useRouter } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useOperation } from '../../kernel/exposure';
import { m } from '../../paraglide/messages.js';
import type { useSession } from '../../session/query';
import type { PrivateDiaryLoadResult } from './server';
import { cancelPrivateDiary } from './server';
import { PRIVATE_DIARY_PAGE_BYTES, PRIVATE_DIARY_PAGE_LIMIT } from './native';
import { ReadingOccurrence } from './reading-occurrence';
import { ReadingPeriod } from './reading-period';

type ReaderSession = ReturnType<typeof useSession>;
const useReviewCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

import { diarySearch, diaryReturnContext, sameDiaryAddress, safeReturnTo, type DiaryAddress } from './address';
import { ReportedYearPanel } from './year-summary';

export function PrivateDiaryPage({
  loaded,
  session,
  returnTo,
  address = {},
}: {
  loaded: PrivateDiaryLoadResult;
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
  const binding = useRef({ loaded, address, session, href: location.href });
  binding.current = { loaded, address, session, href: location.href };
  const [closing, setClosing] = useState(false);
  const [closeUnavailable, setCloseUnavailable] = useState(false);
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
    if (retired) window.location.assign(currentReturn);
  }, [currentReturn, retired]);

  async function closeDiary() {
    if (!authorizedLoad || retired || !page?.continuation || closing) {
      window.location.assign(currentReturn);
      return;
    }
    setClosing(true);
    const result = await cancelPrivateDiary({
      data: {
        viewer: authorizedLoad.viewer,
        csrfToken: authorizedLoad.csrfToken,
        continuation: page.continuation,
      },
    }).catch(() => 'unavailable' as const);
    const current = binding.current;
    if (
      !live.current ||
      current.href !== location.href ||
      current.loaded !== loaded ||
      current.session.subject !== session.subject ||
      current.session.csrfToken !== session.csrfToken ||
      !sameDiaryAddress(current.address, address)
    )
      return;
    setClosing(false);
    if (result === 'unavailable') {
      setCloseUnavailable(true);
      return;
    }
    setCloseUnavailable(false);
    window.location.assign(currentReturn);
  }

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
              {closing ? m.library_diary_closing() : m.library_diary_return()}
            </button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{m.library_diary_help()}</p>
        {closeUnavailable ? <p role="status">{m.library_diary_cancel_unavailable()}</p> : null}
      </header>

      {retired ? (
        <p role="status" className="rounded-md border p-4">
          {m.library_diary_session_ended()}
        </p>
      ) : null}

      {authenticated && !retired ? (
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
      {address.year !== undefined && authenticated && !retired ? (
        <ReportedYearPanel
          year={address.year}
          address={{ ...address, returnTo: currentReturn }}
          result={authorizedLoad?.reportedYear ?? { kind: 'unavailable' }}
          retry={() => void router.invalidate()}
        />
      ) : null}
      {authenticated && !retired && authorizedLoad ? (
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
            <h2 id="library-diary-occurrences" className="text-lg font-semibold">
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
          {visiblePage.next ? (
            <Link
              className="inline-flex min-h-11 items-center rounded-md border px-4"
              to="/library/history"
              replace
              search={{
                cursor: visiblePage.next,
                year: address.year,
                month: address.month,
                snapshot: address.snapshot,
                returnTo: currentReturn,
              }}
            >
              {m.library_diary_next()}
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">{m.library_diary_end()}</p>
          )}
        </section>
      ) : null}
    </main>
  );
}
