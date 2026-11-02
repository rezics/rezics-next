import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOperation } from '../kernel/exposure';
import { sharedRatio } from '@rezics/ui/cover';
import { CoverCard, CoverRow, type CoverDensity } from '@rezics/ui/cover-card';
import { Button } from '@rezics/ui/shadcn/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { coverSrc } from '../media/cover-src';
import { coverOf, coverSubject } from '../media/summary';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { progressView } from './progress-label';
import { pageText } from '../features/pages/shared';
import { SectionHeading } from './section-heading';
import { continueRetryDelay, type ContinueEntry, type ContinueResult, type ContinueView } from './continue-source';
import { continueNewestHref } from './continue-address';

/**
 * What the visitor is in the middle of. Each card is a cover card: one link to carry on, on its title and stretched
 * over the whole card, named for what it does to that title, and a menu that opens the subject's page. The card
 * holds the cover, the title and one progress row. It uses the same scrollable cover row and card size at every
 * viewport, so it stays aligned with the catalogue rows.
 */
export function ContinueRow({
  entries,
  locale,
  density = 'medium',
  heading = true,
}: {
  entries: ContinueEntry[];
  locale: string;
  density?: CoverDensity;
  heading?: boolean;
}) {
  const admitted = useOperation('progress_session.list');
  const rowHost = useRef<HTMLDivElement>(null);
  const [canScrollBack, setCanScrollBack] = useState(false);
  const [canScrollForward, setCanScrollForward] = useState(false);
  const options = { locale: locale as Locale };
  const subjects = entries.map((entry) => ({
    entry,
    subject: coverSubject(entry.subjectId, entry.label, entry.summary),
  }));
  const ratio = sharedRatio(subjects.map(({ subject }) => subject));
  const cards = subjects.map(({ entry, subject }) => {
    const progress = progressView(entry.progress, locale);
    const progressLabel = progress?.text ?? entry.stateLabel;
    const localizedTitle = pageText(entry.language ? { [entry.language]: entry.label } : entry.label, locale);
    const title = localizedTitle.text || m.subject_value_unlabelled();
    const href = entry.progress
      ? `/${locale}/library/progress/${encodeURIComponent(entry.progress.sessionId)}`
      : `/${locale}/library/progress?subjectId=${encodeURIComponent(entry.subjectId)}`;
    return (
      <CoverCard
        key={entry.subjectId}
        density={density}
        {...(admitted ? { href } : {})}
        cover={{ subject, cover: coverOf(entry.summary), src: coverSrc }}
        title={title}
        {...(localizedTitle.lang ? { titleLang: localizedTitle.lang } : {})}
        linkLabel={m.home_continue_label({ title }, options)}
        {...(progressLabel
          ? {
              progress: {
                value: progress?.percent == null ? null : progress.percent / 100,
                label: progressLabel,
              },
            }
          : {})}
        menuLabel={m.home_continue_actions({ title }, options)}
        menuEntries={[
          {
            type: 'link',
            label: m.home_continue_open_subject({}, options),
            href: subjectHref({ id: entry.subjectId, label: title }, locale).href,
          },
        ]}
      />
    );
  });
  useEffect(() => {
    const row = rowHost.current?.querySelector<HTMLElement>('[data-slot="cover-row"]');
    if (!row) return;
    const update = () => {
      setCanScrollBack(row.scrollLeft > 1);
      setCanScrollForward(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    };
    update();
    row.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => {
      row.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [entries.length]);
  return (
    <>
      {heading ? <SectionHeading>{m.home_continue_heading()}</SectionHeading> : null}
      <div ref={rowHost} className="min-w-0 space-y-2">
        <CoverRow ratio={ratio} label={m.home_continue_heading()} density={density}>
          {cards}
        </CoverRow>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label={m.home_continue_previous()}
            aria-hidden={!canScrollBack}
            data-available={canScrollBack}
            tabIndex={canScrollBack ? 0 : -1}
            disabled={!canScrollBack}
            onClick={() =>
              rowHost.current?.querySelector('[data-slot="cover-row"]')?.scrollBy({ left: -240, behavior: 'smooth' })
            }
            className="pointer-fine:flex pointer-coarse:hidden hidden size-11 min-h-11 min-w-11 shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[available=false]:hidden"
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            aria-label={m.home_continue_next()}
            aria-hidden={!canScrollForward}
            data-available={canScrollForward}
            tabIndex={canScrollForward ? 0 : -1}
            disabled={!canScrollForward}
            onClick={() =>
              rowHost.current?.querySelector('[data-slot="cover-row"]')?.scrollBy({ left: 240, behavior: 'smooth' })
            }
            className="pointer-fine:flex pointer-coarse:hidden hidden size-11 min-h-11 min-w-11 shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[available=false]:hidden"
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>
    </>
  );
}

/** Retry preparation twice, respecting the producer's delay; unavailable reads never poll. */
export function useContinuePreparation(
  result: ContinueView | undefined,
  refresh: () => Promise<object>,
  scope: string,
) {
  const attempts = useRef(0);
  useEffect(() => {
    attempts.current = 0;
  }, [refresh, scope]);
  useEffect(() => {
    if (!result) return;
    const delay = continueRetryDelay(result, attempts.current);
    if (delay === null) return;
    const timer = setTimeout(() => {
      attempts.current += 1;
      void refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [result, refresh, scope]);
}

/** A loader result stays current across navigation; retry discards old personal data immediately. */
export function useContinueRefresh(
  initial: ContinueView | undefined,
  read: () => Promise<ContinueResult>,
  scope: string,
) {
  const lifetime = useMemo(() => ({ active: false, latestRequest: 0 }), [initial, scope]);
  useLayoutEffect(() => {
    lifetime.active = true;
    return () => {
      lifetime.active = false;
    };
  }, [lifetime]);
  const [snapshot, setSnapshot] = useState(() => ({ lifetime, result: initial, busy: false }));
  const current = snapshot.lifetime === lifetime;
  const result = (current ? snapshot.result : initial) ?? { state: 'unknown' as const };
  const busy = current && snapshot.busy;
  const refresh = useCallback(async () => {
    // A timeout or callback retained by a replaced view must not start another native read.
    if (!lifetime.active) return { state: 'unavailable' } as const;
    const request = ++lifetime.latestRequest;
    setSnapshot({ lifetime, result: { state: 'unknown' }, busy: true });
    let result: ContinueResult;
    try {
      result = await read();
    } catch {
      result = { state: 'unavailable' };
    }
    if (lifetime.active && lifetime.latestRequest === request) {
      setSnapshot((previous) =>
        previous.lifetime === lifetime && lifetime.latestRequest === request
          ? { lifetime, result, busy: false }
          : previous,
      );
    }
    return result;
  }, [lifetime, read]);
  useContinuePreparation(result, refresh, scope);
  return { result, busy, refresh };
}

/** The same honest personal region appears on Home, Library and Continue. */
export function ContinueSection({
  entries,
  state,
  locale,
  density = 'medium',
  onRetry,
  busy = false,
  destination = false,
  newestHref,
}: {
  /** Retained for existing component consumers that already have a successful page. */
  entries?: ContinueEntry[];
  state?: ContinueView;
  locale: string;
  density?: CoverDensity;
  onRetry?: () => void;
  busy?: boolean;
  destination?: boolean;
  newestHref?: string;
}) {
  const result = state ?? (entries ? { state: 'loaded', entries, next: null } : { state: 'unknown' });
  if (result.state === 'signed-out') return null;
  const options = { locale: locale as Locale };
  const title = m.home_continue_heading({}, options);
  const address =
    result.state === 'unavailable' && (result.reason === 'invalid-address' || result.reason === 'stale-address')
      ? result.reason
      : null;
  const message =
    address === 'invalid-address'
      ? m.library_continue_address_malformed({}, options)
      : address === 'stale-address'
        ? m.library_continue_address_expired({}, options)
        : result.state === 'loaded'
          ? m.library_continue_empty({}, options)
          : result.state === 'preparing'
            ? m.library_continue_preparing({}, options)
            : result.state === 'unknown'
              ? m.library_continue_loading({}, options)
              : result.state === 'denied'
                ? m.library_continue_denied({}, options)
                : m.library_continue_unavailable({}, options);
  return (
    <section aria-label={title} data-continue-state={result.state} className="min-w-0 max-w-full space-y-4">
      {!destination ? (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 basis-48 wrap-anywhere">
            <SectionHeading>{title}</SectionHeading>
          </div>
          <a
            href={`/${locale}/library/continue`}
            className="inline-flex min-h-11 min-w-0 max-w-full items-center rounded-sm px-2 py-2 text-sm whitespace-normal text-primary underline-offset-4 wrap-anywhere hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.library_more({}, options)}
          </a>
        </div>
      ) : null}
      {result.state === 'loaded' && result.entries.length > 0 ? (
        <ContinueRow entries={result.entries} locale={locale} density={density} heading={false} />
      ) : (
        <div
          className="min-w-0 rounded-lg border border-border p-6 sm:p-8"
          aria-busy={busy || result.state === 'unknown'}
        >
          <p
            role={result.state === 'unavailable' ? 'alert' : 'status'}
            className="text-sm leading-relaxed wrap-anywhere text-muted-foreground"
          >
            {message}
          </p>
          {address ? (
            <a
              href={newestHref ?? continueNewestHref(locale)}
              className="mt-4 inline-flex min-h-11 max-w-full items-center rounded-sm px-3 py-2 text-sm text-primary underline-offset-4 wrap-anywhere hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {m.library_continue_address_newest({}, options)}
            </a>
          ) : null}
          {!address && onRetry && (result.state === 'unavailable' || result.state === 'preparing') ? (
            <Button
              type="button"
              variant="outline"
              className="mt-4 h-auto min-h-11 max-w-full px-3 py-2 text-start whitespace-normal wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              disabled={busy}
              onClick={onRetry}
            >
              {m.library_follow_retry({}, options)}
            </Button>
          ) : null}
        </div>
      )}
      {destination && result.state === 'loaded' && result.next ? (
        <a
          href={`/${locale}/library/continue?cursor=${encodeURIComponent(result.next)}`}
          className="inline-flex min-h-11 min-w-0 max-w-full items-center rounded-sm px-2 py-2 text-sm whitespace-normal text-primary underline-offset-4 wrap-anywhere hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.library_next_page({}, options)}
        </a>
      ) : null}
    </section>
  );
}
