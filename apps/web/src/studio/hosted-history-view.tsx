import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { historicalReaderSource } from '../threads/historical-reader-provenance';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { StudioFailure } from './contract';
import { HostedHistoryVisit, type HostedHistoryBinding, type HostedHistorySelection } from './hosted-history';
import type { HostedHistoryEntry, HostedOutlineWindowPage } from './hosted-contract';

/** Closing this disclosure unmounts the private directory and aborts both kinds of read. */
export function HostedHistoryDisclosure({ binding }: { binding: HostedHistoryBinding }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const options = { locale: getLocale() };
  return (
    <div className="studio-stack">
      <Button type="button" variant="outline" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? m.studio_book_history_hide({}, options) : m.studio_book_history_show({}, options)}
      </Button>
      <div id={id}>{open ? <MountedHistory binding={binding} /> : null}</div>
    </div>
  );
}

function MountedHistory({ binding }: { binding: HostedHistoryBinding }) {
  const queryClient = useQueryClient();
  const source = useMemo(() => historicalReaderSource(queryClient), [queryClient]);
  const [visit, setVisit] = useState<HostedHistoryVisit | null>(null);
  const options = { locale: getLocale() };
  useEffect(() => {
    let mounted: HostedHistoryVisit | null = null;
    let disposed = false;
    void import('./hosted-actions').then(({ hostedOutlineWindowNative }) => {
      if (disposed) return;
      mounted = new HostedHistoryVisit(binding, source, hostedOutlineWindowNative);
      setVisit(mounted);
      void mounted.load();
    });
    return () => {
      disposed = true;
      mounted?.dispose();
    };
  }, [binding, source]);
  return visit ? (
    <HostedHistoryPanel visit={visit} />
  ) : (
    <p role="status">{m.studio_book_history_loading({}, options)}</p>
  );
}

function versionTitle(entry: HostedHistoryEntry) {
  const options = { locale: getLocale() };
  return entry.kind === 'structure'
    ? m.studio_book_history_structure_title({ revision: entry.revisionId }, options)
    : m.studio_book_history_release_title({ revision: entry.revisionId }, options);
}

/** Native failure kinds remain authoritative; their English transport copy does not enter the localized view. */
function HistoryFailure({ kind, outline = false }: { kind: StudioFailure['kind']; outline?: boolean }) {
  const options = { locale: getLocale() };
  switch (kind) {
    case 'denied':
      return m.studio_book_history_denied({}, options);
    case 'invalid':
      return m.studio_book_history_invalid({}, options);
    case 'withdrawn':
      return m.studio_book_history_withdrawn({}, options);
    case 'uncertain':
      return m.studio_book_history_uncertain({}, options);
    case 'stale':
      return outline ? m.studio_book_history_outline_stale({}, options) : m.studio_book_history_stale({}, options);
    case 'unavailable':
      return outline
        ? m.studio_book_history_outline_unavailable({}, options)
        : m.studio_book_history_unavailable({}, options);
  }
}

