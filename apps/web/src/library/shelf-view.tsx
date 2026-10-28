import { CoverCard, CoverGrid, type CoverDensity } from '@rezics/ui/cover-card';
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
import { shelfSectionOrder, type LibraryEntryState, type PersonalLibraryEntry } from './entries-read';
import { coverSubject, rowRatio } from './subject-row';
import type { ShelfLayout, ShelfSize } from './shelf-params';
import { useHydrated, useShelfRows, type ShelfFailure, type ShelfRow } from './shelf-rows';

export function stateLabel(state: LibraryEntryState): string {
  if (state === 'planned') return m.library_state_planned();
  if (state === 'in_progress') return m.library_state_in_progress();
  if (state === 'completed') return m.library_state_completed();
  if (state === 'paused') return m.library_state_paused();
  return m.library_state_dropped();
}

function failureText(reason: ShelfFailure): string {
  if (reason === 'closed') return m.platform_closed_message();
  if (reason === 'signed-out') return m.library_sign_in();
  return m.error_message();
}

const densities: Record<ShelfSize, CoverDensity> = { s: 'small', m: 'medium', l: 'large' };

function titleOf(entry: PersonalLibraryEntry): string {
  return entry.subject?.label ?? m.library_subject_unavailable();
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
    ? subjectHref({ id: entry.subject.id, label: entry.subject.label }, locale).href
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
  const { entry } = row;
  const title = titleOf(entry);
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
                const href = subjectHref({ id: entry.subject.id, label: entry.subject.label }, controls.locale);
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
          {
            type: 'item' as const,
            label: m.library_entry_progress(),
            onSelect: () => void navigate({ to: '/library/progress', search: { subjectId } }),
          },
        ]
      : []),
    { type: 'separator' },
    { type: 'item', label: m.library_remove_from_library(), onSelect: () => controls.askRemove(entry.subjectId) },
  ];
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
      value={row.entry.state}
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

function GridView({ controls, shelf, size }: { controls: Controls; shelf: LibraryEntryState; size: ShelfSize }) {
  const { rows, locale } = controls;
  return (
    <CoverGrid ratio={rowRatio(rows.map((row) => row.entry.subject))} density={densities[size]}>
      {rows.map((row) => {
        const { entry } = row;
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
              title={titleOf(entry)}
              cover={coverOf(entry)}
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
  const { rows, locale, hydrated, pending } = controls;
  return (
    <ShelfList>
      {rows.map((row) => {
        const { entry } = row;
        const title = titleOf(entry);
        return (
          <ShelfListRow
            key={entry.subjectId}
            href={hrefOf(entry, locale)}
            cover={coverOf(entry)}
            title={title}
            meta={entry.subject?.typeLabel}
            status={stateLabel(entry.state)}
            {...(hydrated && !pending ? { statusMenu: <StatusRadios row={row} controls={controls} /> } : {})}
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
    return {
      id: entry.subjectId,
      href: hrefOf(entry, locale),
      title: titleOf(entry),
      cover: coverOf(entry),
      type: entry.subject?.typeLabel,
      status: (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={!hydrated || pending} />}>
            {stateLabel(entry.state)}
            <ChevronDownIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <StatusRadios row={row} controls={controls} />
          </DropdownMenuContent>
        </DropdownMenu>
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
  shelf: LibraryEntryState;
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
  if (shelfRows.rows.length === 0) return null;
  const sectionId = useId();
  const body = (
    <>
      {notices.map((row) => (
        <p key={row.entry.subjectId} role={row.failure ? 'alert' : 'status'} className="text-sm">
          <span className="font-medium">{titleOf(row.entry)}</span>{' '}
          {row.failure ? failureText(row.failure) : m.library_conflict()}
        </p>
      ))}
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
      <AlertDialog open={leaving !== undefined} onOpenChange={(open) => !open && shelfRows.cancelRemove()}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.library_remove_confirm()}</AlertDialogTitle>
            <AlertDialogDescription>
              {leaving ? m.library_remove_description({ title: titleOf(leaving) }) : null}
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
    </>
  );
  if (!section) return body;
  return (
    <section aria-labelledby={sectionId} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={sectionId} className="text-xl font-semibold">
          {section.title}
        </h2>
        <a href={section.href} className="text-sm text-primary underline-offset-4 hover:underline">
          {m.library_view_all()}
          <span className="sr-only"> {stateLabel(shelf)}</span>
        </a>
      </div>
      {body}
    </section>
  );
}
