import { Fragment } from 'react';
import { useSearchWindow } from './search-window';
import { ReleaseWindowControls } from './release-window-controls';
import type { ReaderOrigin } from '../session/reader';
import { ReleaseChildWindow, useReleaseChildOwner } from './release-child-window';
import { ReleaseResultRow } from './release-child-row';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { discoveryMessage } from './discovery-results';
import { type ReleaseSearchState } from './release-search-query';
import { ReleaseSearchFormView } from './release-criteria-form';
import {
  releaseSearchHref,
  type ParsedReleaseSearch,
  type ReleaseSearchSelections,
  type ReleaseSearchType,
} from './release-search';

/** Grouped cards use server-confirmed current links and independent child cursors. */
export function ReleaseSearchPage({
  locale,
  parsed,
  types = [],
  selections,
  state,
  retryHref,
  reader,
}: {
  locale: string;
  parsed?: ParsedReleaseSearch;
  types?: ReleaseSearchType[];
  selections?: ReleaseSearchSelections;
  state: ReleaseSearchState;
  retryHref?: string;
  reader?: ReaderOrigin;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const current = () => !reader || reader.isCurrent();
  const page = current() && 'page' in state ? state.page : undefined;
  const next = page?.next ?? null;
  const pageEmpty = page?.status === 'ready' && page.groups.length === 0 && next !== null;
  const restartHref = parsed
    ? releaseSearchHref(locale, parsed.form)
    : (retryHref ?? `/${encodeURIComponent(locale)}/search/releases`);

  const visit = useSearchWindow({
    cursor: parsed?.search.cursor,
    href: (cursor) => (parsed ? releaseSearchHref(locale, parsed.form, cursor) : restartHref),
    isCurrent: current,
    locale,
    session: null,
    ready: page?.status === 'ready',
    preparing: page?.status === 'preparing',
    settled: state.status !== 'loading',
    checkpoint: page?.as_of,
    recoverable: state.status === 'unavailable' || state.status === 'preparing',
    enabled: !!parsed && !parsed.invalid.length,
  });

  const owner = useReleaseChildOwner(
    JSON.stringify([locale, parsed?.form, parsed?.search, parsed?.invalid, page ?? state.status]),
    reader,
  );

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <PageHeading>{m.release_search_heading({}, options)}</PageHeading>
      <p className="text-muted-foreground">{m.release_search_intro({}, options)}</p>
      {parsed && (
        <ReleaseSearchFormView
          key={JSON.stringify(parsed.form)}
          parsed={parsed}
          types={types}
          locale={locale}
          {...(selections ? { selections } : {})}
        />
      )}
      {parsed && (
        <ReleaseWindowControls
          visit={visit}
          locale={locale}
          cursor={parsed.search.cursor}
          next={next}
          status={state.status}
          enabled={state.status !== 'loading' && !parsed.invalid.length && current()}
        />
      )}
      <section
        ref={visit.regionRef}
        tabIndex={-1}
        aria-label={m.release_search_window_results({}, options)}
        aria-busy={state.status === 'loading' || visit.busy || undefined}
        data-release-group-results
      >
        {(!parsed?.invalid.length || parsed.invalid.every((field) => field === 'cursor')) && !page && (
          <div
            role={
              ['unavailable', 'restart', 'invalid', 'unsupported', 'denied'].includes(state.status) ? 'alert' : 'status'
            }
            data-search-recovery={state.status}
            aria-busy={state.status === 'loading'}
            className="grid justify-items-start gap-3 rounded-lg border p-4"
          >
            <p>{discoveryMessage(state.status, locale)}</p>
            {state.status !== 'loading' && state.status !== 'unavailable' && (
              <a href={restartHref} className={buttonVariants({ variant: 'outline' })}>
                {state.status === 'restart'
                  ? m.discovery_restart_action({}, options)
                  : m.search_facet_retry({}, options)}
              </a>
            )}
          </div>
        )}
        {pageEmpty && (
          <p role="status" className="text-sm text-muted-foreground">
            {m.release_search_page_empty({}, options)}
          </p>
        )}
        {page && page.status === 'preparing' && (
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {discoveryMessage('preparing', locale)}
          </p>
        )}
        {page && page.groups.length > 0 && (
          <ul role="list" data-slot="release-search-results" className="space-y-2">
            {page.groups.map((group) => {
              if (group.kind === 'release')
                return <ReleaseResultRow key={`release:${group.id}`} card={group.release} locale={locale} />;
              return (
                <Fragment key={`work:${group.id}`}>
                  <ReleaseResultRow card={group.work} locale={locale} />
                  <ReleaseChildWindow
                    key={owner.id}
                    owner={owner}
                    group={group}
                    locale={locale}
                    {...(parsed ? { parsed } : {})}
                    restartHref={restartHref}
                  />
                </Fragment>
              );
            })}
          </ul>
        )}
        {page && page.status === 'ready' && page.groups.length === 0 && next === null && !parsed?.search.cursor && (
          <p role="status" className="text-sm text-muted-foreground">
            {m.search_no_results({}, options)}
          </p>
        )}
        {page && page.status === 'ready' && (page.groups.length > 0 || parsed?.search.cursor) && next === null && (
          <p role="status" className="text-sm text-muted-foreground">
            {m.release_search_terminal({}, options)}
          </p>
        )}
      </section>
    </main>
  );
}
