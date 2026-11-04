import { CoverCard, CoverGrid, type CoverDensity } from '@rezics/ui/cover-card';
import { ProgressRow } from '@rezics/ui/progress-row';
import { RelativeTime } from '@rezics/ui/relative-time';
import { ShelfList, ShelfListRow } from '@rezics/ui/shelf-list';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rezics/ui/shadcn/table';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { SubjectCover, coverSubject, rowRatio } from '../subject-row';
import type { ShelfLayout, ShelfSize } from '../shelf-params';
import { importLibraryWorkHref } from './navigation';
import type { ImportLibraryRow } from './presentation';
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
}: {
  rows: readonly ImportLibraryRow[];
  locale: string;
  layout: ShelfLayout;
  size: ShelfSize;
  onInspect?: (index: number, launcher: HTMLButtonElement) => void;
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
  const inspect = (row: ImportLibraryRow, index: number) =>
    onInspect ? (
      <VndbAction
        type="button"
        variant="outline"
        aria-label={m.library_vndb_browse_inspect_label({ title: row.title })}
        onClick={(event) => onInspect(index, event.currentTarget)}
      >
        {m.library_vndb_browse_inspect()}
      </VndbAction>
    ) : undefined;

  if (layout === 'grid') {
    return (
      <CoverGrid density={density[size]} ratio={ratio}>
        {rows.map((row, index) => (
          <div key={row.key} className="min-w-0" data-vndb-current-entry={index}>
            <CoverCard
              {...(importLibraryWorkHref(row, locale) ? { href: importLibraryWorkHref(row, locale)! } : {})}
              cover={cover(row)}
              title={row.title}
              {...(row.titleLanguage ? { titleLang: row.titleLanguage } : {})}
              status={{ label: row.state }}
              {...(progress(row) ? { progress: progress(row)! } : {})}
              meta={<Activity row={row} locale={locale} />}
              menuTrigger={inspect(row, index)}
            />
          </div>
        ))}
      </CoverGrid>
    );
  }

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
              <TableHead>{m.library_sort_activity()}</TableHead>
              {onInspect ? <TableHead>{m.library_column_actions()}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => {
              const href = importLibraryWorkHref(row, locale);
              return (
                <TableRow key={row.key} data-vndb-current-entry={index}>
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
                  <TableCell className="max-w-48 whitespace-normal text-muted-foreground">
                    <Activity row={row} locale={locale} />
                  </TableCell>
                  {onInspect ? <TableCell>{inspect(row, index)}</TableCell> : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <ShelfList>
      {rows.map((row, index) => {
        const href = importLibraryWorkHref(row, locale);
        if (href) {
          return (
            <li key={row.key} className="min-w-0" data-vndb-current-entry={index}>
              <ShelfListRow
                href={href}
                cover={cover(row)}
                title={row.title}
                {...(row.titleLanguage ? { titleLang: row.titleLanguage } : {})}
                status={<State row={row} />}
                {...(progress(row) ? { progress: progress(row)! } : {})}
                date={<Activity row={row} locale={locale} />}
                labels={{ select: row.title, menu: row.title }}
                menu={inspect(row, index)}
              />
            </li>
          );
        }
        return (
          <li key={row.key} className="flex min-w-0 items-center gap-3 py-3" data-vndb-current-entry={index}>
            <SubjectCover subject={null} ratio={ratio} />
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{row.title}</p>
              <p className="text-sm text-muted-foreground">
                <State row={row} />
              </p>
              {progress(row) ? <ProgressRow {...progress(row)!} /> : null}
              <p className="text-xs text-muted-foreground">
                <Activity row={row} locale={locale} />
              </p>
              {inspect(row, index)}
            </div>
          </li>
        );
      })}
    </ShelfList>
  );
}
