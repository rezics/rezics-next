import { useId, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import type { OwnVoteEntry } from './types';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { ownVoteChangedAt, ownVoteScale, ownVoteValue, ownVoteSubjectLabel } from './presentation';
import { votePairKey } from './inventory';

/** One original pair per row, even when two summaries open the same merged Subject. */
export function OwnVotesInspection({
  entries,
  locale,
  selectedPair,
  disabled,
  onSelect,
  onVisit,
  selectedEditor,
}: {
  entries: readonly OwnVoteEntry[];
  locale: string;
  selectedPair: string | null;
  disabled: boolean;
  onSelect: (entry: OwnVoteEntry) => void;
  onVisit?: (entry: OwnVoteEntry) => void;
  selectedEditor?: ReactNode;
}) {
  const id = useId();
  if (entries.length === 0) return null;
  return (
    <ol className="divide-y border-y" aria-label={m.library_my_ratings_heading()}>
      {entries.map((entry, index) => {
        const pair = votePairKey(entry);
        const selected = selectedPair === pair;
        const destination = subjectHref({ id: entry.subject.id, label: ownVoteSubjectLabel(entry, locale) }, locale);
        const changedAt = ownVoteChangedAt(entry, locale);
        const editorId = `${id}-${index}-editor`;
        return (
          <li
            key={pair}
            data-own-vote-pair={pair}
            data-own-vote-target={entry.targetId}
            data-own-vote-question={entry.questionId}
            data-selected={selected || undefined}
            className="min-w-0 py-5 sm:py-6"
          >
            <div className="flex min-w-0 items-start justify-between gap-4 sm:gap-6">
              <div className="min-w-0 flex-1 space-y-2">
                <h2 className="text-lg leading-snug font-semibold wrap-anywhere">
                  <Link
                    className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                    to={destination.to}
                    params={destination.params}
                    onClick={() => onVisit?.(entry)}
                  >
                    {ownVoteSubjectLabel(entry, locale)}
                  </Link>
                </h2>
                <p className="text-sm leading-relaxed wrap-anywhere sm:text-base">{entry.question.label}</p>
                {changedAt ? (
                  <p className="text-xs text-muted-foreground sm:text-sm">
                    {m.library_my_ratings_changed()} <time dateTime={entry.own.at}>{changedAt}</time>
                  </p>
                ) : null}
              </div>
              <div className="flex w-28 shrink-0 flex-col items-end gap-2 sm:w-36">
                <p className="text-end text-xl leading-tight font-semibold tabular-nums sm:text-2xl">
                  <span className="sr-only">{m.library_my_ratings_value()}: </span>
                  {ownVoteValue(entry, locale)}
                </p>
                <Button
                  className="h-auto min-h-11 max-w-full whitespace-normal wrap-anywhere py-2"
                  variant={selected ? 'secondary' : 'outline'}
                  aria-pressed={selected}
                  aria-expanded={selected}
                  aria-controls={selected ? editorId : undefined}
                  disabled={disabled}
                  onClick={() => onSelect(entry)}
                >
                  {m.library_my_ratings_inspect()}
                </Button>
              </div>
            </div>
            {selected ? (
              <div id={editorId} className="mt-4" data-slot="own-vote-selected">
                {selectedEditor}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground sm:text-sm">{ownVoteScale(entry, locale)}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
