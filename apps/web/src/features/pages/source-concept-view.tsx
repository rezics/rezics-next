import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { candidateFailure, type CandidateFailure } from '../../subject/candidates';
import { subjectHref } from '../../subject/subject-href';
import { catalogueEntries } from '../catalogue/catalogue-entry';
import {
  appendChangePage,
  changePageHistoryLimit,
  firstChangePage,
  type ChangePageHistory,
} from '../catalogue/subject-changes-navigation';
import type { ConceptHierarchyRow, ConceptRead } from '../catalogue/source-concept-explorer';
import { ViewHeading } from './view-heading';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 [overflow-wrap:anywhere] rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const continuationLimit = 4096;

export type ConceptTransport = {
  read: (input: { cursor?: string | undefined; session?: string | undefined }) => Promise<ConceptRead>;
};

type PageError = { cursor?: string; preparing: boolean };
type ConceptPage = Extract<ConceptRead, { ok: true }>;

function neighbourHref(row: ConceptHierarchyRow, locale: string, returnTo?: string) {
  const base = row.conceptPage
    ? catalogueEntries.concepts({ id: row.id, label: row.label, locale }).href
    : subjectHref({ id: row.id, label: row.label }, locale).href;
  return returnTo ? `${base}?${new URLSearchParams({ returnTo })}` : base;
}

function HierarchyLinks({
  rows,
  locale,
  returnTo,
}: {
  rows: ConceptHierarchyRow[];
  locale: string;
  returnTo?: string;
}) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {rows.map((row) => (
        <li key={`${row.direction}:${row.id}`}>
          <a className={linkClass} href={neighbourHref(row, locale, returnTo)} lang={row.lang ?? undefined}>
            {row.label}
          </a>
          <span className="ml-2 text-sm text-muted-foreground">{row.id}</span>
        </li>
      ))}
    </ul>
  );
}

