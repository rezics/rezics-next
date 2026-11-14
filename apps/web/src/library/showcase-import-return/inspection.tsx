import type { ReactNode } from 'react';
import { MemberReadingDetail } from '@rezics/ui/list-presentation';
import { ProgressRow } from '@rezics/ui/progress-row';
import { m } from '../../paraglide/messages.js';
import { SubjectCover, rowRatio } from '../subject-row';
import { vndbActionClass } from '../personal-list-import/controls';
import { importLibraryShelfHref, importLibraryWorkHref } from './navigation';
import type { ImportLibraryRow } from './presentation';
import { ImportLibraryVote } from './vote';
import type { ShelfLayout, ShelfSize } from '../shelf-params';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function NativeDate({ value, locale }: { value: string; locale: string }) {
  const date = new Date(value);
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)}
    </time>
  );
}

/** One supplied occurrence's current facts. There is no inspection read, source overlay or mutation port. */
export function ImportLibraryInspection({
  row,
  locale,
  layout,
  size,
  id,
  opener,
  onClose,
}: {
  row: ImportLibraryRow;
  locale: string;
  layout: ShelfLayout;
  size: ShelfSize;
  id: string;
  opener: HTMLButtonElement;
  onClose: () => void;
}) {
  const work = importLibraryWorkHref(row, locale);
  return (
    <MemberReadingDetail
      id={id}
      opener={opener}
      onClose={onClose}
      title={m.library_vndb_browse_inspection_title()}
      closeLabel={m.library_vndb_browse_inspection_close()}
    >
      <div className="min-w-0 space-y-5" data-vndb-inspected-entry>
        <p className="text-sm text-muted-foreground">{m.library_vndb_browse_inspection_help()}</p>
        <div className="flex min-w-0 items-center gap-3">
          <SubjectCover subject={row.subject} ratio={rowRatio([row.subject])} />
          <h3 lang={row.titleLanguage} className="min-w-0 break-words text-lg font-semibold">
            {row.title}
          </h3>
        </div>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Fact label={m.library_column_status()}>
            <span lang={row.stateLanguage}>{row.state}</span>
          </Fact>
          {row.progress ? (
            <Fact label={m.library_entry_progress()}>
              <ProgressRow
                value={row.progress.percent === null ? null : row.progress.percent / 100}
                label={row.progress.text}
              />
            </Fact>
          ) : null}
          <Fact label={m.library_sort_created()}>
            <NativeDate value={row.entry.createdAt} locale={locale} />
          </Fact>
          <Fact label={m.library_updated()}>
            <NativeDate value={row.entry.updatedAt} locale={locale} />
          </Fact>
          {'lastActivityAt' in row.entry && row.entry.lastActivityAt ? (
            <Fact label={m.library_sort_activity()}>
              <NativeDate value={row.entry.lastActivityAt} locale={locale} />
            </Fact>
          ) : null}
          {'finishedAt' in row.entry && row.entry.finishedAt ? (
            <Fact label={m.library_sort_finished()}>
              <NativeDate value={row.entry.finishedAt} locale={locale} />
            </Fact>
          ) : null}
        </dl>
        <p className="text-xs text-muted-foreground">{m.library_vndb_browse_inspection_dates()}</p>
        {!row.progress ? (
          <p className="text-sm text-muted-foreground">{m.library_vndb_browse_inspection_no_progress()}</p>
        ) : null}
        <ImportLibraryVote row={row} detailed />
        <div className="flex flex-wrap gap-3">
          {work ? (
            <a href={work} className={vndbActionClass + ' inline-flex items-center rounded-md border text-primary'}>
              {m.library_vndb_browse_inspection_work()}
            </a>
          ) : null}
          <a
            href={importLibraryShelfHref(locale, layout, size)}
            className={vndbActionClass + ' inline-flex items-center rounded-md border text-primary'}
          >
            {m.library_vndb_library_open()}
          </a>
        </div>
      </div>
    </MemberReadingDetail>
  );
}
