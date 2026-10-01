'use client';

import { Button } from '@rezics/ui/button';
import { LocalizedText } from '@rezics/ui/localized-text';
import { cn } from '@rezics/ui/utils';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { contentText } from '../language/untagged.ts';
import { ImportError, type ImportRow, type RowResolution } from './import-api.ts';
import { groupOf } from './import-rows.ts';
import { sourceStatusLabel } from './library-import-map.tsx';
import type { LibraryMessages } from './messages.ts';

type T = ReturnType<typeof materializeData<LibraryMessages>>;
const SHOWN = 5;

/** What Main reported for a row that did not apply cleanly, in the reader's words. */
export function issueText(issue: string, t: T): string {
  switch (issue) {
    case 'status-changed': return t.importStatusChanged;
    case 'state-unavailable': return t.importStateUnavailable;
    case 'status-failed': return t.importStatusFailed;
    case 'rating-needs-choice': return t.importRatingChoiceNeeded;
    case 'rating-changed': return t.importRatingChanged;
    case 'rating-failed': return t.importRatingFailed;
    case 'review-needs-rating': return t.importReviewNeedsRating;
    case 'review-changed': return t.importReviewChanged;
    case 'review-failed': return t.importReviewFailed;
    case 'shelf-failed': return t.importShelfFailed;
    case 'unresolved-work': return t.importIssueUnresolved;
    case 'session-failed': return t.importIssueSession;
    default: return t.importIssueOther;
  }
}

function kindLabel(row: ImportRow, t: T): string {
  const { kind } = row.source;
  return kind === 'entry' ? t.importKindEntry : kind === 'session' ? t.importKindSession
    : kind === 'shelf' ? t.importKindShelf : t.importKindRetained;
}

/**
 * One uploaded row and what became of it: the source as the file stated it, Main's match with candidates
 * to choose from, and, once applied, its outcome. Every row can be kept private, which stores it for the
 * reader alone; none is dropped.
 */
