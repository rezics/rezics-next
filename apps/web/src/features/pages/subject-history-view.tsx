import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import type { MouseEvent, ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { formatCount } from '../count';
import {
  relationHistoryChangesHref,
  relationHistoryCount,
  relationHistoryHref,
  relationHistoryRestartHref,
  type RelationHistorySelection,
} from './subject-history';

const actionClass =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal [overflow-wrap:anywhere] px-4 py-3 text-center focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring';

export type RelationHistoryRevision = { revision: number; kind: string };

export function RelationHistorySelectionView({
  selection,
  count,
  returned,
  revisions,
  next,
  locale,
  children,
  onRetry,
  onMoreHistory,
}: {
  selection: RelationHistorySelection;
  count?: { value: number; exact: boolean } | undefined;
  returned: number;
  revisions?: readonly RelationHistoryRevision[] | undefined;
  next?: string | null | undefined;
  locale: string;
  children?: ReactNode;
  onRetry?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  onMoreHistory?: (cursor: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const options = { locale: locale as never };
  const known = relationHistoryCount(count, returned);
  const origin = relationHistoryHref(selection);
  const changes = relationHistoryChangesHref(selection);
  const restart = relationHistoryRestartHref(selection);
  return (
    <section data-slot="subject-history" className="min-w-0 space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight">{m.changes_title({}, options)}</h2>
      <p data-slot="subject-history-stream" className="text-sm text-muted-foreground">
        {selection.node} {selection.property} {selection.direction}
        {selection.cursor ? ` ${selection.cursor}` : ''}
      </p>
      <p data-slot="subject-history-count" className="text-sm text-muted-foreground tabular-nums">
        {formatCount(known, locale)}
      </p>
      {children}
      {revisions && revisions.length > 0 && (
        <ol data-slot="subject-history-revisions" className="space-y-2">
          {revisions.map((entry) => (
            <li key={entry.revision} className="min-h-11">
              {entry.revision} {entry.kind}
            </li>
          ))}
        </ol>
      )}
      {origin && (
        <a
          data-slot="subject-history-retry"
          href={origin}
          onClick={(event) => onRetry?.(origin, event)}
          className={cn(buttonVariants({ variant: 'outline' }), actionClass)}
        >
          {m.subject_section_retry({}, options)}
        </a>
      )}
      {restart && restart !== origin && (
        <a
          data-slot="subject-history-restart"
          href={restart}
          className={cn(buttonVariants({ variant: 'link' }), actionClass)}
        >
          {m.subject_relation_restart({}, options)}
        </a>
      )}
      {changes && (
        <a
          data-slot="subject-history-changes"
          href={changes}
          className={cn(buttonVariants({ variant: 'link' }), actionClass)}
        >
          {m.changes_title({}, options)}
        </a>
      )}
      {next ? (
        <button
          type="button"
          data-slot="subject-history-more"
          className={cn(buttonVariants({ variant: 'outline' }), actionClass)}
          onClick={(event) => onMoreHistory?.(next, event)}
        >
          {m.subject_section_more({ label: m.changes_title({}, options) }, options)}
        </button>
      ) : null}
    </section>
  );
}
