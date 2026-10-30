import { Exposure, useOperation } from '../kernel/exposure';
import { EntryRemoveForm } from './entry-undo';
import { CoverCard, CoverGrid, type CoverDensity } from '@rezics/ui/cover-card';
import { Cover, coverRatio } from '@rezics/ui/cover';
import { ProgressRow } from '@rezics/ui/progress-row';
import { Tombstone } from '@rezics/ui/tombstone';
import { ItemMenu, ItemMenuTriggerSlot, type ItemMenuEntry } from '@rezics/ui/item-menu';
import { RelativeTime } from '@rezics/ui/relative-time';
import { ShelfList, ShelfListRow } from '@rezics/ui/shelf-list';
import { ShelfTable, type ShelfColumn, type ShelfTableRow } from '@rezics/ui/shelf-table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { Button } from '@rezics/ui/shadcn/button';
import { useNavigate } from '@tanstack/react-router';
import { EllipsisIcon } from 'lucide-react';
import { type ReactNode } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import {
  libraryEntryStateWrite,
  libraryEntryStateLabel,
  shelfSectionOrder,
  type LibraryEntryStateRead,
  type PersonalLibraryEntry,
} from './entries-read';
import { coverSubject } from './subject-row';
import { displayLibraryTitle } from './title';
import { progressView } from './progress-label';
import { shelfHref, type ShelfLayout, type ShelfSize } from './shelf-params';
import { useHydrated, useShelfRows, type ShelfFailure, type ShelfRow } from './shelf-rows';
import type { LibrarySubject } from './reads';
import { labelShelfProgress, type LabelShelfEntry } from './label-shelf-read';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rezics/ui/shadcn/table';

