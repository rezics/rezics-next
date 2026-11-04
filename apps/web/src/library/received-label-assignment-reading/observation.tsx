import { useId } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { displayLibraryTitle } from '../title';
import { ShelfWorkContextView } from '../shelf-work-context/view';
import { currentShelfWorkContext } from '../shelf-work-context/context';
import type { ReceivedObservation } from './selection';
import { ReceivedProgress } from './progress';

export function ReceivedAssignmentObservation({
  observation,
  label,
  locale,
  isCurrent,
  remove,
  replace,
  replacing,
}: {
  observation: ReceivedObservation;
  label: { id: string; name: string };
  locale: string;
  isCurrent: () => boolean;
  remove: () => void;
  replace: () => void;
  replacing: boolean;
}) {
  const { row, position } = observation;
  const titleId = useId();
  const membershipId = useId();
  const entryId = useId();
  const progressId = useId();
  const contextId = useId();
  const destinationId = useId();
  const title = row.subject ? displayLibraryTitle(row.subject.label, locale) : null;
  const context = currentShelfWorkContext(row, locale);
  // This is the same canonical destination used by the originating Label shelf row.
  // The FULL row does not supply a Progress destination or the existing bounded return facility.
  const workHref = row.subject && title ? subjectHref({ id: row.subject.id, label: title.text }, locale).href : null;
  if (!isCurrent()) return null;
  return (
    <article
      aria-labelledby={titleId}
      data-received-assignment-observation=""
      className="min-w-0 rounded-lg border bg-background p-4 text-foreground sm:p-5"
    >
      <header className="min-w-0 space-y-2 border-b pb-4">
        <p className="text-sm text-muted-foreground">{m.library_received_reading_assignment({ position })}</p>
        <h3 id={titleId} lang={title?.lang} dir="auto" className="text-lg font-semibold [overflow-wrap:anywhere]">
          {title?.text ?? m.library_subject_unavailable()}
        </h3>
        {row.subject?.typeLabel ? <p className="text-sm text-muted-foreground">{row.subject.typeLabel}</p> : null}
        <div className="flex min-w-0 flex-wrap gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-auto min-h-11 whitespace-normal break-words"
            aria-describedby={titleId}
            aria-pressed={replacing}
            onClick={() => {
              if (isCurrent()) replace();
            }}
            data-received-replace=""
          >
            {m.library_received_reading_replace()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto min-h-11 whitespace-normal break-words"
            aria-describedby={titleId}
            onClick={() => {
              if (isCurrent()) remove();
            }}
            data-received-remove=""
          >
            {m.library_received_reading_remove()}
          </Button>
        </div>
      </header>
      <div className="min-w-0 divide-y">
        <section aria-labelledby={membershipId} className="min-w-0 space-y-2 py-4">
          <h4 id={membershipId} className="font-medium">
            {m.library_received_reading_membership()}
          </h4>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">
            {label.name}
          </p>
          <p className="text-sm text-muted-foreground">{m.library_received_reading_membership_meaning()}</p>
        </section>
        <section aria-labelledby={entryId} className="min-w-0 space-y-2 py-4">
          <h4 id={entryId} className="font-medium">
            {m.library_received_reading_entry_state()}
          </h4>
          <p className="[overflow-wrap:anywhere]" dir="auto">
            {row.state ? (row.stateLabel ?? m.library_other()) : m.library_received_reading_state_unavailable()}
          </p>
          {!row.entryIdentity ? (
            <p className="text-sm text-muted-foreground">{m.library_received_reading_entry_unavailable()}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{m.library_received_reading_entry_meaning()}</p>
          )}
        </section>
        <section aria-labelledby={progressId} className="min-w-0 space-y-3 py-4">
          <h4 id={progressId} className="font-medium">
            {m.library_received_reading_progress()}
          </h4>
          <ReceivedProgress progress={row.activeProgressSession ?? null} locale={locale} />
        </section>
        <section aria-labelledby={contextId} className="min-w-0 space-y-2 py-4">
          <h4 id={contextId} className="font-medium">
            {m.library_received_reading_work_context()}
          </h4>
          {context?.facts.length ? (
            <ShelfWorkContextView entry={row} locale={locale} isCurrent={isCurrent} />
          ) : (
            <p className="text-sm text-muted-foreground">{m.library_received_reading_context_unavailable()}</p>
          )}
        </section>
        <section aria-labelledby={destinationId} className="min-w-0 space-y-3 pt-4">
          <h4 id={destinationId} className="font-medium">
            {m.library_received_reading_destinations()}
          </h4>
          {workHref ? (
            <a
              href={workHref}
              className={buttonVariants({
                variant: 'outline',
                className: 'h-auto min-h-11 max-w-full whitespace-normal break-words',
              })}
              aria-describedby={titleId}
              data-received-work-destination=""
              onClick={(event) => {
                if (!isCurrent()) event.preventDefault();
              }}
            >
              {m.library_received_reading_open_work()}
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">{m.library_received_reading_work_unavailable()}</p>
          )}
          <p className="text-sm text-muted-foreground">
            {m.library_received_reading_progress_destination_unavailable()}
          </p>
        </section>
      </div>
    </article>
  );
}
