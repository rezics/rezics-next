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
import { useLocation, useNavigate } from '@tanstack/react-router';
import { EllipsisIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { libraryEntryStateWrite, type LibraryEntryStateRead, type PersonalLibraryEntry } from './entries-read';
import { coverSubject } from './subject-row';
import { displayLibraryTitle } from './title';
import { progressView } from './progress-label';
import { shelfHref, type ShelfLayout, type ShelfSize, type ShelfSort } from './shelf-params';
import { useHydrated, useShelfRows, type ShelfFailure, type ShelfRow } from './shelf-rows';
import { useSession } from '../session/query';
import { selectableEntry, type ShelfOutcome } from './shelf-selection';
import type { LibrarySubject } from './reads';
import type { LabelShelfEntry } from './label-shelf-read';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rezics/ui/shadcn/table';

export function stateLabel(state: LibraryEntryStateRead, label?: string): string | undefined {
  return state ? (label ?? m.library_other()) : undefined;
}
function failureText(reason: ShelfFailure): string {
  if (reason === 'closed') return m.platform_closed_message();
  if (reason === 'denied') return m.library_sort_denied();
  if (reason === 'signed-out') return m.library_sign_in();
  if (reason === 'unsupported_library_profile') return m.library_entry_profile_unsupported();
  return m.error_message();
}
const densities: Record<ShelfSize, CoverDensity> = { s: 'small', m: 'medium', l: 'large' };
function entryProgress(entry: PersonalLibraryEntry, locale: string) {
  const view = progressView(entry.activeProgressSession ?? null, locale);
  return view ? { value: view.percent == null ? null : view.percent / 100, label: view.text } : undefined;
}
function labelEntryProgress(entry: LabelShelfEntry, locale: string) {
  const view = progressView(entry.activeProgressSession ?? null, locale);
  return view ? { value: view.percent === null ? null : view.percent / 100, label: view.text } : undefined;
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
type Controls = ReturnType<typeof useShelfRows> & {
  locale: string;
  hydrated: boolean;
  sort?: ShelfSort;
  filterSort?: ShelfSort;
  layout: ShelfLayout;
  size: ShelfSize;
};
function hrefOf(entry: PersonalLibraryEntry, locale: string): string {
  return entry.subject
    ? subjectHref({ id: entry.subject.id, label: displayLibraryTitle(entry.subject.label, locale).text }, locale).href
    : `/${locale}/library`;
}
function stateHref(state: LibraryEntryStateRead, locale: string, controls: Controls) {
  const writable = libraryEntryStateWrite(state);
  return writable
    ? shelfHref(locale, { state: writable, ...controls.filterSort, layout: controls.layout, size: controls.size })
    : undefined;
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
  const deleteAdmitted = useOperation('library_entry.delete');
  const progressAdmitted = useOperation('progress_session.list');
  const { entry } = row;
  const title = titleOf(entry, controls.locale).text;
  const subjectId = entry.subject?.id;
  const entries: ItemMenuEntry[] = [];
  if (admitted && entry.stateOptions?.length && !row.unknownIntent) {
    entries.push({
      type: 'submenu',
      label: m.library_menu_status(),
      entries: [
        {
          type: 'radio',
          label: m.library_menu_status(),
          value: entry.state,
          options: entry.stateOptions.map(({ id, label }) => ({ value: id, label: label.text })),
          onValueChange: (value) => void controls.changeState(entry.subjectId, value),
        },
      ],
    });
  }
  if (admitted && row.unknownIntent) {
    entries.push({
      type: 'item',
      label: m.library_selection_retry(),
      onSelect: () => void controls.retryState(entry.subjectId),
    });
  }
  if (subjectId) {
    entries.push({
      type: 'item',
      label: m.library_menu_open(),
      onSelect: () => {
        if (!entry.subject) return;
        const href = subjectHref(
          { id: entry.subject.id, label: displayLibraryTitle(entry.subject.label, controls.locale).text },
          controls.locale,
        );
        void navigate({ to: href.to, params: href.params });
      },
    });
    entries.push({
      type: 'item',
      label: m.library_entry_copies(),
      onSelect: () => void navigate({ to: '/library/copies', search: { subjectId } }),
    });
    if (progressAdmitted)
      entries.push({
        type: 'item',
        label: m.library_entry_progress(),
        onSelect: () => void navigate({ to: '/library/progress', search: { subjectId } }),
      });
  }
  if (deleteAdmitted && !row.unknownIntent) {
    entries.push({ type: 'separator' });
    entries.push({
      type: 'item',
      label: m.library_remove_from_library(),
      onSelect: () => controls.askRemove(entry.subjectId),
    });
  }
  if (!entries.length) return children;
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
  return <RelativeTime value={entry.lastActivityAt ?? entry.updatedAt} locale={locale} timeZone="UTC" />;
}
function selectionProps(entry: PersonalLibraryEntry, controls: Controls) {
  if (!controls.writeAdmitted || !controls.hydrated || !selectableEntry(entry)) return {};
  if (!controls.selected.length) return { onSelect: () => controls.select(entry.subjectId, true) };
  return {
    selectable: true,
    selected: controls.selected.includes(entry.subjectId),
    onSelectedChange: (selected: boolean) => controls.select(entry.subjectId, selected),
  };
}

function SelectionBar({ controls }: { controls: Controls }) {
  const [chosen, setChosen] = useState('');
  const selectedState = controls.commonStates.some((option) => option.id === chosen) ? chosen : '';
  if (!controls.writeAdmitted) return null;
  const eligible = controls.rows.some((row) => selectableEntry(row.entry));
  if (!controls.selected.length)
    return eligible ? (
      <Button variant="outline" disabled={!controls.hydrated || controls.pending} onClick={controls.selectPage}>
        {m.library_selection_page()}
      </Button>
    ) : null;
  return (
    <div
      role="region"
      aria-label={m.library_selection_heading()}
      className="sticky bottom-3 z-20 flex flex-wrap items-center gap-3 rounded-lg border bg-background p-3 shadow-sm"
    >
      <p role="status" className="text-sm">
        {m.library_selection_count({ count: controls.selected.length })}
      </p>
      <Button variant="ghost" disabled={controls.pending} onClick={controls.selectPage}>
        {m.library_selection_page()}
      </Button>
      <Button variant="ghost" disabled={controls.pending} onClick={controls.clearSelection}>
        {m.library_selection_clear()}
      </Button>
      {controls.commonStates.length ? (
        <>
          <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            {m.library_menu_status()}
            <select
              aria-label={m.library_selection_state()}
              className="h-11 max-w-full rounded-md border bg-background px-2"
              value={selectedState}
              disabled={controls.pending || controls.selectionBlocked}
              onChange={(event) => setChosen(event.target.value)}
            >
              <option value="">{m.library_selection_choose()}</option>
              {controls.commonStates.map((option) => (
                <option key={option.id} value={option.id} lang={option.label.lang}>
                  {option.label.text}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={controls.pending || controls.selectionBlocked || !selectedState}
            onClick={() => void controls.changeSelectedState(selectedState)}
          >
            {controls.pending ? m.library_selection_applying() : m.library_selection_apply()}
          </Button>
        </>
      ) : (
        <p className="text-sm">{m.library_selection_no_common()}</p>
      )}
      {controls.selectionBlocked ? <p className="text-sm">{m.library_selection_unknown()}</p> : null}
    </div>
  );
}

const outcomeLabels: Record<ShelfOutcome['status'], () => string> = {
  changed: () => m.library_selection_changed(),
  unchanged: () => m.library_selection_unchanged(),
  conflicted: () => m.library_selection_conflicted(),
  failed: () => m.library_selection_failed(),
  unknown: () => m.library_selection_unknown_label(),
  'not-attempted': () => m.library_selection_not_attempted(),
};
function SelectionOutcomes({ controls }: { controls: Controls }) {
  if (!controls.outcomes.length) return null;
  return (
    <section aria-label={m.library_selection_results()} className="space-y-2 rounded-lg border p-3 text-sm">
      <p>{m.library_selection_partial()}</p>
      <dl role="status" className="flex flex-wrap gap-x-4 gap-y-1">
        {Object.entries(outcomeLabels).map(([status, label]) => (
          <div key={status} className="flex gap-1">
            <dt>{label()}</dt>
            <dd>{controls.outcomes.filter((outcome) => outcome.status === status).length}</dd>
          </div>
        ))}
      </dl>
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {controls.outcomes.map((outcome) => (
          <li
            key={outcome.subjectId}
            className="flex flex-wrap items-center gap-2"
            data-selection-outcome={outcome.status}
          >
            <span>
              {outcome.title}: {outcomeLabels[outcome.status]()}
            </span>
            {outcome.status === 'unknown' &&
            controls.rows.some((row) => row.entry.subjectId === outcome.subjectId && row.unknownIntent) ? (
              <Button
                variant="outline"
                size="sm"
                disabled={controls.pending || !controls.writeAdmitted}
                onClick={() => void controls.retryState(outcome.subjectId)}
                aria-label={m.library_selection_retry_title({ title: outcome.title })}
              >
                {m.library_selection_retry()}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function GridView({ controls, size }: { controls: Controls; size: ShelfSize }) {
  const { rows, locale } = controls;
  return (
    <CoverGrid ratio="5:7" density={densities[size]} fixedDensity>
      {rows.map((row) => {
        const { entry } = row;
        const status = stateLabel(entry.state, entry.stateLabel);
        const statusHref = stateHref(entry.state, locale, controls);
        const progress = entryProgress(entry, locale);
        const title = titleOf(entry, locale);
        const notes =
          row.conflict || row.failure ? (
            <div className="space-y-1">
              {row.conflict ? <p role="status">{m.library_conflict()}</p> : null}
              {row.failure ? (
                <p role="alert">{row.unknownIntent ? m.library_selection_unknown() : failureText(row.failure)}</p>
              ) : null}
            </div>
          ) : undefined;
        return (
          <EntryMenu key={entry.subjectId} row={row} controls={controls} triggerSlot trigger={{ variant: 'ghost' }}>
            <CoverCard
              {...selectionProps(entry, controls)}
              href={hrefOf(entry, locale)}
              title={title.text}
              {...(title.lang ? { titleLang: title.lang } : {})}
              cover={coverOf(entry)}
              {...(progress ? { progress } : {})}
              {...(status ? { status: { label: status, ...(statusHref ? { href: statusHref } : {}) } } : {})}
              menuTrigger={<ItemMenuTriggerSlot />}
              {...(notes ? (progress ? { meta: notes } : { state: notes }) : {})}
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
        const status = stateLabel(entry.state, entry.stateLabel);
        const href = stateHref(entry.state, locale, controls);
        const progress = entryProgress(entry, locale);
        return (
          <ShelfListRow
            key={entry.subjectId}
            {...selectionProps(entry, controls)}
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
function TableView({ controls, state }: { controls: Controls; state?: string }) {
  const { rows, locale } = controls;
  const navigate = useNavigate();
  const entries = useOperation('library_entry.list');
  const progress = useOperation('progress_session.list');
  const sortable = entries && progress && !!controls.sort;
  const columns: ShelfColumn[] = [
    { id: 'cover', label: '', visible: true },
    { id: 'title', label: m.library_column_title(), visible: true },
    { id: 'type', label: m.library_column_type(), visible: true },
    { id: 'status', label: m.library_column_status(), visible: true },
    { id: 'added', label: m.library_sort_created(), visible: true, sortable },
    { id: 'finished', label: m.library_sort_finished(), visible: true, sortable },
    { id: 'lastActivity', label: m.library_sort_activity(), visible: true, sortable },
  ];
  const tableRows: ShelfTableRow[] = rows.map((row) => {
    const { entry } = row;
    const status = stateLabel(entry.state, entry.stateLabel);
    const href = stateHref(entry.state, locale, controls);
    const title = titleOf(entry, locale);
    return {
      id: entry.subjectId,
      ...selectionProps(entry, controls),
      selectLabel: title.text,
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
      added: <RelativeTime value={entry.createdAt} locale={locale} timeZone="UTC" />,
      finished: entry.finishedAt ? <RelativeTime value={entry.finishedAt} locale={locale} timeZone="UTC" /> : '—',
      lastActivity: (
        <span className="inline-flex items-center gap-1">
          <EntryMenu row={row} controls={controls} trigger={{ variant: 'ghost' }}>
            <Updated entry={entry} locale={locale} />
          </EntryMenu>
        </span>
      ),
    };
  });
  return (
    <ShelfTable
      rows={tableRows}
      columns={columns}
      {...(controls.sort
        ? {
            sort: {
              field:
                controls.sort.orderBy === 'createdAt'
                  ? 'added'
                  : controls.sort.orderBy === 'finishedAt'
                    ? 'finished'
                    : 'lastActivity',
              direction: controls.sort.direction,
            } as const,
          }
        : {})}
      onSort={(field, direction) => {
        if (!sortable || !['added', 'finished', 'lastActivity'].includes(field)) return;
        const orderBy = field === 'added' ? 'createdAt' : field === 'finished' ? 'finishedAt' : 'lastActivity';
        void navigate({
          to: '/library',
          search: { ...(state ? { state } : {}), orderBy, direction, layout: controls.layout, size: controls.size },
        });
      }}
    />
  );
}
type ShelfEntriesProps = {
  entries: PersonalLibraryEntry[];
  locale: string;
  layout: ShelfLayout;
  size: ShelfSize;
  sort?: ShelfSort;
  filterSort?: ShelfSort;
  state?: string;
};

export function ShelfEntries(props: ShelfEntriesProps) {
  const session = useSession();
  const location = useLocation();
  const context = `${session.subject ?? session.state}:${props.locale}:${location.href}:${props.state ?? ''}`;
  const [source, setSource] = useState({ entries: props.entries, context, generation: 0 });
  if (source.entries !== props.entries || source.context !== context) {
    setSource({ entries: props.entries, context, generation: source.generation + 1 });
  }
  return <ShelfEntriesPage key={source.generation} {...props} />;
}

function ShelfEntriesPage({ entries, locale, layout, size, sort, filterSort, state }: ShelfEntriesProps) {
  const hydrated = useHydrated();
  const shelfRows = useShelfRows(entries, locale);
  const controls: Controls = {
    ...shelfRows,
    locale,
    hydrated,
    layout,
    size,
    ...(sort ? { sort } : {}),
    ...(filterSort ? { filterSort } : {}),
  };
  const leaving = shelfRows.rows.find((row) => row.entry.subjectId === shelfRows.removing)?.entry;
  const notices = layout === 'grid' ? [] : shelfRows.rows.filter((row) => row.conflict || row.failure);
  if (!shelfRows.rows.length && !shelfRows.restoreMessage && !shelfRows.outcomes.length) return null;
  return (
    <>
      <SelectionBar controls={controls} />
      <SelectionOutcomes controls={controls} />
      {shelfRows.restoreMessage ? (
        <p role="status" className="text-sm">
          {shelfRows.restoreMessage}
        </p>
      ) : null}
      {notices.map((row) => (
        <p key={row.entry.subjectId} role={row.failure ? 'alert' : 'status'} className="text-sm">
          <span className="font-medium">{titleOf(row.entry, locale).text}</span>{' '}
          {row.unknownIntent
            ? m.library_selection_unknown()
            : row.failure
              ? failureText(row.failure)
              : m.library_conflict()}
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
      <fieldset disabled={shelfRows.pending} aria-busy={shelfRows.pending} className="min-w-0">
        {layout === 'grid' ? <GridView controls={controls} size={size} /> : null}
        {layout === 'list' ? <ListView controls={controls} /> : null}
        {layout === 'table' ? (
          <>
            <div className="hidden sm:block">
              <TableView controls={controls} {...(state ? { state } : {})} />
            </div>
            <div className="sm:hidden">
              <ListView controls={controls} />
            </div>
          </>
        ) : null}
      </fieldset>
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
  const admitted = useOperation('library_label.unassign');
  const labelNameId = useId();
  if (!admitted) return null;
  return (
    <form method="post" action={`/${encodeURIComponent(locale)}/library?label=${encodeURIComponent(entry.labelId)}`}>
      <input type="hidden" name="intent" value="unassign" />
      <input type="hidden" name="subjectId" value={entry.subjectId} />
      <input type="hidden" name="labelId" value={entry.labelId} />
      <input type="hidden" name="assignmentId" value={entry.id} />
      <input type="hidden" name="idempotencyKey" value={entry.removeKey} />
      <input type="hidden" name="revision" value={entry.revision} />
      <input type="hidden" name="csrf_token" value={csrfToken ?? ''} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        className="h-auto min-h-11 max-w-full whitespace-normal"
        aria-label={m.library_label_shelf_remove()}
        aria-describedby={labelNameId}
      >
        {m.library_label_shelf_remove()}
      </Button>
      <span id={labelNameId} className="sr-only">
        {labelName}
      </span>
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
  const removeAdmitted = useOperation('library_label.unassign');
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
              <div key={entry.id} className="min-w-0">
                <Tombstone shape="card" />
                {removeAdmitted ? (
                  <div className="flex min-w-0 justify-end">
                    <ItemMenu
                      title={m.library_entry_actions({ title: title(entry) })}
                      backLabel={m.library_menu_back()}
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 pointer-coarse:size-11"
                          aria-label={m.library_entry_actions({ title: title(entry) })}
                        >
                          <EllipsisIcon aria-hidden="true" />
                        </Button>
                      }
                      content={
                        <LabelAssignmentRemoveForm
                          entry={entry}
                          labelName={label.name}
                          locale={locale}
                          csrfToken={csrfToken}
                        />
                      }
                    />
                  </div>
                ) : null}
              </div>
            );
          const progress = labelEntryProgress(entry, locale);
          return (
            <CoverCard
              key={entry.id}
              href={href(entry)}
              title={title(entry)}
              cover={shelfCover(entry.subject)}
              {...(progress ? { progress } : {})}
              {...(entry.state ? { status: { label: entry.stateLabel ?? m.library_other() } } : {})}
              {...(removeAdmitted
                ? {
                    menu: (
                      <LabelAssignmentRemoveForm
                        entry={entry}
                        labelName={label.name}
                        locale={locale}
                        csrfToken={csrfToken}
                      />
                    ),
                    menuLabel: m.library_entry_actions({ title: title(entry) }),
                  }
                : {})}
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
          const progress = labelEntryProgress(entry, locale);
          return (
            <ShelfListRow
              key={entry.id}
              href={href(entry)}
              cover={shelfCover(entry.subject)}
              title={title(entry)}
              meta={entry.subject.typeLabel}
              {...(entry.state ? { status: entry.stateLabel ?? m.library_other() } : {})}
              {...(progress ? { progress } : {})}
              labels={{ select: title(entry), menu: m.library_menu_open() }}
              {...(removeAdmitted
                ? {
                    menu: (
                      <LabelAssignmentRemoveForm
                        entry={entry}
                        labelName={label.name}
                        locale={locale}
                        csrfToken={csrfToken}
                      />
                    ),
                  }
                : {})}
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
          const progress = labelEntryProgress(entry, locale);
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
                <LabelAssignmentRemoveForm entry={entry} labelName={label.name} locale={locale} csrfToken={csrfToken} />
              </TableCell>
              <TableCell>{entry.subject.typeLabel}</TableCell>
              <TableCell>{entry.state ? (entry.stateLabel ?? m.library_other()) : null}</TableCell>
              <TableCell>{progress ? <ProgressRow {...progress} /> : null}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
