import { Link } from '@tanstack/react-router';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { useEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { executeOwnMediaErase, type OwnMediaEraseResult, type OwnMediaRead } from './actions';
import { useOwnMediaCurrentOrigin } from './current-origin';
import { eraseIntentFor, indexOwnMediaPage, OWN_MEDIA_SOURCE, advisedMediaDestinations, type OwnMediaEraseIntent } from './inventory';
import type { OwnMediaInventoryEntry, OwnMediaInventoryPage } from './wire';

type EraseCall = (input: { data: OwnMediaEraseIntent }) => Promise<OwnMediaEraseResult>;
type Props = {
  initial: OwnMediaRead;
  cursor: string | null;
  invalidAddress?: boolean;
};

export function CurrentViewerOwnMediaPage({ initial, cursor, invalidAddress = false }: Props) {
  const origin = useOwnMediaCurrentOrigin(initial, cursor, invalidAddress);
  return (
    <OwnMediaInventoryWorkspace
      key={origin.viewKey}
      state={origin.state}
      page={origin.page}
      cursor={origin.cursor}
      subject={origin.subject}
      locale={origin.locale}
      viewKey={origin.viewKey}
      isCurrent={origin.isCurrent}
      onRefresh={origin.refresh}
      onErase={executeOwnMediaErase}
    />
  );
}

type Selection = { id: string; identity: string; viewKey: string };
type Feedback = { kind: 'acknowledged' | 'uncertain' | 'denied' | 'concealed' | 'stale' | 'signed-out'; id: string };
const returnStateKey = '__ownMediaInventoryReturn';
const emptyRows = new Map<string, OwnMediaInventoryEntry>();

function mediaIdentity(entry: OwnMediaInventoryEntry): string {
  return JSON.stringify([entry.id, entry.purpose, entry.container?.kind ?? null, entry.container?.id ?? null]);
}

function statusText(state: OwnMediaRead['state']): string {
  switch (state) {
    case 'preparing':
      return m.own_media_preparing();
    case 'signed-out':
      return m.own_media_signed_out();
    case 'denied':
      return m.own_media_denied();
    case 'invalid-cursor':
      return m.own_media_restart();
    case 'unavailable':
      return m.own_media_unavailable();
    case 'ready':
      return '';
  }
}

function purposeText(purpose: OwnMediaInventoryEntry['purpose']): string {
  switch (purpose) {
    case 'post-image':
      return m.own_media_kind_post_image();
    case 'avatar':
      return m.own_media_kind_avatar();
    case 'realm-icon':
      return m.own_media_kind_realm_icon();
    case 'realm-banner':
      return m.own_media_kind_realm_banner();
    case 'cover':
      return m.own_media_kind_cover();
  }
}

function stateText(state: OwnMediaInventoryEntry['state']): string {
  switch (state) {
    case 'reserved':
      return m.own_media_state_reserved();
    case 'uploaded':
      return m.own_media_state_uploaded();
    case 'available':
      return m.own_media_state_available();
    case 'rejected':
      return m.own_media_state_rejected();
    case 'erased':
      return m.own_media_state_erased();
  }
}

function dateText(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : null;
}

function sizeText(value: number | null, locale: string): string | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
  if (value < 1024) return `${new Intl.NumberFormat(locale).format(value)} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let amount = value;
  let unit = 'B';
  for (const next of units) {
    amount /= 1024;
    unit = next;
    if (amount < 1024 || next === 'GB') break;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(amount)} ${unit}`;
}

function containerText(kind: NonNullable<OwnMediaInventoryEntry['container']>['kind']): string {
  switch (kind) {
    case 'thread':
      return m.own_media_container_thread();
    case 'post':
      return m.own_media_container_post();
    case 'realm':
      return m.own_media_container_realm();
    case 'account':
      return m.own_media_container_account();
  }
}

function rememberReturn(entry: OwnMediaInventoryEntry, subject: string, cursor: string | null, locale: string) {
  if (typeof window === 'undefined') return;
  const previous = window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
  window.history.replaceState(
    {
      ...previous,
      [returnStateKey]: { id: entry.id, subject, cursor, locale, source: OWN_MEDIA_SOURCE },
    },
    '',
  );
}

function forgetReturn() {
  if (typeof window === 'undefined' || !window.history.state || typeof window.history.state !== 'object') return null;
  const previous = window.history.state as Record<string, unknown>;
  const focus = previous[returnStateKey];
  if (!(returnStateKey in previous)) return null;
  const next = { ...previous };
  delete next[returnStateKey];
  window.history.replaceState(next, '');
  return focus;
}

