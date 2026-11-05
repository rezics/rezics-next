import { Fragment, useEffect, useRef, useState } from 'react';
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
  const page = 'page' in state ? state.page : undefined;
  const next = page?.next ?? null;
  const pageEmpty = page !== undefined && page.groups.length === 0 && next !== null;
  const restartHref = parsed
    ? releaseSearchHref(locale, parsed.form)
    : (retryHref ?? `/${encodeURIComponent(locale)}/search/releases`);

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
      {(!parsed?.invalid.length || parsed.invalid.every((field) => field === 'cursor')) && !page && (
        <div
          role={
            ['unavailable', 'restart', 'invalid', 'unsupported', 'denied'].includes(state.status) ? 'alert' : 'status'
          }
          aria-busy={state.status === 'loading'}
          className="grid justify-items-start gap-3 rounded-lg border p-4"
        >
          <p>{discoveryMessage(state.status, locale)}</p>
          {state.status !== 'loading' && (
            <a href={restartHref} className={buttonVariants({ variant: 'outline' })}>
              {state.status === 'restart' ? m.discovery_restart_action({}, options) : m.search_facet_retry({}, options)}
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
      {next && parsed && (
        <nav aria-label={m.release_search_pagination({}, options)}>
          <a className={buttonVariants({ variant: 'outline' })} href={releaseSearchHref(locale, parsed.form, next)}>
            {page?.status === 'preparing' ? m.search_facet_retry({}, options) : m.release_search_continue({}, options)}
          </a>
        </nav>
      )}
    </main>
  );
}