export function ImportRowItem({ row, sealed, locale, messages, onResolve, onAdopt }: {
  row: ImportRow; sealed: boolean; locale: UiLocale; messages: LibraryMessages;
  onResolve: (row: ImportRow, choice: RowResolution) => Promise<void>;
  onAdopt: (row: ImportRow, workId: string) => Promise<void>;
}) {
  const t = materializeData(messages, { locale });
  const group = groupOf(row);
  const { source, match } = row;
  const [all, setAll] = useState(false);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const candidates = match?.candidates ?? [];
  const openLibrary = match?.openLibrary ?? [];
  const decided = group === 'matched' || group === 'private';
  const listing = !sealed && (!decided || changing);
  const issues = row.outcome?.issues ?? [];
  const title = source.title || kindLabel(row, t);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);

  async function run(work: () => Promise<void>) {
    setBusy(true); setNote(null);
    try { await work(); setChanging(false); } catch (error) {
      setNote(error instanceof ImportError && error.failure === 'conflict' ? t.importRowChanged
        : error instanceof ImportError && error.failure === 'budget' ? t.importAdoptionBudget : t.importResolveFailed);
    }
    setBusy(false);
  }

  return <li className="grid gap-3 py-4 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,22rem)]"
    data-group={group} data-row={row.index}>
    <div className="grid min-w-0 content-start gap-1">
      <p><LocalizedText text={contentText(title)} as="span" className="font-medium" /></p>
      {source.creators.length ? <p className="text-muted-foreground text-sm">
        {source.creators.map((creator, index) => <span key={creator}>{index ? ', ' : ''}
          <LocalizedText text={contentText(creator)} as="span" /></span>)}</p> : null}
      <p className="flex flex-wrap gap-x-3 text-muted-foreground text-xs">
        {source.status ? <span>{sourceStatusLabel(source.status, t)}</span> : null}
        {source.score ? <span>{t.importSourceRating({ value: `${number(source.score.value)} / ${number(source.score.max)}` })}</span> : null}
        {source.shelves.length ? <span>{source.shelves.join(', ')}</span> : null}
      </p>
      {source.review ? <p className="line-clamp-2 text-muted-foreground text-xs">{source.review.text}</p> : null}
      {row.outcome ? <p
        className={cn('text-xs', issues.length ? 'text-destructive' : 'text-muted-foreground')}>
        {issues.length ? issues.map(issue => issueText(issue, t)).join(' ')
          : row.outcome.applied.some(step => step !== 'private-source') ? t.importRowAdded : t.importRowKeptPrivate}</p> : null}
    </div>
    <div className="grid content-start gap-2">
      {row.outcome ? null : <p className={cn('text-xs', group === 'matched' ? 'text-primary' : 'text-muted-foreground')}>
        {group === 'matched' ? (row.resolution ? t.importChosenNote : t.importMatchedNote)
          : group === 'private' ? t.importPrivateNote : group === 'ambiguous' ? t.importAmbiguousNote : t.importNotFoundNote}</p>}
      {!sealed && decided && candidates.length > 1 ? <Button size="sm" variant="ghost" className="justify-self-start"
        disabled={busy} aria-expanded={changing} onClick={() => setChanging(!changing)}>{t.importChange}</Button> : null}
      {listing && candidates.length ? <div className="grid gap-2">
        <p className="font-medium text-xs">{t.importCandidates}</p>
        {(all ? candidates : candidates.slice(0, SHOWN)).map(candidate => <Button key={candidate.work} size="sm"
          variant="outline" disabled={busy} className="h-auto w-full justify-start whitespace-normal p-2 text-left text-xs"
          onClick={() => void run(() => onResolve(row, { choice: 'apply', work: candidate.work,
            ...candidate.target ? { target: candidate.target } : {} }))}>
          <span><LocalizedText text={contentText(candidate.title)} as="span" className="font-medium" /><br />
            {candidate.creators.join(', ')}<span className="sr-only"> — {t.importChoose}</span></span></Button>)}
        {candidates.length > SHOWN ? <Button size="sm" variant="ghost" className="justify-self-start"
          aria-expanded={all} onClick={() => setAll(!all)}>{all ? t.importFewerMatches
            : t.importAllMatches({ count: number(candidates.length) })}</Button> : null}
        {match?.truncated ? <p className="text-muted-foreground text-xs">{t.importTruncated}</p> : null}
      </div> : null}
      {listing && openLibrary.length ? <div className="grid gap-2">
        <p className="font-medium text-xs">{t.importOpenLibrary}</p>
        {openLibrary.map(candidate => <div key={candidate.workId}
          className="flex items-center justify-between gap-2 rounded-lg border p-2 text-xs">
          <span className="min-w-0"><LocalizedText text={contentText(candidate.title)} as="span" className="font-medium" /><br />
            {candidate.authors.join(', ')}</span>
          <Button size="sm" variant="outline" disabled={busy} className="shrink-0"
            onClick={() => void run(() => onAdopt(row, candidate.workId))}>{t.importAddOpenLibrary}</Button>
        </div>)}
      </div> : null}
      {listing && !openLibrary.length && match?.openLibraryAvailability === 'budget-exceeded'
        ? <p className="text-muted-foreground text-xs">{t.importSearchBudget}</p> : null}
      {listing && !openLibrary.length && match?.openLibraryAvailability === 'unavailable'
        ? <p className="text-muted-foreground text-xs">{t.importOpenLibraryDown}</p> : null}
      {!sealed && group !== 'private' ? <Button size="sm" variant="outline" className="justify-self-start" disabled={busy}
        onClick={() => void run(() => onResolve(row, { choice: 'private' }))}>
        {t.importKeepPrivate}<span className="sr-only"> — {title}</span></Button> : null}
      {note ? <p role="alert" className="text-destructive text-xs">{note}</p> : null}
    </div>
  </li>;
}