export function OwnMediaInventoryWorkspace({
  state,
  page,
  cursor,
  subject,
  locale,
  viewKey,
  isCurrent,
  onRefresh,
  onErase,
}: {
  state: OwnMediaRead['state'];
  page: OwnMediaInventoryPage | null;
  cursor: string | null;
  subject: string | null;
  locale: string;
  viewKey: string;
  isCurrent: () => boolean;
  onRefresh: () => Promise<unknown>;
  onErase: EraseCall;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const intentRef = useRef<OwnMediaEraseIntent | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingCommands = useRef(new Set<string>());
  const attempt = useRef(0);
  const localeNow = getLocale();
  let indexed: ReturnType<typeof indexOwnMediaPage> | null = null;
  let invalidPage = false;
  if (page) {
    try {
      indexed = indexOwnMediaPage(page);
    } catch {
      invalidPage = true;
    }
  }
  const rows = indexed?.entries ?? emptyRows;
  const selectedEntry = selection ? rows.get(selection.id) ?? null : null;
  const selectedCurrent = Boolean(
    selection &&
      selectedEntry &&
      selection.viewKey === viewKey &&
      selection.identity === mediaIdentity(selectedEntry) &&
      state === 'ready' &&
      isCurrent(),
  );
  const activeEntry = selectedCurrent ? selectedEntry : null;

  useEffect(() => {
    if (!selection || selectedCurrent) return;
    attempt.current += 1;
    setBusy(false);
    setSelection(null);
    setConfirmingId(null);
    if (intentRef.current?.mediaId === selection.id) {
      intentRef.current = null;
    }
    setFeedback((current) => (current?.id === selection.id ? null : current));
  }, [selection, selectedCurrent]);

  useEffect(() => {
    if (state !== 'ready' || !page || !isCurrent()) return;
    const focus = forgetReturn();
    if (!focus || typeof focus !== 'object') return;
    const candidate = focus as Record<string, unknown>;
    const target =
      candidate.subject === subject &&
      candidate.cursor === cursor &&
      candidate.locale === locale &&
      candidate.source === OWN_MEDIA_SOURCE &&
      typeof candidate.id === 'string' &&
      rows.has(candidate.id)
        ? candidate.id
        : null;
    if (!isCurrent()) return;
    const row = target ? rowButtons.current.get(target) : null;
    if (row) row.focus();
    else heading.current?.focus();
  }, [state, page, subject, cursor, locale, viewKey, isCurrent, rows]);

  const choose = (entry: OwnMediaInventoryEntry) => {
    if (!isCurrent()) return;
    attempt.current += 1;
    setBusy(false);
    setFeedback(null);
    setConfirmingId(null);
    intentRef.current = null;
    setSelection((current) =>
      current?.id === entry.id
        ? null
        : { id: entry.id, identity: mediaIdentity(entry), viewKey },
    );
  };

  const runErase = async (next: OwnMediaEraseIntent) => {
    if (
      !isCurrent() ||
      !selectedCurrent ||
      !activeEntry ||
      next.mediaId !== activeEntry.id ||
      pendingCommands.current.has(next.mediaId)
    )
      return;
    const owner = attempt.current;
    pendingCommands.current.add(next.mediaId);
    setBusy(true);
    let result: OwnMediaEraseResult;
    try {
      result = await onErase({ data: next });
    } catch {
      result = 'uncertain';
    } finally {
      pendingCommands.current.delete(next.mediaId);
      if (owner === attempt.current && isCurrent()) setBusy(false);
    }
    if (owner !== attempt.current || !isCurrent()) return;
    setFeedback({ kind: result, id: next.mediaId });
    if (result === 'acknowledged') {
      intentRef.current = null;
      void onRefresh();
    } else if (result !== 'uncertain') {
      intentRef.current = null;
    }
  };

  const confirmErase = (entry: OwnMediaInventoryEntry) => {
    if (!isCurrent() || !selectedCurrent || !subject) return;
    const next = eraseIntentFor(entry, subject, OWN_MEDIA_SOURCE, crypto.randomUUID());
    if (!next) return;
    intentRef.current = next;
    setConfirmingId(null);
    setFeedback(null);
    void runErase(next);
  };

  const retryErase = () => {
    const original = intentRef.current;
    if (original && feedback?.kind === 'uncertain' && isCurrent()) void runErase(original);
  };

  const format = locale || localeNow;
  const invalidPageState = state === 'ready' && invalidPage;
  const status = invalidPageState ? 'unavailable' : state;

  return (
    <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8 sm:px-6">
      <header className="grid gap-2">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          {m.own_media_heading()}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{m.own_media_intro()}</p>
      </header>

      {status !== 'ready' ? (
        <section className="grid gap-3 rounded-lg border p-4" aria-live="polite">
          <h2 className="text-lg font-medium">{status === 'unavailable' ? m.own_media_unavailable_heading() : statusText(status)}</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">{statusText(status)}</p>
          {status === 'unavailable' ? (
            <Button variant="outline" onClick={() => void onRefresh()} disabled={!isCurrent()}>
              {m.own_media_retry()}
            </Button>
          ) : null}
          {status === 'invalid-cursor' ? (
            <Link to="/library/media" className={`${buttonVariants({ variant: 'outline', size: 'lg' })} min-h-11`}>
              {m.own_media_restart_action()}
            </Link>
          ) : null}
        </section>
      ) : page ? (
        <>
          {feedback?.kind === 'uncertain' ? (
            <div role="alert" className="grid gap-2 rounded-lg border border-warning p-4">
              <p className="font-medium">{m.own_media_removal_uncertain()}</p>
              <p className="text-sm text-muted-foreground">{m.own_media_removal_uncertain_detail()}</p>
              <Button variant="outline" onClick={retryErase} disabled={busy || !isCurrent()}>
                {busy ? m.own_media_removing() : m.own_media_retry_removal()}
              </Button>
            </div>
          ) : null}
          {feedback?.kind === 'acknowledged' ? (
            <p role="status" className="rounded-lg border p-3 text-sm">{m.own_media_removed()}</p>
          ) : null}
          {feedback && !['uncertain', 'acknowledged'].includes(feedback.kind) ? (
            <p role="alert" className="rounded-lg border p-3 text-sm">{m.own_media_removal_refused()}</p>
          ) : null}

          {page.entries.length === 0 ? (
            page.nextCursor === null ? (
              <section className="grid gap-2 rounded-lg border p-5">
                <h2 className="text-lg font-medium">{m.own_media_empty_heading()}</h2>
                <p className="text-sm text-muted-foreground">{m.own_media_empty_body()}</p>
              </section>
            ) : (
              <section className="grid gap-2 rounded-lg border p-5">
                <h2 className="text-lg font-medium">{m.own_media_sparse_heading()}</h2>
                <p className="text-sm text-muted-foreground">{m.own_media_sparse_body()}</p>
              </section>
            )
          ) : (
            <ul className="grid gap-3" aria-label={m.own_media_heading()}>
              {page.entries.map((entry) => {
                const expanded = activeEntry?.id === entry.id;
                const claimed = dateText(entry.claimedAt, format);
                const created = dateText(entry.createdAt, format);
                const declaredSize = sizeText(entry.declaredByteCount, format);
                const actualSize = sizeText(entry.actualByteCount, format);
                const destinations = advisedMediaDestinations(entry);
                return (
                  <li key={entry.id} className="min-w-0 rounded-lg border p-4">
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                      <div className="grid min-w-0 gap-2">
                        <h2 className="min-w-0">
                          <button
                            ref={(node) => {
                              if (node) rowButtons.current.set(entry.id, node);
                              else rowButtons.current.delete(entry.id);
                            }}
                            type="button"
                            className="min-h-11 max-w-full rounded text-left font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            aria-expanded={expanded}
                            onClick={() => choose(entry)}
                          >
                            <span className="break-words">{purposeText(entry.purpose)}</span>
                            {' · '}
                            <span className="break-words">{stateText(entry.state)}</span>
                          </button>
                        </h2>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                          {entry.declaredMediaType ? <span className="break-all">{m.own_media_file_kind({ kind: entry.declaredMediaType })}</span> : null}
                          {declaredSize ? <span>{m.own_media_declared_size({ size: declaredSize })}</span> : null}
                          {actualSize ? <span>{m.own_media_actual_size({ size: actualSize })}</span> : null}
                          {created ? <span>{m.own_media_created({ date: created })}</span> : null}
                          {claimed ? <span>{m.own_media_claimed({ date: claimed })}</span> : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          {entry.container ? (
                            <>
                              <span>{containerText(entry.container.kind)}</span>
                              {entry.container.kind === 'thread' ? (
                                <Link
                                  to="/threads/$id"
                                  params={{ id: entry.container.id }}
                                  className="min-h-11 content-center text-primary underline underline-offset-4"
                                  onClick={() => subject && rememberReturn(entry, subject, cursor, locale)}
                                >
                                  {m.own_media_open_container()}
                                </Link>
                              ) : entry.container.kind === 'realm' ? (
                                <Link
                                  to="/realms/$id"
                                  params={{ id: entry.container.id }}
                                  className="min-h-11 content-center text-primary underline underline-offset-4"
                                  onClick={() => subject && rememberReturn(entry, subject, cursor, locale)}
                                >
                                  {m.own_media_open_container()}
                                </Link>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-muted-foreground">{m.own_media_container_withheld()}</span>
                          )}
                          {entry.collectionPending || entry.takenDown ? (
                            <span className="text-muted-foreground">{m.own_media_container_unavailable()}</span>
                          ) : null}
                        </div>
                      </div>
                      {activeEntry?.id === entry.id && destinations.length > 0 ? (
                        <div className="flex flex-wrap gap-2 sm:justify-end">
                          {destinations.map(({ variant, href }) => (
                            <a
                              key={variant}
                              href={href}
                              className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                              onClick={(event) => {
                                if (!isCurrent() || !activeEntry || activeEntry.id !== entry.id) event.preventDefault();
                              }}
                            >
                              {variant === 'original'
                                ? m.own_media_open_original()
                                : m.own_media_open_variant({ variant })}
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    {expanded ? (
                      <div className="mt-4 grid gap-3 border-t pt-4">
                        {entry.state === 'reserved' ? <p className="text-sm text-muted-foreground">{m.own_media_reserved_note()}</p> : null}
                        {entry.state === 'uploaded' ? <p className="text-sm text-muted-foreground">{m.own_media_processing_note()}</p> : null}
                        {entry.state === 'available' ? <p className="text-sm text-muted-foreground">{m.own_media_available_note()}</p> : null}
                        {entry.state === 'rejected' ? <p className="text-sm text-muted-foreground">{m.own_media_rejected_note()}</p> : null}
                        {entry.state === 'erased' ? <p className="text-sm text-muted-foreground">{m.own_media_erased_note()}</p> : null}
                        {entry.actions.resume ? <p className="text-sm text-muted-foreground">{m.own_media_resume_note()}</p> : null}
                        {entry.actions.retry ? <p className="text-sm text-muted-foreground">{m.own_media_retry_note()}</p> : null}
                        {entry.actions.read === null ? <p className="text-sm text-muted-foreground">{m.own_media_no_read()}</p> : null}
                        {entry.actions.remove?.operationId === 'media.erase' && entry.state !== 'erased' ? (
                          confirmingId === entry.id ? (
                            <div className="flex flex-wrap gap-2">
                              <Button onClick={() => confirmErase(entry)} disabled={!isCurrent() || busy}>
                                {busy ? m.own_media_removing() : m.own_media_confirm_remove()}
                              </Button>
                              <Button variant="outline" onClick={() => setConfirmingId(null)} disabled={busy}>
                                {m.own_media_cancel()}
                              </Button>
                            </div>
                          ) : (
                            <Button
                              variant="outline"
                              className="justify-self-start"
                              onClick={() => setConfirmingId(entry.id)}
                              disabled={!isCurrent() || !selectedCurrent || busy}
                            >
                              {m.own_media_remove()}
                            </Button>
                          )
                        ) : null}
                        {feedback?.id === entry.id && feedback.kind === 'concealed' ? (
                          <p role="alert" className="text-sm">{m.own_media_removal_refused()}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {page.nextCursor !== null ? (
            <div className="flex flex-wrap items-center gap-3">
              <Link
                to="/library/media"
                search={{ cursor: page.nextCursor }}
                className={`${buttonVariants({ variant: 'outline', size: 'lg' })} min-h-11`}
              >
                {m.own_media_continue()}
              </Link>
              <span className="text-sm text-muted-foreground">{m.own_media_sparse_continue_note()}</span>
            </div>
          ) : null}
          {page.nextCursor === null && page.entries.length > 0 ? (
            <p className="text-sm text-muted-foreground">{m.own_media_page_end()}</p>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
