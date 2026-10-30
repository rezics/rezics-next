import { EntryRemoveForm } from './entry-undo';
import { Exposure, useOperation } from '../kernel/exposure';
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
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@rezics/ui/shadcn/dropdown-menu';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDownIcon, EllipsisIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import {
  libraryEntryStateWrite,
  libraryEntryStateLabel,
  shelfSectionOrder,
  type LibraryEntryStateRead,
  type LibraryEntryStateWrite,
  type PersonalLibraryEntry,
} from './entries-read';
import { coverSubject } from './subject-row';
import { displayLibraryTitle } from './title';
import { progressView } from './progress-label';
import type { ShelfLayout, ShelfSize } from './shelf-params';
import { useHydrated, useShelfRows, type ShelfFailure, type ShelfRow } from './shelf-rows';

export function stateLabel(state: LibraryEntryStateRead): string {
  return libraryEntryStateLabel(state);
}

function selectedStateValue(state: LibraryEntryStateRead): string {
  return libraryEntryStateWrite(state) ?? '__library_other__';
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
  // A subject nobody can read has no page; its card stays on the library.
  return entry.subject
    ? subjectHref({ id: entry.subject.id, label: displayLibraryTitle(entry.subject.label, locale).text }, locale).href
    : `/${locale}/library`;
}

/** The item menu of one entry: change its status, open its subject, remove it. */
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
          value: selectedStateValue(entry.state),
          options: shelfSectionOrder.map((state) => ({ value: state, label: stateLabel(state) })),
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
    // The copies and reading progress of a subject are reached from here; their pages take the subject in the address.
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

function StatusRadios({ row, controls }: { row: ShelfRow; controls: Controls }) {
  return (
    <DropdownMenuRadioGroup
      value={selectedStateValue(row.entry.state)}
      onValueChange={(value) => void controls.changeState(row.entry.subjectId, value)}
    >
      {shelfSectionOrder.map((state) => (
        <DropdownMenuRadioItem key={state} value={state} closeOnClick>
          {stateLabel(state)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

function Updated({ entry, locale }: { entry: PersonalLibraryEntry; locale: string }) {
  return <RelativeTime value={entry.updatedAt} locale={locale} timeZone="UTC" />;
}

function GridView({ controls, shelf, size }: { controls: Controls; shelf: LibraryEntryStateWrite; size: ShelfSize }) {
  const { rows, locale } = controls;
  return (
    <CoverGrid ratio="5:7" density={densities[size]} fixedDensity>
      {rows.map((row) => {
        const { entry } = row;
        const progress = entryProgress(entry, locale);
        const title = titleOf(entry, locale);
        const notes =
          row.conflict || row.failure || entry.state !== shelf ? (
            <div className="space-y-1">
              {entry.state !== shelf ? <Badge variant="secondary">{stateLabel(entry.state)}</Badge> : null}
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
              secondary={
                <>
                  {m.library_updated()} <Updated entry={entry} locale={locale} />
                </>
              }
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
  const admitted = useOperation('library_entry.put');
  const { rows, locale, hydrated, pending } = controls;
  return (
    <ShelfList>
      {rows.map((row) => {
        const { entry } = row;
        const progress = entryProgress(entry, locale);
        const localizedTitle = titleOf(entry, locale);
        const title = localizedTitle.text;
        return (
          <ShelfListRow
            key={entry.subjectId}
            href={hrefOf(entry, locale)}
            cover={coverOf(entry)}
            title={title}
            {...(localizedTitle.lang ? { titleLang: localizedTitle.lang } : {})}
            meta={entry.subject?.typeLabel}
            {...(progress ? { progress } : {})}
            status={stateLabel(entry.state)}
            {...(admitted && hydrated && !pending
              ? { statusMenu: <StatusRadios row={row} controls={controls} /> }
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
  const admitted = useOperation('library_entry.put');
  const { rows, locale, hydrated, pending } = controls;
  const columns: ShelfColumn[] = [
    { id: 'cover', label: '', visible: true },
    { id: 'title', label: m.library_column_title(), visible: true },
    { id: 'type', label: m.library_column_type(), visible: true },
    { id: 'status', label: m.library_column_status(), visible: true },
    { id: 'lastActivity', label: m.library_updated(), visible: true },
  ];
  const tableRows: ShelfTableRow[] = rows.map((row) => {
    const { entry } = row;
    const progress = entryProgress(entry, locale);
    const title = titleOf(entry, locale);
    return {
      id: entry.subjectId,
      href: hrefOf(entry, locale),
      title: title.text,
      ...(title.lang ? { titleLang: title.lang } : {}),
      cover: coverOf(entry),
      ...(progress ? { progress: <ProgressRow {...progress} /> } : {}),
      type: entry.subject?.typeLabel,
      status: admitted ? (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={!hydrated || pending} />}>
            {stateLabel(entry.state)}
            <ChevronDownIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <StatusRadios row={row} controls={controls} />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        stateLabel(entry.state)
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

/**
 * The entries of one shelf in the chosen layout, with the item menu of each and the removal confirmation. The table
 * shows as the list below the `sm` width, so both are in the page and the width decides which one is visible.
 */
export function ShelfEntries({
  entries,
  shelf,
  locale,
  layout,
  size,
  section,
}: {
  entries: PersonalLibraryEntry[];
  shelf: LibraryEntryStateWrite;
  locale: string;
  layout: ShelfLayout;
  size: ShelfSize;
  /** On the All tab each status is a section that names itself and links to its tab, and goes when it empties. */
  section?: { title: string; href: string };
}) {
  const hydrated = useHydrated();
  const shelfRows = useShelfRows(entries);
  const controls: Controls = { ...shelfRows, locale, hydrated };
  const leaving = shelfRows.rows.find((row) => row.entry.subjectId === shelfRows.removing)?.entry;
  const notices = layout === 'grid' ? [] : shelfRows.rows.filter((row) => row.conflict || row.failure);
  const sectionId = useId();
  if (shelfRows.rows.length === 0 && !shelfRows.restoreMessage) return null;
  const body = (
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
      {layout === 'grid' ? <GridView controls={controls} shelf={shelf} size={size} /> : null}
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
  if (!section) return body;
  return (
    <section aria-labelledby={sectionId} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={sectionId} className="text-xl font-semibold">
          {section.title}
        </h2>
        <Exposure operation="library_entry.list">
          <a href={section.href} className="text-sm text-primary underline-offset-4 hover:underline">
            {m.library_view_all()}
            <span className="sr-only"> {stateLabel(shelf)}</span>
          </a>
        </Exposure>
      </div>
      {body}
    </section>
  );
}
