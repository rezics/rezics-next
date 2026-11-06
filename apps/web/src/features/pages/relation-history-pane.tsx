import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import type { RelationHistorySelection } from './subject-history';
import { RelationHistorySelectionView } from './subject-history-view';
import { loadSubjectHistory, type SubjectHistoryRead, type SubjectHistoryRevision } from './subject-history-reading';

type PaneState = {
  revisions: SubjectHistoryRevision[];
  next: string | null;
  loading: boolean;
  failed: boolean;
  status: number | undefined;
};

const initial: PaneState = { revisions: [], next: null, loading: true, failed: false, status: undefined };

/** Keeps earlier rows when a continuation repeats one revision at the window boundary. */
function appendRevisions(previous: SubjectHistoryRevision[], incoming: SubjectHistoryRevision[]) {
  const seen = new Set(previous.map((row) => row.revision));
  return [...previous, ...incoming.filter((row) => !seen.has(row.revision))];
}

function applyRead(previous: PaneState, read: SubjectHistoryRead, append: boolean): PaneState {
  if (read.kind === 'ready')
    return {
      revisions: append ? appendRevisions(previous.revisions, read.revisions) : read.revisions,
      next: read.next,
      loading: false,
      failed: false,
      status: undefined,
    };
  // A failed read keeps the rows it already showed and the continuation, so retry is not mistaken for the end.
  return { ...previous, loading: false, failed: true, status: read.status };
}

/** Maps a native failure to its own message; only a ready page without `next` ends the history. */
export function relationHistoryFailure(status: number | undefined, locale: string): string {
  const options = { locale: locale as never };
  if (status === 400) return m.changes_invalid({}, options);
  if (status === 403) return m.changes_denied({}, options);
  if (status === 404) return m.changes_missing({}, options);
  if (status === 409) return m.changes_conflict({}, options);
  return m.changes_unavailable({}, options);
}

/** Subject revision history beside a configured relation window. The window selection is exact; history is subject-wide. */
export function RelationHistoryPane({
  selection,
  reader,
}: {
  selection: RelationHistorySelection;
  reader: string | null;
}) {
  const [state, setState] = useState<PaneState>(initial);
  const generation = useRef(0);
  const { subject, locale } = selection;

  useEffect(() => {
    const current = ++generation.current;
    setState(initial);
    loadSubjectHistory({ data: { subject, locale, reader } }).then(
      (read) => {
        if (current === generation.current) setState((previous) => applyRead(previous, read, false));
      },
      () => {
        if (current === generation.current)
          setState((previous) => applyRead(previous, { kind: 'failure', status: undefined }, false));
      },
    );
    return () => {
      generation.current += 1;
    };
  }, [subject, locale, reader]);

  const more = (cursor: string, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const current = generation.current;
    setState((previous) => ({ ...previous, loading: true, failed: false }));
    loadSubjectHistory({ data: { subject, locale, reader, cursor } }).then(
      (read) => {
        if (current === generation.current) setState((previous) => applyRead(previous, read, true));
      },
      () => {
        if (current === generation.current)
          setState((previous) => applyRead(previous, { kind: 'failure', status: undefined }, true));
      },
    );
  };

  const options = { locale: locale as never };
  return (
    <RelationHistorySelectionView
      selection={selection}
      returned={state.revisions.length}
      revisions={state.revisions}
      next={state.next}
      locale={locale}
      onMoreHistory={more}
    >
      {state.loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.changes_loading({}, options)}
        </p>
      ) : null}
      {state.failed ? <p role="alert">{relationHistoryFailure(state.status, locale)}</p> : null}
    </RelationHistorySelectionView>
  );
}
