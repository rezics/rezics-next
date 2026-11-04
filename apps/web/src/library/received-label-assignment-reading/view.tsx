import type { RefObject } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { ReceivedObservation, ReceivedReading } from './selection';
import { ReceivedAssignmentObservation } from './observation';

/** One inline reading surface: complete observation order on narrow screens, two columns when space permits. */
export function ReceivedAssignmentReader({
  id,
  membershipId,
  headingRef,
  label,
  locale,
  reading,
  isCurrent,
  close,
  remove,
  replace,
  cancelReplacement,
}: {
  id: string;
  membershipId: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  label: { id: string; name: string };
  locale: string;
  reading: ReceivedReading;
  isCurrent: () => boolean;
  close: () => void;
  remove: (item: ReceivedObservation) => void;
  replace: (item: ReceivedObservation) => void;
  cancelReplacement: () => void;
}) {
  const titleId = `${id}-title`;
  const countId = `${id}-count`;
  const comparison = reading.selected.length === 2;
  if (!isCurrent()) return null;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      aria-describedby={`${countId} ${membershipId}`}
      className="min-w-0 space-y-4 rounded-xl border bg-muted/20 p-3 sm:p-5"
      data-received-assignment-reader=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || !isCurrent()) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <h2
            id={titleId}
            ref={headingRef}
            tabIndex={-1}
            className="rounded-sm text-xl font-semibold break-words focus-visible:outline-2 focus-visible:outline-ring"
          >
            {comparison ? m.library_received_reading_comparison() : m.library_received_reading_heading()}
          </h2>
          <p id={countId} role="status" className="text-sm font-medium">
            {m.library_received_reading_count({ count: reading.selected.length })}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 max-w-full whitespace-normal break-words"
          onClick={() => {
            if (isCurrent()) close();
          }}
          data-received-close=""
        >
          {m.library_received_reading_close()}
        </Button>
      </header>
      <p id={membershipId} className="text-sm text-muted-foreground">
        {m.library_received_reading_scope()}
      </p>
      <p className="text-sm text-muted-foreground">
        {comparison ? m.library_received_reading_comparison_meaning() : m.library_received_reading_choose_second()}
      </p>
      {reading.replacement ? (
        <div role="status" className="min-w-0 space-y-3 rounded-lg border bg-background p-3">
          <p className="break-words">
            {m.library_received_reading_replacing({ position: reading.replacement.position })}
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 whitespace-normal"
            onClick={() => {
              if (isCurrent()) cancelReplacement();
            }}
            data-received-cancel-replacement=""
          >
            {m.library_received_reading_cancel_replacement()}
          </Button>
        </div>
      ) : comparison ? (
        <p className="text-sm text-muted-foreground">{m.library_received_reading_limit()}</p>
      ) : null}
      <div className={comparison ? 'grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2' : 'min-w-0'}>
        {reading.selected.map((observation) => (
          <ReceivedAssignmentObservation
            key={observation.row.id}
            observation={observation}
            label={label}
            locale={locale}
            isCurrent={isCurrent}
            remove={() => remove(observation)}
            replace={() => replace(observation)}
            replacing={reading.replacement === observation}
          />
        ))}
      </div>
    </section>
  );
}
