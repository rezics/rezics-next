import { Button } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import type { OwnVoteEntry } from './types';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { ownVoteChangedAt, ownVoteScale, ownVoteValue, ownVoteSubjectLabel } from './presentation';
import { votePairKey } from './inventory';

export function OwnVotesInspection({
  entries,
  locale,
  selectedPair,
  disabled,
  onSelect,
}: {
  entries: readonly OwnVoteEntry[];
  locale: string;
  selectedPair: string | null;
  disabled: boolean;
  onSelect: (entry: OwnVoteEntry) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <ol className="space-y-3" aria-label={m.library_my_ratings_heading()}>
      {entries.map((entry) => {
        const pair = votePairKey(entry);
        const destination = subjectHref({ id: entry.subject.id, label: ownVoteSubjectLabel(entry, locale) }, locale);
        const changedAt = ownVoteChangedAt(entry, locale);
        return (
          <li key={pair} data-own-vote-pair={pair} className="rounded-xl border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <Link
                  className="break-words font-semibold underline-offset-4 hover:underline"
                  to={destination.to}
                  params={destination.params}
                >
                  {ownVoteSubjectLabel(entry, locale)}
                </Link>
                <p className="break-words">{entry.question.label}</p>
                <p className="text-sm text-muted-foreground">
                  {m.library_my_ratings_value()}: {ownVoteValue(entry, locale)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {m.library_my_ratings_scale()}: {ownVoteScale(entry, locale)}
                </p>
                {changedAt ? (
                  <p className="text-sm text-muted-foreground">
                    {m.library_my_ratings_changed()}: <time dateTime={entry.own.at}>{changedAt}</time>
                  </p>
                ) : null}
                <p className="break-all text-xs text-muted-foreground">
                  {m.library_my_ratings_original_key()}: {entry.targetId} · {entry.questionId}
                </p>
              </div>
              <Button
                className="min-h-11 shrink-0"
                variant={selectedPair === pair ? 'secondary' : 'outline'}
                aria-pressed={selectedPair === pair}
                disabled={disabled}
                onClick={() => onSelect(entry)}
              >
                {m.library_my_ratings_inspect()}
              </Button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