export function stateLabel(state: LibraryEntryStateRead): string | undefined {
  return libraryEntryStateWrite(state) ? libraryEntryStateLabel(state) : undefined;
}
function failureText(reason: ShelfFailure): string {
  if (reason === 'closed') return m.platform_closed_message();
  if (reason === 'signed-out') return m.library_sign_in();
  return m.error_message();
}
const densities: Record<ShelfSize, CoverDensity> = { s: 'small', m: 'medium', l: 'large' };
function entryProgress(entry: PersonalLibraryEntry, locale: string) {
  const view = progressView(entry.activeProgressSession ?? null, locale);
  return view ? { value: view.percent == null ? null : view.percent / 100, label: view.text } : undefined;
}
function titleOf(entry: PersonalLibraryEntry, locale: string) {
  return entry.subject
    ? displayLibraryTitle(entry.subject.label, locale)
    : { text: m.library_subject_unavailable(), lang: undefined };
}
export function shelfCover(subject: LibrarySubject | null) {
  return {
    subject: coverSubject(subject),
    cover: subject?.cover ?? null,
    src: coverSrc,
    labels: {
      withheld: m.thread_cover_withheld(),
      reveal: m.thread_cover_reveal(),
      credit: m.thread_cover_credit(),
      via: m.thread_cover_via(),
    },
  };
}
function coverOf(entry: PersonalLibraryEntry) {
  return shelfCover(entry.subject);
}
type Controls = ReturnType<typeof useShelfRows> & { locale: string; hydrated: boolean };
function hrefOf(entry: PersonalLibraryEntry, locale: string): string {
  return entry.subject
    ? subjectHref({ id: entry.subject.id, label: displayLibraryTitle(entry.subject.label, locale).text }, locale).href
    : `/${locale}/library`;
}
function stateHref(state: LibraryEntryStateRead, locale: string) {
  const writable = libraryEntryStateWrite(state);
  return writable ? shelfHref(locale, { state: writable }) : undefined;
}
function EntryMenu({
  row,
  controls,
  trigger,
  triggerSlot,
  children,
}: {
  row: ShelfRow;
  controls: Controls;
  trigger: { className?: string; variant: 'secondary' | 'ghost' };
  triggerSlot?: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const admitted = useOperation('library_entry.put');
  const progressAdmitted = useOperation('progress_session.list');
  const { entry } = row;
  const title = titleOf(entry, controls.locale).text;
  const subjectId = entry.subject?.id;
  const entries: ItemMenuEntry[] = [
    {
      type: 'submenu',
      label: m.library_menu_status(),
      entries: [
        {
          type: 'radio',
          label: m.library_menu_status(),
          value: entry.state,
          options: shelfSectionOrder.map((state) => ({ value: state, label: libraryEntryStateLabel(state) })),
          onValueChange: (value) => void controls.changeState(entry.subjectId, value),
        },
      ],
    },
    ...(subjectId
      ? [
          {
            type: 'item' as const,
            label: m.library_menu_open(),
            onSelect: () => {
              if (entry.subject) {
                const href = subjectHref(
                  { id: entry.subject.id, label: displayLibraryTitle(entry.subject.label, controls.locale).text },
                  controls.locale,
                );
                void navigate({ to: href.to, params: href.params });
              }
            },
          },
        ]
      : []),
    ...(subjectId
      ? [
          {
            type: 'item' as const,
            label: m.library_entry_copies(),
            onSelect: () => void navigate({ to: '/library/copies', search: { subjectId } }),
          },
          ...(progressAdmitted
            ? [
                {
                  type: 'item' as const,
                  label: m.library_entry_progress(),
                  onSelect: () => void navigate({ to: '/library/progress', search: { subjectId } }),
                },
              ]
            : []),
        ]
      : []),
    { type: 'separator' },
    { type: 'item', label: m.library_remove_from_library(), onSelect: () => controls.askRemove(entry.subjectId) },
  ];
  if (!admitted) return children;
  return (
    <ItemMenu
      entries={entries}
      title={title}
      backLabel={m.library_menu_back()}
      {...(triggerSlot !== undefined ? { triggerSlot } : {})}
      trigger={
        <Button
          variant={trigger.variant}
          size={triggerSlot ? 'icon-xs' : 'icon-sm'}
          disabled={!controls.hydrated || controls.pending}
          aria-label={m.library_entry_actions({ title })}
          {...(trigger.className ? { className: trigger.className } : {})}
        >
          <EllipsisIcon aria-hidden="true" />
        </Button>
      }
    >
      {children}
    </ItemMenu>
  );
}
function Updated({ entry, locale }: { entry: PersonalLibraryEntry; locale: string }) {
  return <RelativeTime value={entry.updatedAt} locale={locale} timeZone="UTC" />;
}
function GridView({ controls, size }: { controls: Controls; size: ShelfSize }) {
  const { rows, locale } = controls;
  return (
    <CoverGrid ratio="5:7" density={densities[size]} fixedDensity>
      {rows.map((row) => {
        const { entry } = row;
        const status = stateLabel(entry.state);
        const statusHref = stateHref(entry.state, locale);
        const progress = entryProgress(entry, locale);
        const title = titleOf(entry, locale);
        const notes =
          row.conflict || row.failure ? (
            <div className="space-y-1">
              {row.conflict ? <p role="status">{m.library_conflict()}</p> : null}
              {row.failure ? <p role="alert">{failureText(row.failure)}</p> : null}
            </div>
          ) : undefined;
        return (
          <EntryMenu key={entry.subjectId} row={row} controls={controls} triggerSlot trigger={{ variant: 'ghost' }}>
            <CoverCard
              href={hrefOf(entry, locale)}
              title={title.text}
              {...(title.lang ? { titleLang: title.lang } : {})}
              cover={coverOf(entry)}
              {...(progress ? { progress } : {})}
              {...(status ? { status: { label: status, ...(statusHref ? { href: statusHref } : {}) } } : {})}
              menuTrigger={<ItemMenuTriggerSlot />}
              {...(notes ? { state: notes } : {})}
            />
          </EntryMenu>
        );
      })}
    </CoverGrid>
  );
}
function ListView({ controls }: { controls: Controls }) {
  const { rows, locale } = controls;
  return (
    <ShelfList>
      {rows.map((row) => {
        const { entry } = row;
        const localizedTitle = titleOf(entry, locale);
        const title = localizedTitle.text;
        const status = stateLabel(entry.state);
        const href = stateHref(entry.state, locale);
        const progress = entryProgress(entry, locale);
        return (
          <ShelfListRow
            key={entry.subjectId}
            href={hrefOf(entry, locale)}
            cover={coverOf(entry)}
            title={title}
            {...(localizedTitle.lang ? { titleLang: localizedTitle.lang } : {})}
            meta={entry.subject?.typeLabel}
            {...(progress ? { progress } : {})}
            {...(status
              ? {
                  status: href ? (
                    <a
                      href={href}
                      aria-label={status}
                      className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground underline"
                    >
                      {status}
                    </a>
                  ) : (
                    status
                  ),
                }
              : {})}
            date={
              <span className="inline-flex items-center gap-1">
                <EntryMenu row={row} controls={controls} trigger={{ variant: 'ghost' }}>
                  <Updated entry={entry} locale={locale} />
                </EntryMenu>
              </span>
            }
            labels={{ select: title, menu: m.library_entry_actions({ title }) }}
          />
        );
      })}
    </ShelfList>
  );
}
function TableView({ controls }: { controls: Controls }) {
  const { rows, locale } = controls;
  const columns: ShelfColumn[] = [
    { id: 'cover', label: '', visible: true },
    { id: 'title', label: m.library_column_title(), visible: true },
    { id: 'type', label: m.library_column_type(), visible: true },
    { id: 'status', label: m.library_column_status(), visible: true },
    { id: 'lastActivity', label: m.library_updated(), visible: true },
  ];
  const tableRows: ShelfTableRow[] = rows.map((row) => {
    const { entry } = row;
    const status = stateLabel(entry.state);
    const href = stateHref(entry.state, locale);
    const title = titleOf(entry, locale);
    return {
      id: entry.subjectId,
      href: hrefOf(entry, locale),
      title: title.text,
      ...(title.lang ? { titleLang: title.lang } : {}),
      cover: coverOf(entry),
      ...(entryProgress(entry, locale) ? { progress: <ProgressRow {...entryProgress(entry, locale)!} /> } : {}),
      type: entry.subject?.typeLabel,
      status:
        status && href ? (
          <a href={href} className="underline">
            {status}
          </a>
        ) : (
          status
        ),
      lastActivity: (
        <span className="inline-flex items-center gap-1">
          <EntryMenu row={row} controls={controls} trigger={{ variant: 'ghost' }}>
            <Updated entry={entry} locale={locale} />
          </EntryMenu>
        </span>
      ),
    };
  });
  return <ShelfTable rows={tableRows} columns={columns} onSort={() => {}} />;
}
export function ShelfEntries({
  entries,
  locale,
  layout,
  size,
}: {
  entries: PersonalLibraryEntry[];
  locale: string;
  layout: ShelfLayout;
  size: ShelfSize;
}) {
  const hydrated = useHydrated();
  const shelfRows = useShelfRows(entries);
  const controls: Controls = { ...shelfRows, locale, hydrated };
  const leaving = shelfRows.rows.find((row) => row.entry.subjectId === shelfRows.removing)?.entry;
  const notices = layout === 'grid' ? [] : shelfRows.rows.filter((row) => row.conflict || row.failure);
  if (!shelfRows.rows.length && !shelfRows.restoreMessage) return null;
  return (
    <>
      {shelfRows.restoreMessage ? (
        <p role="status" className="text-sm">
          {shelfRows.restoreMessage}
        </p>
      ) : null}
      {notices.map((row) => (
        <p key={row.entry.subjectId} role={row.failure ? 'alert' : 'status'} className="text-sm">
          <span className="font-medium">{titleOf(row.entry, locale).text}</span>{' '}
          {row.failure ? failureText(row.failure) : m.library_conflict()}
        </p>
      ))}
      <noscript>
        {shelfRows.rows.map(({ entry }) => (
          <div key={entry.subjectId}>
            <p>{titleOf(entry, locale).text}</p>
            <EntryRemoveForm
              subjectId={entry.subjectId}
              revision={entry.revision}
              {...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId })}
              idempotencyKey={entry.removeKey}
              locale={locale}
            />
          </div>
        ))}
      </noscript>
      {layout === 'grid' ? <GridView controls={controls} size={size} /> : null}
      {layout === 'list' ? <ListView controls={controls} /> : null}
      {layout === 'table' ? (
        <>
          <div className="hidden sm:block">
            <TableView controls={controls} />
          </div>
          <div className="sm:hidden">
            <ListView controls={controls} />
          </div>
        </>
      ) : null}
      <Exposure operation="library_entry.delete">
        <AlertDialog open={leaving !== undefined} onOpenChange={(open) => !open && shelfRows.cancelRemove()}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>{m.library_remove_confirm()}</AlertDialogTitle>
              <AlertDialogDescription>
                {leaving ? m.library_remove_description({ title: titleOf(leaving, locale).text }) : null}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={shelfRows.pending}>{m.library_collection_cancel()}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={shelfRows.pending}
                onClick={() => void shelfRows.remove()}
              >
                {m.library_remove_submit()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Exposure>
    </>
  );
}

