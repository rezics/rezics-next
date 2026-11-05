import { useId } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { subjectHref } from '../../subject/subject-href';
import { displayLibraryTitle } from '../title';
import { currentShelfWorkContext } from '../shelf-work-context/context';
import { ShelfWorkContextView } from '../shelf-work-context/view';
import type { PersonalLibraryEntry } from '../entries-read';
import type { ShelfRow } from '../shelf-rows';
import { ReceivedEntryDates } from './dates';
import { ReceivedEntryProgress } from './progress';

function statePresentation(entry: PersonalLibraryEntry, locale: string) {
  const options = { locale: locale as Locale };
  const released = entry.stateOptions?.find((option) => option.id === entry.state);
  if (released) return { label: released.label.text, lang: released.label.lang, known: true };
  if (entry.stateLabel && entry.stateLabel !== m.library_other({}, options))
    return { label: entry.stateLabel, lang: undefined, known: true };
  return { label: entry.state, lang: undefined, known: false };
}

function RowOutcome({ row, locale }: { row: ShelfRow; locale: string }) {
  const options = { locale: locale as Locale };
  const messages = [
    row.unknownIntent ? m.library_entry_reading_state_unknown({}, options) : null,
    row.unknownLabelIntent ? m.library_entry_reading_label_unknown({}, options) : null,
    row.unknownRemove ? m.library_entry_reading_removal_unknown({}, options) : null,
    row.conflict ? m.library_entry_reading_conflict({}, options) : null,
    row.failure ? m.library_entry_reading_failure({}, options) : null,
  ].filter((message): message is string => message !== null);
  if (!messages.length) return null;
  return (
    <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-50/60 p-3 text-sm dark:bg-amber-950/20">
      {messages.map((message, index) => (
        <p key={`${index}:${message}`}>{message}</p>
      ))}
      <p className="text-muted-foreground">{m.library_entry_reading_last_received({}, options)}</p>
    </div>
  );
}

export function ReceivedEntryRecord({
  row,
  locale,
  isCurrent,
  progressAdmitted,
  openProgress,
}: {
  row: ShelfRow;
  locale: string;
  isCurrent: () => boolean;
  progressAdmitted: boolean;
  openProgress: () => void;
}) {
  const stateId = useId();
  const contextId = useId();
  const destinationsId = useId();
  const { entry } = row;
  const options = { locale: locale as Locale };
  const title = entry.subject ? displayLibraryTitle(entry.subject.label, locale) : null;
  const state = statePresentation(entry, locale);
  const context = currentShelfWorkContext(entry, locale);
  const workHref =
    entry.subject && title
      ? subjectHref({ id: entry.subject.id, label: title.text }, locale).href
      : null;
  if (!isCurrent()) return null;

  return (
    <article className="min-w-0 space-y-4" data-received-entry-record="">
      <RowOutcome row={row} locale={locale} />
      <section aria-labelledby={stateId} className="min-w-0 space-y-2">
        <h3 id={stateId} className="font-medium">
          {m.library_entry_reading_state_heading({}, options)}
        </h3>
        <p className="[overflow-wrap:anywhere]" lang={state.lang} dir="auto">
          {state.known ? state.label : <code dir="ltr">{state.label}</code>}
        </p>
        {!state.known ? (
          <p className="text-sm text-muted-foreground">{m.library_entry_reading_state_unreleased({}, options)}</p>
        ) : null}
      </section>
      <ReceivedEntryDates entry={entry} locale={locale} isCurrent={isCurrent} />
      <ReceivedEntryProgress progress={entry.activeProgressSession ?? null} locale={locale} />
      <section aria-labelledby={contextId} className="min-w-0 space-y-2">
        <h3 id={contextId} className="font-medium">
          {m.library_entry_reading_context_heading({}, options)}
        </h3>
        {context?.facts.length ? (
          <ShelfWorkContextView entry={entry} locale={locale} isCurrent={isCurrent} />
        ) : (
          <p className="text-sm text-muted-foreground">{m.library_entry_reading_context_unavailable({}, options)}</p>
        )}
      </section>
      <section aria-labelledby={destinationsId} className="min-w-0 space-y-3 border-t pt-4">
        <h3 id={destinationsId} className="font-medium">
          {m.library_entry_reading_destinations_heading({}, options)}
        </h3>
        <div className="flex min-w-0 flex-wrap gap-2">
          {workHref ? (
            <a
              href={workHref}
              className={buttonVariants({ variant: 'outline', className: 'h-auto min-h-11 whitespace-normal break-words' })}
              aria-label={m.library_entry_reading_open_work_named({ title: title!.text }, options)}
              data-received-entry-work-destination=""
              onClick={(event) => {
                if (!isCurrent()) event.preventDefault();
              }}
            >
              {m.library_entry_reading_open_work({}, options)}
            </a>
          ) : (
            <p className="self-center text-sm text-muted-foreground">
              {m.library_entry_reading_work_unavailable({}, options)}
            </p>
          )}
          {entry.subject && progressAdmitted ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 max-w-full whitespace-normal break-words"
              aria-label={m.library_entry_reading_open_progress_named({ title: title!.text }, options)}
              data-received-entry-progress-destination=""
              onClick={() => {
                if (isCurrent()) openProgress();
              }}
            >
              {m.library_entry_reading_open_progress({}, options)}
            </Button>
          ) : (
            <p className="self-center text-sm text-muted-foreground">
              {m.library_entry_reading_progress_destination_unavailable({}, options)}
            </p>
          )}
        </div>
      </section>
    </article>
  );
}
