import { Fragment, type ReactNode } from 'react';
import { CoverGrid, type CoverDensity } from '@rezics/ui/cover-card';
import { MemberReadingItem } from '@rezics/ui/list-presentation';
import { ProgressRow } from '@rezics/ui/progress-row';
import { RelativeTime } from '@rezics/ui/relative-time';
import { ShelfList } from '@rezics/ui/shelf-list';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rezics/ui/shadcn/table';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { SubjectCover, coverSubject, rowRatio } from '../subject-row';
import type { ShelfLayout, ShelfSize } from '../shelf-params';
import { importLibraryWorkHref } from './navigation';
import type { ImportLibraryRow } from './presentation';
import { ImportLibraryVote } from './vote';
import { VndbAction } from '../personal-list-import/controls';

const density: Record<ShelfSize, CoverDensity> = { s: 'small', m: 'medium', l: 'large' };

function progress(row: ImportLibraryRow) {
  return row.progress
    ? { value: row.progress.percent === null ? null : row.progress.percent / 100, label: row.progress.text }
    : undefined;
}

function State({ row }: { row: ImportLibraryRow }) {
  return (
    <span lang={row.stateLanguage} data-vndb-native-state>
      {row.state}
    </span>
  );
}

function Activity({ row, locale }: { row: ImportLibraryRow; locale: string }) {
  // updatedAt is supplied Entry activity; never replace it with the import acknowledgement time.
  const activity = 'lastActivityAt' in row.entry ? row.entry.lastActivityAt : undefined;
  return <RelativeTime value={activity ?? row.entry.updatedAt} locale={locale} timeZone="UTC" />;
}

/** Every disclosed Subject association comes from its original native row, never the import's target choices. */
export function ImportLibraryRows({
  rows,
  locale,
  layout,
  size,
  onInspect,
  selectedIndex,
  detailId,
  detail,
  onClose,
}: {
  rows: readonly ImportLibraryRow[];
  locale: string;
  layout: ShelfLayout;
  size: ShelfSize;
  onInspect: (index: number, launcher: HTMLButtonElement) => void;
  selectedIndex: number | null;
  detailId: string;
  detail: ReactNode;
  onClose: () => void;
}) {
  const ratio = rowRatio(rows.map((row) => row.subject));
  const cover = (row: ImportLibraryRow) => ({
    subject: coverSubject(row.subject),
    cover: row.subject?.cover ?? null,
    src: coverSrc,
    ratio,
    labels: {
      withheld: m.thread_cover_withheld(),
      reveal: m.thread_cover_reveal(),
      credit: m.thread_cover_credit(),
      via: m.thread_cover_via(),
    },
  });
  const inspect = (row: ImportLibraryRow, index: number) => (
    <VndbAction
      type="button"
      variant="outline"
      aria-label={`${m.library_vndb_browse_inspect()}: ${m.library_member_occurrence({ title: row.title, position: index + 1 })}`}
      aria-expanded={selectedIndex === index}
      aria-controls={detailId}
      onClick={(event) => onInspect(index, event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selectedIndex === index && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {m.library_vndb_browse_inspect()}
    </VndbAction>
  );

  if (layout === 'table') {
    // Shared table primitives allow an unavailable identity to remain plain text in its original position.
    return (
      <div className="max-w-full overflow-x-auto rounded-md border">
        <Table>
          <caption className="sr-only">{m.library_vndb_browse_table_caption()}</caption>
          <TableHeader>
            <TableRow>
              <TableHead>{m.library_column_title()}</TableHead>
              <TableHead>{m.library_column_status()}</TableHead>
              <TableHead>{m.library_entry_progress()}</TableHead>
              <TableHead>{m.subject_rating_control_label()}</TableHead>
              <TableHead>{m.library_sort_activity()}</TableHead>
              <TableHead>{m.library_column_actions()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => {
              const href = importLibraryWorkHref(row, locale);
              return (
                <Fragment key={row.key}>
                  <TableRow data-vndb-current-entry={index}>
                    <TableCell className="min-w-48 max-w-80 whitespace-normal">
                      <div className="flex min-w-0 items-center gap-3">
                        <SubjectCover subject={row.subject} ratio={ratio} size="xs" />
                        {href ? (
                          <a
                            href={href}
                            lang={row.titleLanguage}
                            className="min-w-0 break-words text-primary underline-offset-4 hover:underline"
                          >
                            {row.title}
                          </a>
                        ) : (
                          <span>{row.title}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-48 whitespace-normal">
                      <State row={row} />
                    </TableCell>
                    <TableCell className="min-w-28 whitespace-normal">
                      {progress(row) ? <ProgressRow {...progress(row)!} /> : <span aria-hidden>—</span>}
                    </TableCell>
                    <TableCell className="min-w-40 whitespace-normal">
                      <ImportLibraryVote row={row} />
                    </TableCell>
                    <TableCell className="max-w-48 whitespace-normal text-muted-foreground">
                      <Activity row={row} locale={locale} />
                    </TableCell>
                    <TableCell>{inspect(row, index)}</TableCell>
                  </TableRow>
                  {selectedIndex === index ? (
                    <TableRow data-vndb-detail-row={index}>
                      <TableCell colSpan={6} className="whitespace-normal">
                        {detail}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  const items = rows.map((row, index) => {
    const href = importLibraryWorkHref(row, locale);
    return (
      <MemberReadingItem
        key={row.key}
        layout={layout}
        {...(href ? { href } : {})}
        cover={cover(row)}
        title={row.title}
        {...(row.titleLanguage ? { titleLang: row.titleLanguage } : {})}
        occurrenceLabel={m.library_member_occurrence({ title: row.title, position: index + 1 })}
        metadata={
          <div className="space-y-1" data-vndb-current-entry={index}>
            <State row={row} />
            {progress(row) ? <ProgressRow {...progress(row)!} /> : null}
            <ImportLibraryVote row={row} />
          </div>
        }
        position={<Activity row={row} locale={locale} />}
        detailId={detailId}
        expanded={selectedIndex === index}
        inspectLabel={m.library_vndb_browse_inspect()}
        onInspect={(launcher) => onInspect(index, launcher)}
        onClose={onClose}
        detail={selectedIndex === index ? detail : null}
      />
    );
  });
  return layout === 'grid' ? (
    <CoverGrid density={density[size]} ratio={ratio}>
      {items}
    </CoverGrid>
  ) : (
    <ShelfList>{items}</ShelfList>
  );
}
