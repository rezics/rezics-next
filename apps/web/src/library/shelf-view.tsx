import { Exposure, useOperation } from '../kernel/exposure';
import { EntryRemoveForm } from './entry-undo';
import { CoverCard, CoverGrid, type CoverDensity } from '@rezics/ui/cover-card';
import { ProgressRow } from '@rezics/ui/progress-row';
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
function coverOf(entry: PersonalLibraryEntry) {
  return {
    subject: coverSubject(entry.subject),
    cover: entry.subject?.cover ?? null,
    src: coverSrc,
    labels: {
      withheld: m.thread_cover_withheld(),
      reveal: m.thread_cover_reveal(),
      credit: m.thread_cover_credit(),
      via: m.thread_cover_via(),
    },
  };
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