/** The view reads only directory metadata until the author explicitly selects one exact version. */
export function HostedHistoryPanel({ visit }: { visit: HostedHistoryVisit }) {
  const state = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const options = { locale: getLocale() };
  const headingId = useId();
  const inspector = useRef<HTMLElement>(null);
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const selectedId =
    state.kind === 'ready' && state.selection.kind !== 'none' ? state.selection.entry.revisionId : null;
  useEffect(() => {
    if (selectedId) inspector.current?.focus();
  }, [selectedId]);
  return (
    <section className="studio-stack" aria-labelledby={headingId} aria-busy={state.kind === 'loading'}>
      <h3 id={headingId}>{m.studio_book_history_heading({}, options)}</h3>
      <p className="studio-help">{m.studio_book_history_intro({}, options)}</p>
      {state.kind === 'loading' ? <p role="status">{m.studio_book_history_loading({}, options)}</p> : null}
      {state.kind === 'ended' ? <p role="alert">{m.studio_book_history_ended({}, options)}</p> : null}
      {state.kind === 'failed' ? (
        <div className="studio-stack" role="alert">
          <p>
            <HistoryFailure kind={state.error.kind} />
          </p>
          {state.error.kind === 'unavailable' ? (
            <Button type="button" variant="outline" onClick={() => void visit.load()}>
              {m.studio_books_retry({}, options)}
            </Button>
          ) : null}
          {state.error.kind === 'stale' ? (
            <Button type="button" variant="outline" onClick={() => void visit.restart()}>
              {m.studio_book_history_restart({}, options)}
            </Button>
          ) : null}
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          {state.page.items.length ? (
            <ol className="studio-history-list" aria-label={m.studio_book_history_list({}, options)}>
              {state.page.items.map((entry) => (
                <li key={entry.revisionId} className="studio-stack">
                  <div className="studio-action-row">
                    <strong>
                      {entry.kind === 'structure'
                        ? m.studio_book_history_structure({}, options)
                        : m.studio_book_history_release({}, options)}
                    </strong>
                    {entry.isCurrentDraft ? <span>{m.studio_book_history_current_draft({}, options)}</span> : null}
                    {entry.isCurrentRelease ? <span>{m.studio_book_history_current_release({}, options)}</span> : null}
                  </div>
                  <NativeTimestamp entry={entry} />
                  <p className="studio-help studio-break">
                    {m.studio_book_history_version_value({ revision: entry.revisionId }, options)}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={m.studio_book_history_inspect_title({ title: versionTitle(entry) }, options)}
                    aria-pressed={
                      state.selection.kind !== 'none' && state.selection.entry.revisionId === entry.revisionId
                    }
                    onClick={(event) => {
                      selectedTrigger.current = event.currentTarget;
                      void visit.inspect(entry.revisionId);
                    }}
                  >
                    {m.studio_book_history_inspect({}, options)}
                  </Button>
                </li>
              ))}
            </ol>
          ) : (
            <p>
              {state.cursor === null && state.page.nextCursor === null
                ? m.studio_book_history_empty({}, options)
                : m.studio_book_history_page_empty({}, options)}
            </p>
          )}
          <div className="studio-action-row">
            {state.page.nextCursor !== null ? (
              <Button type="button" variant="outline" onClick={() => void visit.next()}>
                {m.studio_book_history_older({}, options)}
              </Button>
            ) : (
              <p className="studio-help">{m.studio_book_history_complete({}, options)}</p>
            )}
            {state.cursor !== null ? (
              <Button type="button" variant="ghost" onClick={() => void visit.restart()}>
                {m.studio_book_history_newest({}, options)}
              </Button>
            ) : null}
          </div>
          {state.selection.kind !== 'none' ? (
            <section
              ref={inspector}
              tabIndex={-1}
              className="studio-stack"
              aria-label={m.studio_book_history_inspector_title(
                { title: versionTitle(state.selection.entry) },
                options,
              )}
              aria-busy={state.selection.kind === 'loading'}
            >
              <div className="studio-section-heading">
                <h4>{m.studio_book_history_readonly_title({ title: versionTitle(state.selection.entry) }, options)}</h4>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={m.studio_book_history_close_title(
                    { title: versionTitle(state.selection.entry) },
                    options,
                  )}
                  onClick={() => {
                    visit.closeSelection();
                    selectedTrigger.current?.focus();
                  }}
                >
                  {m.revision_history_close_inspector({}, options)}
                </Button>
              </div>
              <p className="studio-help">{m.studio_book_history_readonly_help({}, options)}</p>
              <dl className="studio-break">
                <dt>{m.studio_book_catalogue({}, options)}</dt>
                <dd>{state.selection.entry.catalogueId}</dd>
                <dt>{m.studio_book_history_version({}, options)}</dt>
                <dd>{state.selection.entry.revisionId}</dd>
                {state.selection.entry.sourceRevisionId ? (
                  <>
                    <dt>{m.studio_book_history_source({}, options)}</dt>
                    <dd>{state.selection.entry.sourceRevisionId}</dd>
                  </>
                ) : null}
              </dl>
              <NativeTimestamp entry={state.selection.entry} />
              <HistorySelection selection={state.selection} visit={visit} />
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function NativeTimestamp({ entry }: { entry: HostedHistoryEntry }) {
  // Keep microseconds and the native offset; Date formatting would silently truncate precision.
  return (
    <time className="studio-help studio-break" dateTime={entry.createdAt}>
      {entry.createdAt}
    </time>
  );
}

function HistorySelection({ selection, visit }: { selection: HostedHistorySelection; visit: HostedHistoryVisit }) {
  const options = { locale: getLocale() };
  if (selection.kind === 'none') return null;
  if (selection.kind === 'loading') return <p role="status">{m.studio_book_history_exact_loading({}, options)}</p>;
  if (selection.kind === 'failed')
    return (
      <div role="alert" className="studio-stack">
        <p>
          <HistoryFailure kind={selection.error.kind} outline />
        </p>
        <Button type="button" variant="outline" onClick={() => void visit.retryOutline()}>
          {m.studio_book_history_outline_retry({}, options)}
        </Button>
      </div>
    );
  const { page, cursor } = selection;
  const emptyVersion = cursor === null && page.nextCursor === null && page.items.length === 0;
  return (
    <div className="studio-stack">
      <p className="studio-help">{m.studio_book_history_outline_help({}, options)}</p>
      {page.items.length ? (
        <HistoryOutline page={page} title={versionTitle(selection.entry)} />
      ) : (
        <p>
          {emptyVersion
            ? selection.entry.kind === 'publication'
              ? m.studio_book_history_release_empty({}, options)
              : m.studio_book_history_structure_empty({}, options)
            : m.studio_book_history_outline_empty({}, options)}
        </p>
      )}
      {page.nextCursor !== null ? (
        <Button type="button" variant="outline" onClick={() => void visit.nextOutline()}>
          {m.studio_book_history_outline_next({}, options)}
        </Button>
      ) : (
        <p className="studio-help">{m.studio_book_history_outline_complete({}, options)}</p>
      )}
    </div>
  );
}

/** Flat native preorder: a page can start inside an absent part, and never becomes an editable tree. */
function HistoryOutline({ page, title }: { page: HostedOutlineWindowPage; title: string }) {
  const options = { locale: getLocale() };
  return (
    <ol className="studio-toc-branch" aria-label={m.studio_book_history_outline_title({ title }, options)}>
      {page.items.map((item) => (
        <li key={item.occurrenceId}>
          <div className="studio-toc-entry">
            {item.availability === 'unavailable' ? (
              <p>
                {item.kind === 'part'
                  ? m.studio_book_history_part_unavailable({}, options)
                  : m.studio_book_history_chapter_unavailable({}, options)}
              </p>
            ) : (
              <>
                <strong>{item.title}</strong>
                {item.kind === 'chapter' ? (
                  <dl className="studio-help studio-break">
                    <dt>{m.book_reader_chapter({}, options)}</dt>
                    <dd>{item.target.postId}</dd>
                    <dt>{m.studio_book_history_pinned({}, options)}</dt>
                    <dd>{item.target.revisionId}</dd>
                    <dt>{m.studio_revision_digest({}, options)}</dt>
                    <dd>{item.target.sha256}</dd>
                  </dl>
                ) : (
                  <p className="studio-help">{m.book_reader_part({}, options)}</p>
                )}
              </>
            )}
            <dl className="studio-help studio-break">
              <dt>{m.studio_book_history_occurrence({}, options)}</dt>
              <dd>{item.occurrenceId}</dd>
              <dt>{m.studio_book_history_parent({}, options)}</dt>
              <dd>{item.parentId ?? m.studio_book_history_none({}, options)}</dd>
              <dt>{m.studio_book_history_position({}, options)}</dt>
              <dd>{item.position}</dd>
            </dl>
          </div>
        </li>
      ))}
    </ol>
  );
}
