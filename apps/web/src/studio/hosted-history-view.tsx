import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { historicalReaderSource } from '../threads/historical-reader-provenance';
import { bookTocRows, type BookTocRow } from './book-toc';
import { hostedBookStructure } from './hosted-structure';
import { HostedHistoryVisit, type HostedHistoryBinding, type HostedHistorySelection } from './hosted-history';
import type { HostedHistoryEntry } from './hosted-contract';

/** Closing this disclosure unmounts the private directory and aborts both kinds of read. */
export function HostedHistoryDisclosure({ binding }: { binding: HostedHistoryBinding }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="studio-stack">
      <Button type="button" variant="outline" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? 'Close book history' : 'Browse book history'}
      </Button>
      <div id={id}>{open ? <MountedHistory binding={binding} /> : null}</div>
    </div>
  );
}

function MountedHistory({ binding }: { binding: HostedHistoryBinding }) {
  const queryClient = useQueryClient();
  const source = useMemo(() => historicalReaderSource(queryClient), [queryClient]);
  const [visit, setVisit] = useState<HostedHistoryVisit | null>(null);
  useEffect(() => {
    const mounted = new HostedHistoryVisit(binding, source);
    setVisit(mounted);
    void mounted.load();
    return () => mounted.dispose();
  }, [binding, source]);
  return visit ? <HostedHistoryPanel visit={visit} /> : <p role="status">Loading book history…</p>;
}

/** The view reads only directory metadata until the author explicitly selects one exact version. */
export function HostedHistoryPanel({ visit }: { visit: HostedHistoryVisit }) {
  const state = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
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
      <h3 id={headingId}>Book history</h3>
      <p className="studio-help">Inspect saved structures and releases. Your current draft stays open above.</p>
      {state.kind === 'loading' ? <p role="status">Loading book history…</p> : null}
      {state.kind === 'ended' ? (
        <p role="alert">Your author session changed. Reopen the book to browse its history.</p>
      ) : null}
      {state.kind === 'failed' ? (
        <div className="studio-stack" role="alert">
          <p>{state.error.message}</p>
          {state.error.kind === 'unavailable' ? (
            <Button type="button" variant="outline" onClick={() => void visit.load()}>
              Retry this page
            </Button>
          ) : null}
          {state.error.kind === 'stale' ? (
            <Button type="button" variant="outline" onClick={() => void visit.restart()}>
              Restart history
            </Button>
          ) : null}
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          {state.page.items.length ? (
            <ol className="studio-history-list" aria-label="Saved book versions">
              {state.page.items.map((entry) => (
                <li key={entry.revisionId} className="studio-stack">
                  <div className="studio-action-row">
                    <strong>{entry.kind === 'structure' ? 'Structure' : 'Release'}</strong>
                    {entry.isCurrentDraft ? <span>Current draft</span> : null}
                    {entry.isCurrentRelease ? <span>Current release</span> : null}
                  </div>
                  <NativeTimestamp entry={entry} />
                  <p className="studio-help studio-break">Version: {entry.revisionId}</p>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={`Inspect ${entry.kind === 'structure' ? 'structure' : 'release'} ${entry.revisionId}`}
                    aria-pressed={
                      state.selection.kind !== 'none' && state.selection.entry.revisionId === entry.revisionId
                    }
                    onClick={(event) => {
                      selectedTrigger.current = event.currentTarget;
                      void visit.inspect(entry.revisionId);
                    }}
                  >
                    Inspect version
                  </Button>
                </li>
              ))}
            </ol>
          ) : (
            <p>
              {state.cursor === null && state.page.nextCursor === null
                ? 'No saved book versions yet.'
                : 'No versions on this page.'}
            </p>
          )}
          <div className="studio-action-row">
            {state.page.nextCursor !== null ? (
              <Button type="button" variant="outline" onClick={() => void visit.next()}>
                Older versions
              </Button>
            ) : (
              <p className="studio-help">End of book history.</p>
            )}
            {state.cursor !== null ? (
              <Button type="button" variant="ghost" onClick={() => void visit.restart()}>
                Newest versions
              </Button>
            ) : null}
          </div>
          {state.selection.kind !== 'none' ? (
            <section
              ref={inspector}
              tabIndex={-1}
              className="studio-stack"
              aria-label="Read-only book version"
              aria-busy={state.selection.kind === 'loading'}
            >
              <div className="studio-section-heading">
                <h4>{state.selection.entry.kind === 'structure' ? 'Saved structure' : 'Saved release'} · Read-only</h4>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    visit.closeSelection();
                    selectedTrigger.current?.focus();
                  }}
                >
                  Close inspection
                </Button>
              </div>
              <p className="studio-help">Inspection does not change the draft or the current release.</p>
              <dl className="studio-break">
                <dt>Catalogue</dt>
                <dd>{state.selection.entry.catalogueId}</dd>
                <dt>Version</dt>
                <dd>{state.selection.entry.revisionId}</dd>
                {state.selection.entry.sourceRevisionId ? (
                  <>
                    <dt>Source structure</dt>
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
  if (selection.kind === 'none') return null;
  if (selection.kind === 'loading') return <p role="status">Loading the exact version…</p>;
  if (selection.kind === 'failed')
    return (
      <div role="alert" className="studio-stack">
        <p>{selection.error.message}</p>
        <Button type="button" variant="outline" onClick={() => void visit.inspect(selection.entry.revisionId)}>
          Retry exact version
        </Button>
      </div>
    );
  const rows = bookTocRows(hostedBookStructure(selection.book));
  if (!rows.length)
    return (
      <p>
        {selection.entry.kind === 'publication'
          ? 'This release contains no chapters (withdrawn).'
          : 'This structure has no parts or chapters.'}
      </p>
    );
  return <HistoryOutline rows={rows} parent={null} />;
}

function HistoryOutline({ rows, parent }: { rows: readonly BookTocRow[]; parent: string | null }) {
  return (
    <ol className="studio-toc-branch" aria-label={parent === null ? 'Exact chapter order' : undefined}>
      {rows
        .filter(({ placement }) => placement.parentOccurrenceId === parent)
        .map(({ placement }) => (
          <li key={placement.occurrenceId}>
            <div className="studio-toc-entry">
              <strong>{placement.title}</strong>
              {placement.target.kind === 'chapter' ? (
                <dl className="studio-help studio-break">
                  <dt>Chapter</dt>
                  <dd>{placement.target.document.postId}</dd>
                  <dt>Pinned version</dt>
                  <dd>{placement.target.document.revisionId}</dd>
                  <dt>SHA-256</dt>
                  <dd>{placement.target.document.sha256}</dd>
                </dl>
              ) : (
                <p className="studio-help">Part</p>
              )}
            </div>
            {placement.target.kind === 'part' ? <HistoryOutline rows={rows} parent={placement.occurrenceId} /> : null}
          </li>
        ))}
    </ol>
  );
}