export function SourceConceptView({
  id,
  locale,
  role,
  returnTo,
  pinUnsupported = false,
  transport,
  initial,
}: {
  id: string;
  locale: string;
  role?: string | undefined;
  returnTo?: string | undefined;
  pinUnsupported?: boolean;
  transport: ConceptTransport;
  initial?: ConceptRead | undefined;
}) {
  const o = { locale: locale as never };
  const failureRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const [page, setPage] = useState<ConceptPage>();
  const [withdrawn, setWithdrawn] = useState(false);
  const [withdrawnError, setWithdrawnError] = useState<CandidateFailure>();
  const [pageError, setPageError] = useState<PageError>();
  const [busy, setBusy] = useState(false);
  const [focusStatus, setFocusStatus] = useState(0);
  const [history, setHistory] = useState<ChangePageHistory>(firstChangePage);
  const [historyIndex, setHistoryIndex] = useState(0);
  const query = useQuery({
    queryKey: ['concept-explore', id, locale, role],
    queryFn: () => transport.read({}),
    initialData: initial,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const read = withdrawn ? undefined : (page ?? (query.data?.ok ? query.data : undefined));
  const error: CandidateFailure | undefined = withdrawn
    ? (withdrawnError ?? candidateFailure(503))
    : !read && query.data && !query.data.ok
      ? query.data
      : undefined;
  const title = pickText(read?.public.subject.labels ?? {}, locale);
  const factsHref = catalogueEntries.facts({ id, label: title.text, locale }).href;
  const correctionReturn = returnTo ? `${factsHref}?${new URLSearchParams({ returnTo })}` : factsHref;
  const correctionAllowed =
    read?.viewerActions.state === 'available' &&
    read.viewerActions.actions.some(
      (item) => item.action === 'statement:propose' && item.operations.includes('subject.propose'),
    );

  useEffect(
    () => () => {
      requestRef.current++;
    },
    [],
  );

  useEffect(() => {
    if (focusStatus) statusRef.current?.focus();
  }, [focusStatus, busy]);

  useEffect(() => {
    if (error) failureRef.current?.focus();
  }, [!!error]);

  async function visitCursor(cursor?: string, mode: 'next' | 'previous' | 'retry' = 'next', index?: number) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPageError(undefined);
    const requestId = ++requestRef.current;
    try {
      const result = await transport.read({ cursor, session: read?.session });
      if (requestId !== requestRef.current) return;
      if (!result.ok) {
        setPage(undefined);
        setWithdrawn(true);
        setWithdrawnError(result);
        setPageError(undefined);
        setFocusStatus((value) => value + 1);
        return;
      }
      if (result.narrower.state === 'unavailable' || result.narrower.state === 'preparing') {
        if (read) setPage({ ...result, narrower: read.narrower });
        else setPage(result);
        setWithdrawn(false);
        setWithdrawnError(undefined);
        setPageError({ ...(cursor ? { cursor } : {}), preparing: result.narrower.state === 'preparing' });
        setFocusStatus((value) => value + 1);
        return;
      }
      if (result.public.subject.id !== id) {
        setWithdrawn(true);
        setPageError(undefined);
        setFocusStatus((value) => value + 1);
        return;
      }
      setPage(result);
      setWithdrawn(false);
      setWithdrawnError(undefined);
      setPageError(undefined);
      if (mode === 'previous' && index !== undefined) setHistoryIndex(index);
      else if (mode === 'next') {
        const nextHistory =
          history.addresses[historyIndex + 1] === cursor
            ? history
            : appendChangePage({ ...history, addresses: history.addresses.slice(0, historyIndex + 1) }, cursor ?? '');
        setHistory(nextHistory);
        setHistoryIndex(nextHistory.addresses.indexOf(cursor));
      }
      setFocusStatus((value) => value + 1);
    } catch {
      if (requestId === requestRef.current) {
        if (mode === 'retry') {
          setPage(undefined);
          setWithdrawn(true);
          setWithdrawnError(candidateFailure(503));
        } else {
          setPageError({ ...(cursor ? { cursor } : {}), preparing: false });
        }
        setFocusStatus((value) => value + 1);
      }
    } finally {
      if (requestId === requestRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  const hierarchy = read?.narrower;
  const failedCursor = pageError ? pageError.cursor : hierarchy?.cursor;
  const failedInitial = pageError
    ? pageError.cursor === undefined
    : hierarchy?.state === 'unavailable' || hierarchy?.state === 'preparing';
  const previous = historyIndex > 0 ? history.addresses[historyIndex - 1] : undefined;
  const hasPrevious = historyIndex > 0;
  const nextCursor = hierarchy?.next ?? null;
  const oversizedCursor = !!nextCursor && nextCursor.length > continuationLimit;

  async function retrySubject() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPage(undefined);
    setPageError(undefined);
    const requestId = ++requestRef.current;
    try {
      const result = await query.refetch();
      if (requestId !== requestRef.current) return;
      if (result.data?.ok) {
        setPage(result.data);
        setWithdrawn(false);
        setWithdrawnError(undefined);
      } else {
        setWithdrawn(true);
        setWithdrawnError(result.data && !result.data.ok ? result.data : candidateFailure(503));
      }
    } finally {
      if (requestId === requestRef.current) {
        busyRef.current = false;
        setBusy(false);
        setFocusStatus((value) => value + 1);
      }
    }
  }

  return (
    <article
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 [overflow-wrap:anywhere]"
      aria-busy={query.isPending || busy}
    >
      <ViewHeading label={m.concept_explore_title({}, o)} headingClassName="font-sans" />
      <p className="max-w-prose text-muted-foreground">{m.concept_explore_intro({}, o)}</p>
      {pinUnsupported && <p role="status">{m.concept_explore_pin_unsupported({}, o)}</p>}
      {query.isPending && <p role="status">{m.concept_explore_loading({}, o)}</p>}
      {error && (
        <div className="space-y-2">
          <p ref={failureRef} role="alert" tabIndex={-1}>
            {error.reason === 'denied' ? m.concept_explore_denied({}, o) : m.concept_explore_unreadable({}, o)}
          </p>
          <Button type="button" variant="outline" className={actionClass} onClick={() => void retrySubject()}>
            {m.concept_explore_retry({}, o)}
          </Button>
        </div>
      )}
      {read && (
        <div className="space-y-6">
          <section className="space-y-2">
            <h2 className="font-sans text-lg font-semibold" lang={title.lang ?? undefined}>
              {title.text || id}
            </h2>
            <p>
              {m.concept_explore_identity({}, o)}: <code>{read.public.subject.id}</code>
            </p>
            <p>
              {m.concept_explore_type({}, o)}: <code>{read.public.subject.type}</code>
            </p>
            <p>
              {m.concept_explore_source_release({}, o)}: <code>{read.public.subject.release}</code>
            </p>
            {read.retired === true && <p role="status">{m.concept_explore_retired({}, o)}</p>}
            {read.retired === null && <p>{m.concept_explore_release_unknown({}, o)}</p>}
            {!read.admitted && <p role="status">{m.concept_explore_unsupported({}, o)}</p>}
            {pinUnsupported && <p>{m.concept_explore_pin_unsupported_detail({}, o)}</p>}
            {read.spoiler && <p role="status">{m.concept_explore_spoiler({}, o)}</p>}
            {read.definition && (
              <p lang={read.definition.lang ?? undefined}>
                <strong>{m.concept_explore_definition({}, o)}:</strong> {read.definition.text}
              </p>
            )}
            {read.aliases.length > 0 && (
              <p>
                <strong>{m.concept_explore_aliases({}, o)}:</strong>{' '}
                {read.aliases.map((alias, index) => (
                  <span key={`${alias.lang}:${alias.text}`} lang={alias.lang ?? undefined}>
                    {index ? ' · ' : ''}
                    {alias.text}
                  </span>
                ))}
              </p>
            )}
          </section>

          {read.admitted && (
            <>
              <section className="space-y-2">
                <h2 className="font-sans text-lg font-semibold">{m.concept_explore_scheme({}, o)}</h2>
                {read.schemes.length ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {read.schemes.map((scheme) => (
                      <li key={scheme.id}>
                        {scheme.readable && scheme.conceptPage ? (
                          <a
                            className={linkClass}
                            href={`${catalogueEntries.concepts({ id: scheme.id, label: scheme.label, locale }).href}${
                              returnTo ? `?${new URLSearchParams({ returnTo })}` : ''
                            }`}
                            lang={scheme.lang ?? undefined}
                          >
                            {scheme.label || scheme.id}
                          </a>
                        ) : scheme.readable ? (
                          <a
                            className={linkClass}
                            href={`${subjectHref({ id: scheme.id, label: scheme.label }, locale).href}${
                              returnTo ? `?${new URLSearchParams({ returnTo })}` : ''
                            }`}
                          >
                            {scheme.label || scheme.id}
                          </a>
                        ) : (
                          <span>{scheme.id}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{m.concept_explore_no_schemes({}, o)}</p>
                )}
              </section>

              <section className="space-y-2">
                <h2 className="font-sans text-lg font-semibold">{m.concept_explore_source_code({}, o)}</h2>
                {read.codes.length ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {read.codes.map((code) => (
                      <li key={`${code.property}:${code.value}`}>
                        <span lang={code.unknown ? undefined : (code.labelLang ?? undefined)}>
                          {code.unknown ? m.concept_explore_unknown_role({}, o) : code.label}
                        </span>{' '}
                        <code>{code.property}</code>: <code>{code.value}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{m.concept_explore_no_codes({}, o)}</p>
                )}
              </section>

              <section className="space-y-2" aria-labelledby="concept-broader-heading">
                <h2 id="concept-broader-heading" className="font-sans text-lg font-semibold">
                  {m.concept_explore_broader({}, o)}
                </h2>
                {read.broader.rows.length ? (
                  <HierarchyLinks
                    rows={read.broader.rows}
                    locale={locale}
                    {...(returnTo === undefined ? {} : { returnTo })}
                  />
                ) : read.broader.withheld ? (
                  <p role="status">{m.concept_explore_broader_withheld({}, o)}</p>
                ) : (
                  <p>{m.concept_explore_no_broader({}, o)}</p>
                )}
                {!!read.broader.rows.length && read.broader.withheld > 0 && (
                  <p role="status">{m.concept_explore_broader_withheld({}, o)}</p>
                )}
              </section>

              <section className="space-y-2" aria-labelledby="concept-narrower-heading">
                <h2 id="concept-narrower-heading" className="font-sans text-lg font-semibold">
                  {m.concept_explore_narrower({}, o)}
                </h2>
                {hierarchy?.state === 'unsupported' ? (
                  <p role="status">{m.concept_explore_inverse_unsupported({}, o)}</p>
                ) : hierarchy?.state === 'preparing' ? (
                  <p role="status">{m.concept_explore_hierarchy_preparing({}, o)}</p>
                ) : hierarchy?.state === 'unavailable' ? (
                  <p role="alert">{m.concept_explore_hierarchy_unavailable({}, o)}</p>
                ) : hierarchy?.state === 'lagging' ? (
                  <p role="status">{m.concept_explore_hierarchy_lagging({}, o)}</p>
                ) : null}
                {hierarchy?.rows.length ? (
                  <HierarchyLinks
                    rows={hierarchy.rows}
                    locale={locale}
                    {...(returnTo === undefined ? {} : { returnTo })}
                  />
                ) : hierarchy?.state === 'available' && hierarchy.exactEmpty ? (
                  <p>{m.concept_explore_no_narrower({}, o)}</p>
                ) : hierarchy?.state === 'available' ? (
                  <p>{m.concept_explore_page_empty({}, o)}</p>
                ) : null}
                {pageError && (
                  <p role="alert">
                    {pageError.preparing
                      ? m.concept_explore_hierarchy_preparing({}, o)
                      : m.concept_explore_hierarchy_unavailable({}, o)}
                  </p>
                )}
                {(failedInitial || pageError) && hierarchy?.state !== 'unsupported' && (
                  <Button
                    type="button"
                    variant="outline"
                    className={actionClass}
                    disabled={busy}
                    onClick={() => void visitCursor(pageError ? pageError.cursor : failedCursor, 'retry')}
                  >
                    {m.concept_explore_retry({}, o)}
                  </Button>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className={actionClass}
                    disabled={!hasPrevious || busy}
                    onClick={() => void visitCursor(previous, 'previous', historyIndex - 1)}
                  >
                    {m.concept_explore_previous({}, o)}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className={actionClass}
                    disabled={!nextCursor || oversizedCursor || busy || !!pageError}
                    onClick={() => nextCursor && void visitCursor(nextCursor, 'next')}
                  >
                    {m.concept_explore_more({}, o)}
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {m.concept_explore_page_position(
                      { current: historyIndex + 1, retained: history.addresses.length },
                      o,
                    )}
                  </span>
                </div>
                {oversizedCursor && <p role="status">{m.concept_explore_cursor_too_large({}, o)}</p>}
                {history.truncated && (
                  <p role="status">{m.concept_explore_history_truncated({ limit: changePageHistoryLimit }, o)}</p>
                )}
                <p ref={statusRef} role="status" tabIndex={-1} aria-live="polite">
                  {busy ? m.concept_explore_loading({}, o) : m.concept_explore_page_ready({}, o)}
                </p>
              </section>

              <section className="space-y-2" aria-labelledby="concept-actions-heading">
                <h2 id="concept-actions-heading" className="font-sans text-lg font-semibold">
                  {m.concept_explore_actions({}, o)}
                </h2>
                {correctionAllowed ? (
                  <a className={linkClass} href={correctionReturn}>
                    {m.concept_explore_correct({}, o)}
                  </a>
                ) : read.viewerActions.state === 'unavailable' ? (
                  <p role="status">{m.concept_explore_actions_unavailable({}, o)}</p>
                ) : read.viewerActions.account === null ? (
                  <p>
                    {m.concept_explore_sign_in({}, o)}{' '}
                    <a className={linkClass} href={`/auth/sign-in?return_to=${encodeURIComponent(correctionReturn)}`}>
                      {m.account_sign_in({}, o)}
                    </a>
                  </p>
                ) : (
                  <p role="status">{m.concept_explore_read_only({}, o)}</p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className={actionClass}
                  disabled={busy}
                  onClick={() => void visitCursor(read.narrower.cursor, 'retry')}
                >
                  {m.concept_explore_refresh_actions({}, o)}
                </Button>
              </section>
            </>
          )}
          {returnTo && (
            <a className={linkClass} href={returnTo}>
              {m.concept_explore_return({}, o)}
            </a>
          )}
        </div>
      )}
    </article>
  );
}
