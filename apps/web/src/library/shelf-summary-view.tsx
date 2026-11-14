import { m } from '../paraglide/messages.js';
import { getLocale, locales } from '../paraglide/runtime.js';
import { Exposure } from '../kernel/exposure';
import { shelfHref, type ShelfPresentationIntent } from './shelf-params';
import { libraryNavigation } from './navigation';
import type { PersonalLibraryView } from './entries-read';
import type { ShelfSummaryState } from './shelf-summary-observation';

export type ShelfSummaryPresentation = { page: ShelfSummaryState; retry: () => unknown };
const target =
  'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2';
const firstUseImports = libraryNavigation.filter(
  (destination) =>
    destination.kind === 'navigation' &&
    destination.id.startsWith('library.import-') &&
    destination.signedIn === true &&
    destination.operation === 'library_entry.put' &&
    typeof destination.href === 'string',
);

export function shelfSummaryFirstUse(
  summary: ShelfSummaryState | undefined,
  page: PersonalLibraryView,
  cursor?: string,
) {
  return (
    page.signedIn &&
    !page.readState &&
    !page.type &&
    !page.state &&
    !cursor &&
    page.entries.length === 0 &&
    page.next === null &&
    summary?.state === 'loaded' &&
    summary.summary.tabs.all.total === 0
  );
}

export function ShelfSummaryCount({ page, locale }: { page: ShelfSummaryState; locale: string }) {
  if (page.state !== 'loaded') return null;
  const { shown, total } = page.summary.tabs.all;
  const number = new Intl.NumberFormat(locale);
  return (
    <span className="ml-2 text-base font-normal text-muted-foreground">
      {m.library_summary_count({ shown: number.format(shown), total: number.format(total) })}
    </span>
  );
}

/** Count navigation is separate from the eight Collection pins and never substitutes for profile controls. */
export function ShelfSummaryNavigation({
  summary,
  locale,
  view,
}: {
  summary: ShelfSummaryPresentation;
  locale: string;
  view: ShelfPresentationIntent;
}) {
  const { page, retry } = summary;
  const labels = {
    all: m.library_state_all(),
    in_progress: m.library_state_in_progress(),
    planned: m.library_state_planned(),
    completed: m.library_state_completed(),
    paused: m.library_state_paused(),
    dropped: m.library_state_dropped(),
    collections: m.library_nav_collections(),
  };
  const number = new Intl.NumberFormat(locale);
  const { cursor: _cursor, state: _state, ...selection } = view;
  const message =
    page.state === 'loaded'
      ? null
      : page.state === 'preparing'
        ? m.library_summary_preparing()
        : page.state === 'stale'
          ? m.library_summary_stale()
          : page.state === 'closed'
            ? m.platform_closed_message()
            : page.state === 'denied'
              ? m.library_sort_denied()
              : page.state === 'signed-out'
                ? m.library_sign_in()
                : m.library_summary_unavailable();
  return (
    <div className="min-w-0 space-y-2" data-shelf-status-strip>
      <nav aria-label={m.library_summary_heading()} className="min-w-0 overflow-x-auto border-b">
        <ul className="flex w-max min-w-full gap-1">
          {(Object.keys(labels) as (keyof typeof labels)[]).map((bucket) => {
            const counts = page.state === 'loaded' ? page.summary.tabs[bucket] : null;
            const current = bucket === (view.state ?? 'all');
            const link = (
              <li key={bucket}>
                <a
                  className={`inline-flex min-h-11 items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-[-2px] ${current ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}`}
                  href={
                    bucket === 'collections'
                      ? `/${locale}/library/collections`
                      : shelfHref(locale, { ...selection, ...(bucket === 'all' ? {} : { state: bucket }) })
                  }
                  aria-current={current ? 'page' : undefined}
                >
                  <span>{labels[bucket]}</span>
                  {counts ? (
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs tabular-nums">
                      {m.library_summary_count({
                        shown: number.format(counts.shown),
                        total: number.format(counts.total),
                      })}
                    </span>
                  ) : null}
                </a>
              </li>
            );
            return bucket === 'collections' ? (
              <Exposure key={bucket} operation="collection.list">
                {link}
              </Exposure>
            ) : (
              link
            );
          })}
        </ul>
      </nav>
      {message ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" role="status">
          <p>{message}</p>
          {['unavailable', 'preparing', 'stale'].includes(page.state) ? (
            <button type="button" className={target} onClick={() => void retry()}>
              {m.library_summary_retry()}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ShelfSummaryFirstUseLinks({ locale }: { locale: string }) {
  const messageLocale = locales.find((supported) => supported === locale) ?? getLocale();
  return (
    <div className="space-y-3">
      <p>{m.library_summary_first_use_guidance({}, { locale: messageLocale })}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <a className={target} href={`/${locale}/search`}>
          {m.library_browse({}, { locale: messageLocale })}
        </a>
        <Exposure operation="library_label.list">
          <a className={target} href={`/${locale}/library/labels`}>
            {m.library_nav_labels({}, { locale: messageLocale })}
          </a>
        </Exposure>
        <Exposure operation="collection.list">
          <a className={target} href={`/${locale}/library/collections`}>
            {m.library_nav_collections({}, { locale: messageLocale })}
          </a>
        </Exposure>
      </div>
      {firstUseImports.length ? (
        <Exposure operation="library_entry.put">
          <nav aria-label={m.library_summary_first_use_imports({}, { locale: messageLocale })}>
            <ul className="flex flex-wrap justify-center gap-2">
              {firstUseImports.map((destination) =>
                typeof destination.href === 'string' ? (
                  <li key={destination.id}>
                    <a className={target} href={`/${locale}${destination.href}`}>
                      {typeof destination.label === 'string'
                        ? destination.label
                        : destination.label({ locale: messageLocale, pathname: destination.href })}
                    </a>
                  </li>
                ) : null,
              )}
            </ul>
          </nav>
        </Exposure>
      ) : null}
    </div>
  );
}
