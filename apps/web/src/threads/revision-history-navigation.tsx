import { Button } from '@rezics/ui/shadcn/button';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { HistoryPage, HistoryView } from './post-history-lifetime';
import { RevisionSummaryRow } from './revision-history-entry';
import { projectRevisionSummaries } from './revision-history-summary';

type FocusIntent = { index: number; source: Element | null };

type RevisionHistoryNavigationProps = {
  entries: HistoryView['revisions'];
  authors: HistoryPage['authors'];
  mentions: HistoryPage['mentions'];
  subjects: HistoryPage['subjects'];
  reviewVotes: HistoryPage['reviewVotes'];
  now: string;
  viewerId?: string | undefined;
  review: boolean;
  active: boolean;
  hasMore: boolean;
  /** The existing disclosure, rather than a matching identity tuple, admits local callbacks. */
  isCurrent: () => boolean;
  boundaryRevisionId?: string | null | undefined;
};

const navigationAction =
  'h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/**
 * Page-local inspection of supplied entries. No read function or QueryClient is owned here.
 * The parent keys this subtree by connection and its own retiring lifetime.
 * State is one selected index and one transient focus intent, independent of history length.
 */
export function RevisionHistoryNavigation(props: RevisionHistoryNavigationProps) {
  const {
    entries,
    authors,
    mentions,
    subjects,
    reviewVotes,
    viewerId,
    review,
    active,
    hasMore,
    isCurrent,
    boundaryRevisionId,
  } = props;
  const locale = getLocale();
  const prefix = `history-inspection-${useId().replaceAll(':', '')}`;
  const helpId = `${prefix}-help`;
  const statusId = `${prefix}-status`;
  const list = useRef<HTMLOListElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [destination, setDestination] = useState('');
  const focusIntent = useRef<FocusIntent | null>(null);
  const live = useRef(false);
  const current = useRef({ active, isCurrent, length: entries.length, selected });
  current.current = { active, isCurrent, length: entries.length, selected };
  const summaries = useMemo(() => projectRevisionSummaries(entries, authors, locale), [entries, authors, locale]);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const inspecting = selected !== null && selected < summaries.length ? selected : null;

  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      focusIntent.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    if (!active) focusIntent.current = null;
  }, [active]);

  useLayoutEffect(() => {
    const intent = focusIntent.current;
    focusIntent.current = null;
    if (!intent || !active || !isCurrent() || document.activeElement !== intent.source) return;
    document.getElementById(`${prefix}-inspect-${intent.index}`)?.focus({ preventScroll: true });
  }, [selected, active, isCurrent, prefix]);

  function ownsInteraction() {
    const owner = current.current;
    return live.current && owner.active && owner.isCurrent();
  }

  function inspect(index: number, handoff = false) {
    if (!ownsInteraction() || !Number.isSafeInteger(index) || index < 0 || index >= current.current.length) return;
    focusIntent.current = handoff ? { index, source: document.activeElement } : null;
    // Jumping to the inspected row still needs a focus handoff even when React can retain the same index.
    if (index === selected && handoff) {
      focusIntent.current = null;
      document.getElementById(`${prefix}-inspect-${index}`)?.focus({ preventScroll: true });
    }
    setSelected(index);
    setDestination(String(index));
  }

  function collapse(index: number) {
    if (!ownsInteraction() || current.current.selected !== index) return;
    focusIntent.current = null;
    const trigger = document.getElementById(`${prefix}-inspect-${index}`);
    const inspector = document.getElementById(`${prefix}-detail-${index}`);
    // Do not steal focus from another control when a retained callback runs after focus moved away.
    if (inspector?.contains(document.activeElement)) trigger?.focus({ preventScroll: true });
    setSelected(null);
  }

  function moveFocus(event: KeyboardEvent<HTMLOListElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.hasAttribute('data-history-inspect') || !ownsInteraction()) return;
    const index = Number(target.dataset.historyInspect);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(summaries.length - 1, index + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, index - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = summaries.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    document.getElementById(`${prefix}-inspect-${next}`)?.focus();
  }

  return (
    <>
      <div className="min-w-0 space-y-3 rounded-lg bg-muted/40 p-3 [overflow-wrap:anywhere]">
        <p className="text-sm font-medium">{m.revision_history_loaded({ count: number(summaries.length) })}</p>
        <p id={helpId} className="text-sm text-muted-foreground">
          {m.revision_history_loaded_help()}
        </p>
        <details className="min-w-0 text-sm text-muted-foreground">
          <summary className="inline-flex min-h-11 max-w-full cursor-pointer items-center rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {m.revision_history_about()}
          </summary>
          <div className="space-y-2 pt-2">
            <p>{m.revision_history_privacy_help()}</p>
            <p>{m.revision_history_provenance_help()}</p>
            <p>{m.revision_history_return_help()}</p>
          </div>
        </details>
        <nav aria-label={m.revision_history_navigator()} aria-describedby={helpId} className="min-w-0 space-y-3">
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <div className="grid min-w-0 flex-1 gap-1">
              <label htmlFor={`${prefix}-destination`} className="text-sm font-medium">
                {m.revision_history_choose()}
              </label>
              <select
                id={`${prefix}-destination`}
                value={destination}
                onChange={(event) => {
                  if (ownsInteraction()) setDestination(event.currentTarget.value);
                }}
                aria-describedby={helpId}
                className="min-h-11 w-full min-w-0 max-w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <option value="">{m.revision_history_choose_placeholder()}</option>
                {summaries.map((summary) => (
                  <option key={summary.revisionId} value={String(summary.index)}>
                    {m.thread_history_version({ number: number(summary.index + 1) })}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              variant="outline"
              className={navigationAction}
              disabled={destination === ''}
              onClick={() => inspect(Number(destination), true)}
            >
              {m.revision_history_go()}
            </Button>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              className={navigationAction}
              disabled={inspecting === null || inspecting === 0}
              onClick={() => inspecting !== null && inspect(inspecting - 1, true)}
            >
              {m.revision_history_previous()}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className={navigationAction}
              disabled={inspecting === null || inspecting === summaries.length - 1}
              onClick={() => inspecting !== null && inspect(inspecting + 1, true)}
            >
              {m.revision_history_next()}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{m.revision_history_keyboard_help()}</p>
        </nav>
        <p id={statusId} role="status" aria-live="polite" aria-atomic="true" className="text-sm">
          {inspecting === null
            ? m.revision_history_none()
            : m.revision_history_inspecting({ number: number(inspecting + 1), count: number(summaries.length) })}
        </p>
        {hasMore ? <p className="text-xs text-muted-foreground">{m.revision_history_more_help()}</p> : null}
      </div>
      <ol
        ref={list}
        aria-label={m.thread_history_heading()}
        aria-describedby={helpId}
        className="min-w-0 divide-y divide-border/60"
        onKeyDown={moveFocus}
      >
        {summaries.map((summary) => {
          const entry = entries[summary.index]!;
          return (
            <RevisionSummaryRow
              key={summary.revisionId}
              summary={summary}
              entry={entry}
              active={active}
              expanded={inspecting === summary.index}
              triggerId={`${prefix}-inspect-${summary.index}`}
              inspectorId={`${prefix}-detail-${summary.index}`}
              mentions={mentions}
              subjects={subjects}
              currentVote={viewerId === entry.revision.authorId ? reviewVotes[entry.revision.id] : undefined}
              review={review}
              focusBoundary={boundaryRevisionId === summary.revisionId}
              onInspect={() => inspect(summary.index)}
              onCollapse={() => collapse(summary.index)}
            />
          );
        })}
      </ol>
    </>
  );
}
