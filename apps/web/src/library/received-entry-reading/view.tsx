import type { RefObject } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { ShelfRow } from '../shelf-rows';
import { displayLibraryTitle } from '../title';
import { ReceivedEntryRecord } from './entry';

export function ReceivedEntryReader({
  id,
  headingRef,
  row,
  locale,
  isCurrent,
  progressAdmitted,
  close,
  openProgress,
}: {
  id: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  row: ShelfRow;
  locale: string;
  isCurrent: () => boolean;
  progressAdmitted: boolean;
  close: () => void;
  openProgress: () => void;
}) {
  const titleId = `${id}-title`;
  const scopeId = `${id}-scope`;
  const options = { locale: locale as Locale };
  const title = row.entry.subject ? displayLibraryTitle(row.entry.subject.label, locale) : null;
  if (!isCurrent()) return null;
  return (
    <section
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={scopeId}
      className="fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] min-w-0 overflow-y-auto rounded-t-2xl border bg-background p-4 text-foreground shadow-2xl sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:max-h-none sm:w-[min(38rem,calc(100vw-1rem))] sm:rounded-none sm:border-t-0 sm:border-r-0 sm:border-b-0 sm:border-l sm:p-6"
      data-received-entry-reading=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || !isCurrent()) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <header className="mb-4 flex min-w-0 flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div className="min-w-0 flex-1 space-y-2">
          <h2
            id={titleId}
            ref={headingRef}
            tabIndex={-1}
            className="break-words text-xl font-semibold focus-visible:outline-2 focus-visible:outline-ring"
          >
            {m.library_entry_reading_heading({}, options)}
          </h2>
          <p className="break-words text-sm font-medium" lang={title?.lang} dir="auto">
            {title?.text ?? m.library_subject_unavailable({}, options)}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 max-w-full whitespace-normal break-words"
          data-received-entry-reading-close=""
          onClick={() => {
            if (isCurrent()) close();
          }}
        >
          {m.library_entry_reading_close({}, options)}
        </Button>
      </header>
      <p id={scopeId} className="mb-4 text-sm text-muted-foreground">
        {m.library_entry_reading_scope({}, options)}
      </p>
      <ReceivedEntryRecord
        row={row}
        locale={locale}
        isCurrent={isCurrent}
        progressAdmitted={progressAdmitted}
        openProgress={openProgress}
      />
    </section>
  );
}
