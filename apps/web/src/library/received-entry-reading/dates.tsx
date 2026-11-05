import { useId } from 'react';
import { RelativeTime } from '@rezics/ui/relative-time';
import type { Locale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import type { PersonalLibraryEntry } from '../entries-read';

function Instant({
  value,
  locale,
  isCurrent,
}: {
  value: string;
  locale: string;
  isCurrent: () => boolean;
}) {
  const exactId = useId();
  const formatted = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
  const options = { locale: locale as Locale };
  return (
    <div className="min-w-0 space-y-1">
      <time dateTime={value}>{formatted}</time>
      <p className="text-xs text-muted-foreground">
        <RelativeTime value={value} locale={locale} timeZone="UTC" />
      </p>
      <details
        data-entry-reading-exact-date=""
        onToggle={(event) => {
          if (!isCurrent() && event.currentTarget.open) event.currentTarget.open = false;
        }}
      >
        <summary
          aria-controls={exactId}
          className="min-h-11 w-fit max-w-full cursor-pointer rounded-sm py-2 text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={(event) => {
            if (!isCurrent()) event.preventDefault();
          }}
        >
          {m.library_entry_reading_exact_value({}, options)}
        </summary>
        <code id={exactId} dir="ltr" className="block break-all rounded bg-muted px-2 py-1 text-xs">
          {value}
        </code>
      </details>
    </div>
  );
}

function DateValue({
  value,
  locale,
  isCurrent,
}: {
  value: string | null | undefined;
  locale: string;
  isCurrent: () => boolean;
}) {
  const options = { locale: locale as Locale };
  if (value === undefined) return <span>{m.library_entry_reading_date_not_supplied({}, options)}</span>;
  if (value === null) return <span>{m.library_entry_reading_date_empty({}, options)}</span>;
  return <Instant value={value} locale={locale} isCurrent={isCurrent} />;
}

export function ReceivedEntryDates({
  entry,
  locale,
  isCurrent,
}: {
  entry: PersonalLibraryEntry;
  locale: string;
  isCurrent: () => boolean;
}) {
  const options = { locale: locale as Locale };
  return (
    <section aria-labelledby="received-entry-dates" className="min-w-0 space-y-3 py-4">
      <h3 id="received-entry-dates" className="font-medium">
        {m.library_entry_reading_dates_heading({}, options)}
      </h3>
      <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-4 text-sm">
        <dt className="break-words text-muted-foreground">{m.library_entry_reading_created({}, options)}</dt>
        <dd className="min-w-0 break-words">
          <Instant value={entry.createdAt} locale={locale} isCurrent={isCurrent} />
        </dd>
        <dt className="break-words text-muted-foreground">{m.library_entry_reading_updated({}, options)}</dt>
        <dd className="min-w-0 break-words">
          <Instant value={entry.updatedAt} locale={locale} isCurrent={isCurrent} />
        </dd>
        <dt className="break-words text-muted-foreground">
          {m.library_entry_reading_last_activity({}, options)}
        </dt>
        <dd className="min-w-0 break-words">
          <DateValue value={entry.lastActivityAt} locale={locale} isCurrent={isCurrent} />
        </dd>
        <dt className="break-words text-muted-foreground">{m.library_entry_reading_finished({}, options)}</dt>
        <dd className="min-w-0 break-words">
          <DateValue value={entry.finishedAt} locale={locale} isCurrent={isCurrent} />
        </dd>
      </dl>
      <p className="text-sm text-muted-foreground">{m.library_entry_reading_dates_meaning({}, options)}</p>
    </section>
  );
}