function LabelAssignmentRemoveForm({
  entry,
  labelName,
  locale,
  csrfToken,
}: {
  entry: LabelShelfEntry;
  labelName: string;
  locale: string;
  csrfToken: string | null;
}) {
  return (
    <form method="post" action={`/${encodeURIComponent(locale)}/library?label=${encodeURIComponent(entry.labelId)}`}>
      <input type="hidden" name="intent" value="unassign" />
      <input type="hidden" name="subjectId" value={entry.subjectId} />
      <input type="hidden" name="labelId" value={entry.labelId} />
      <input type="hidden" name="assignmentId" value={entry.id} />
      <input type="hidden" name="revision" value={entry.revision} />
      <input type="hidden" name="csrf_token" value={csrfToken ?? ''} />
      <Button type="submit" variant="outline" size="sm" aria-label={m.library_label_shelf_remove()}>
        {m.library_label_shelf_remove()}
      </Button>
      <span className="sr-only">{labelName}</span>
    </form>
  );
}

/** The label shelf shares the main shelf's cover, list and table primitives without manufacturing entry state. */
export function LabelShelfEntries({
  entries,
  label,
  locale,
  layout,
  size,
  csrfToken,
}: {
  entries: LabelShelfEntry[];
  label: { id: string; name: string };
  locale: string;
  layout: ShelfLayout;
  size: ShelfSize;
  csrfToken: string | null;
}) {
  const title = (entry: LabelShelfEntry) =>
    entry.subject ? displayLibraryTitle(entry.subject.label, locale).text : m.library_subject_unavailable();
  const href = (entry: LabelShelfEntry) =>
    entry.subject ? subjectHref({ id: entry.subject.id, label: title(entry) }, locale).href : `/${locale}/library`;
  if (layout === 'grid')
    return (
      <CoverGrid ratio="5:7" density={densities[size]} fixedDensity>
        {entries.map((entry) => {
          if (!entry.subject)
            return (
              <div key={entry.id} className="min-w-0 space-y-2">
                <Tombstone shape="card" />
                <LabelAssignmentRemoveForm entry={entry} labelName={label.name} locale={locale} csrfToken={csrfToken} />
              </div>
            );
          const progress = labelShelfProgress(entry, locale);
          return (
            <CoverCard
              key={entry.id}
              href={href(entry)}
              title={title(entry)}
              cover={shelfCover(entry.subject)}
              {...(progress ? { progress } : {})}
              {...(entry.state ? { status: { label: libraryEntryStateLabel(entry.state) } } : {})}
            />
          );
        })}
      </CoverGrid>
    );
  if (layout === 'list')
    return (
      <ShelfList>
        {entries.map((entry) => {
          if (!entry.subject)
            return (
              <li key={entry.id} className="space-y-2 border-b py-3">
                <Tombstone shape="row" />
                <LabelAssignmentRemoveForm entry={entry} labelName={label.name} locale={locale} csrfToken={csrfToken} />
              </li>
            );
          const progress = labelShelfProgress(entry, locale);
          return (
            <ShelfListRow
              key={entry.id}
              href={href(entry)}
              cover={shelfCover(entry.subject)}
              title={title(entry)}
              meta={entry.subject.typeLabel}
              {...(entry.state ? { status: libraryEntryStateLabel(entry.state) } : {})}
              {...(progress ? { progress } : {})}
              labels={{ select: title(entry), menu: m.library_menu_open() }}
            />
          );
        })}
      </ShelfList>
    );
  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow>
          <TableHead />
          <TableHead>{m.library_column_title()}</TableHead>
          <TableHead>{m.library_column_type()}</TableHead>
          <TableHead>{m.library_column_status()}</TableHead>
          <TableHead>{m.library_progress_heading()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          if (!entry.subject)
            return (
              <TableRow key={entry.id}>
                <TableCell colSpan={5}>
                  <div className="space-y-2">
                    <Tombstone shape="row" />
                    <LabelAssignmentRemoveForm
                      entry={entry}
                      labelName={label.name}
                      locale={locale}
                      csrfToken={csrfToken}
                    />
                  </div>
                </TableCell>
              </TableRow>
            );
          const cover = shelfCover(entry.subject);
          const progress = labelShelfProgress(entry, locale);
          return (
            <TableRow key={entry.id}>
              <TableCell>
                <div
                  className="w-10 overflow-hidden rounded"
                  style={{ aspectRatio: coverRatio(cover.subject.types).replace(':', ' / ') }}
                >
                  <Cover {...cover} size="fill" ratio={coverRatio(cover.subject.types)} decorative />
                </div>
              </TableCell>
              <TableCell>
                <a className="font-medium hover:underline" href={href(entry)}>
                  {title(entry)}
                </a>
              </TableCell>
              <TableCell>{entry.subject.typeLabel}</TableCell>
              <TableCell>{entry.state ? libraryEntryStateLabel(entry.state) : null}</TableCell>
              <TableCell>{progress ? <ProgressRow {...progress} /> : null}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
