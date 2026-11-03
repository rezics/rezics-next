import { Exposure, useOperation } from '../kernel/exposure';
import { EntryRemoveForm } from './entry-undo';
import { CoverCard, CoverGrid, type CoverDensity } from '@rezics/ui/cover-card';
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
import { SelectionBar as SharedSelectionBar } from '@rezics/ui/selection-bar';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { EllipsisIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { libraryEntryStateWrite, type LibraryEntryStateRead, type PersonalLibraryEntry } from './entries-read';
import { coverSubject } from './subject-row';
import { displayLibraryTitle } from './title';
import { progressView } from './progress-label';
import {
  shelfColumnIds,
  shelfColumns,
  shelfHref,
  type ShelfDisplay,
  type ShelfLayout,
  type ShelfSize,
  type ShelfSort,
} from './shelf-params';
import { shelfColumnLabel } from './shelf-columns';
import {
  shelfMutationLease,
  useHydrated,
  useShelfRows,
  type ShelfFailure,
  type ShelfRow,
  type ShelfMutationLease,
} from './shelf-rows';
import { ShelfLabelAction, ShelfLabelOutcomes } from './shelf-labels';
import { useBulkLibraryRemoval } from './bulk-library-removal-controller';
import { BulkLibraryRemovalAction, BulkLibraryRemovalReviewView } from './bulk-library-removal-view';
import { useSession } from '../session/query';
import { selectableEntry, shelfSelectionLimit, type ShelfRemovalIdentity } from './shelf-selection';
import type { LibrarySubject } from './reads';
import type { LabelShelfEntry } from './label-shelf-read';
import { SelectionReviewView, SelectionReviewList, type SelectionReviewItem } from './selection-review-view';
import { appendSelectionWithinLimit, selectionReviewSignature, selectionResultState } from './selection-review';
import { SelectionResultView } from './selection-result-view';

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
  selectionLimitReached: boolean;
  sort?: ShelfSort;
  filterSort?: ShelfSort;
  type?: string;
  layout: ShelfLayout;
  size: ShelfSize;
  columns?: string;
};
function hrefOf(entry: PersonalLibraryEntry, locale: string): string {
  return entry.subject
    ? subjectHref({ id: entry.subject.id, label: displayLibraryTitle(entry.subject.label, locale).text }, locale).href
    : `/${locale}/library`;
}
function stateHref(state: LibraryEntryStateRead, locale: string, controls: Controls) {
  const writable = libraryEntryStateWrite(state);
  return writable
    ? shelfHref(locale, {
        ...(controls.type ? { type: controls.type } : {}),
        state: writable,
        ...controls.filterSort,
        layout: controls.layout,
        size: controls.size,
        ...(controls.columns ? { columns: controls.columns } : {}),
      })
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
  if (admitted && entry.stateOptions?.length && !row.unknownIntent && !row.unknownLabelIntent && !row.unknownRemove) {
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
        if (!controls.isCurrent() || !entry.subject) return;
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
      onSelect: () => {
        if (controls.isCurrent() && controls.copiesAdmitted())
          void navigate({ to: '/library/copies', search: { subjectId } });
      },
    });
    if (progressAdmitted)
      entries.push({
        type: 'item',
        label: m.library_entry_progress(),
        onSelect: () => {
          if (controls.isCurrent() && controls.progressAdmitted())
            void navigate({ to: '/library/progress', search: { subjectId } });
        },
      });
  }
  if (deleteAdmitted && !row.unknownIntent && !row.unknownLabelIntent) {
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
  if (
    (!controls.writeAdmitted && !controls.labelWriteAdmitted && !controls.labelRemoveAdmitted) ||
    !controls.hydrated ||
    !controls.selectable(entry)
  )
    return {};
  if (!controls.selected.length) return { onSelect: () => controls.select(entry.subjectId, true) };
  return {
    selectable: true,
    selected: controls.selected.includes(entry.subjectId),
    onSelectedChange: (selected: boolean) => controls.select(entry.subjectId, selected),
  };
}

function matchesRemovedShelfEntry(entry: PersonalLibraryEntry, landed: ShelfRemovalIdentity): boolean {
  return (
    entry.subjectId === landed.subjectId &&
    entry.revision === landed.revision &&
    entry.incarnationId === landed.incarnationId &&
    entry.removeKey === landed.removeKey
  );
}

function ShelfSelectionBar({
  controls,
  bulkRemoval,
  selectionLimitReached,
}: {
  controls: Controls;
  bulkRemoval: ReturnType<typeof useBulkLibraryRemoval>;
  selectionLimitReached: boolean;
}) {
  const [chosen, setChosen] = useState('');
  const selectedState = controls.commonStates.some((option) => option.id === chosen) ? chosen : '';
  const launcher = useRef<HTMLButtonElement>(null);
  const [reviewSnapshot, setReviewSnapshot] = useState<string | null>(null);
  const reviewTargets: SelectionReviewItem[] = controls.selectedEntries.map((entry) => ({
    subjectId: entry.subjectId,
    title: titleOf(entry, controls.locale).text,
    ...(stateLabel(entry.state, entry.stateLabel) ? { stateLabel: stateLabel(entry.state, entry.stateLabel)! } : {}),
  }));
  const signature = selectionReviewSignature(controls.selectedEntries);
  const reviewOpen = !!reviewSnapshot && reviewSnapshot === signature && controls.isCurrent();
  const openReview = () => {
    if (controls.selected.length && controls.isCurrent()) setReviewSnapshot(signature);
  };
  const closeReview = () => {
    setReviewSnapshot(null);
    if (controls.isCurrent()) requestAnimationFrame(() => launcher.current?.isConnected && launcher.current.focus());
  };
  useEffect(() => {
    if (!reviewSnapshot || reviewSnapshot === signature) return;
    setReviewSnapshot(null);
    if (controls.isCurrent()) requestAnimationFrame(() => launcher.current?.isConnected && launcher.current.focus());
  }, [reviewSnapshot, signature, controls.isCurrent]);
  const reviewSelectedState = () => {
    if (!selectedState || !controls.isCurrent() || reviewSnapshot !== signature) return;
    closeReview();
    void controls.previewSelectedState(selectedState);
  };
  if (!controls.bulkStatusWriteAdmitted && !controls.labelWriteAdmitted && !controls.labelRemoveAdmitted) return null;
  const eligible = controls.rows.some((row) => controls.selectable(row.entry));
  if (!controls.selected.length)
    return (
      <>
        {eligible ? (
          <Button
            variant="outline"
            disabled={!controls.hydrated || controls.selectionPending}
            onClick={controls.selectPage}
          >
            {m.library_selection_page()}
          </Button>
        ) : null}
        <BulkLibraryRemovalAction controller={bulkRemoval} pending={controls.pending} />
      </>
    );
  return (
    <>
      <div className="[&_[data-slot=button]]:min-h-11">
        <SharedSelectionBar
          count={controls.selected.length}
          label={(count) => m.library_selection_count({ count })}
          ariaLabel={m.library_selection_heading()}
          bottomOffset="var(--bottom-nav-height, 5rem)"
          statusMessage={selectionLimitReached ? m.library_selection_limit_reached({ limit: shelfSelectionLimit }) : undefined}
          primaryAction={
            <Button
              ref={launcher}
              variant="outline"
              className="min-h-11"
              disabled={controls.selectionPending || !controls.isCurrent()}
              onClick={openReview}
            >
              {m.library_selection_review()}
            </Button>
          }
          actions={
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button variant="ghost" className="min-h-11" disabled={controls.selectionPending} onClick={controls.selectPage}>
                {m.library_selection_page()}
              </Button>
              <BulkLibraryRemovalAction controller={bulkRemoval} pending={controls.pending} />
              <ShelfLabelAction controls={controls} />
              <ShelfLabelAction controls={controls} kind="unassign" />
            </div>
          }
          onCancel={controls.clearSelection}
          cancelLabel={m.library_selection_clear()}
          moreLabel={m.library_selection_more()}
        />
      </div>
      <SelectionReviewView
        open={reviewOpen}
        onOpenChange={(open) => (open ? openReview() : closeReview())}
        items={reviewTargets}
        actionMeaning={
          selectedState
            ? m.library_bulk_status_review_summary({
                count: reviewTargets.length,
                status: controls.commonStates.find((option) => option.id === selectedState)?.label.text ?? selectedState,
              })
            : undefined
        }
        statusChoices={controls.commonStates}
        statusValue={selectedState}
        statusAllowed={controls.bulkStatusWriteAdmitted}
        statusBlocked={controls.selectionBlocked}
        pending={controls.pending}
        hydrated={controls.hydrated}
        onStatusChange={(value) => {
          if (value !== selectedState) controls.invalidateBulkStatusReview();
          setChosen(value);
        }}
        onReviewStatus={reviewSelectedState}
        launcher={launcher}
        isCurrent={controls.isCurrent}
      />
    </>
  );
}

function BulkStatusReview({ controls }: { controls: Controls }) {
  const review = controls.bulkStatusReview;
  if (!review) return null;
  const targetTitles = new Map(review.targets.map((target) => [target.subjectId, target.title]));
  const targets = review.targets.map((target) => ({ ...target }));
  const results = review.outcomes.map((outcome) => ({
    key: `${outcome.ordinal}:${outcome.subjectId}`,
    subjectId: outcome.subjectId,
    title: targetTitles.get(outcome.subjectId) ?? outcome.subjectId,
    state: selectionResultState(outcome.state),
    source: 'bulk-status' as const,
    sourceState: outcome.state,
  }));
  return (
    <section
      aria-label={m.library_bulk_status_journey()}
      className="space-y-2 rounded-lg border p-3 text-sm"
      data-bulk-status-phase={review.phase}
    >
      {review.operationId ? <p>{m.library_bulk_status_operation_id({ id: review.operationId })}</p> : null}
      {review.phase === 'ready' ? (
        <p>{m.library_bulk_status_review_summary({ count: review.targets.length, status: review.stateLabel })}</p>
      ) : null}
      {review.targets.length ? <SelectionReviewList items={targets} labelledBy={m.library_selection_heading()} /> : null}
      {review.phase === 'preview-uncertain' ? (
        <Button
          variant="outline"
          disabled={controls.pending || !controls.bulkStatusWriteAdmitted}
          onClick={() => void controls.retryBulkStatusPreview()}
        >
          {m.library_bulk_status_retry_preview()}
        </Button>
      ) : null}
      {review.operationId && (review.phase === 'ready' || review.phase === 'uncertain') ? (
        <Button
          disabled={controls.pending || !controls.bulkStatusWriteAdmitted}
          onClick={() => void controls.confirmSelectedState(review.state)}
        >
          {review.phase === 'uncertain' ? m.library_bulk_status_retry_confirmation() : m.library_bulk_status_confirm()}
        </Button>
      ) : null}
      {review.phase === 'confirming' ? <p role="status">{m.library_bulk_status_confirming()}</p> : null}
      {review.phase === 'recovering' ? <p role="status">{m.library_bulk_status_recovering()}</p> : null}
      {review.phase === 'uncertain' ? <p role="alert">{m.library_bulk_status_confirmation_uncertain()}</p> : null}
      {review.readError ? <p role="alert">{m.library_bulk_status_read_error()}</p> : null}
      {review.operationId ? (
        <Button
          variant="outline"
          disabled={controls.pending || !controls.bulkStatusReadAdmitted}
          onClick={() => void controls.recoverBulkStatus()}
        >
          {m.library_bulk_status_recover()}
        </Button>
      ) : null}
      <SelectionResultView results={results} />
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
  const chosen = (shelfColumns(controls.columns) ?? shelfColumnIds.join(',')).split(',');
  const activityVisible = chosen.includes('lastActivity');
  const statusVisible = chosen.includes('status');
  // ShelfTable has no title action slot. Reuse its status cell for actions when activity is hidden;
  // if status is hidden too, the cell contains only the labeled actions, never hidden status data.
  const columns: ShelfColumn[] = shelfColumnIds.map((id) => ({
    id,
    label: id === 'status' && !statusVisible ? m.library_column_actions() : shelfColumnLabel(id),
    visible: chosen.includes(id) || (id === 'status' && !activityVisible),
    sortable: sortable && ['added', 'finished', 'lastActivity'].includes(id),
  }));
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
      status: (
        <span className="inline-flex items-center gap-1">
          {!activityVisible ? (
            <EntryMenu row={row} controls={controls} trigger={{ variant: 'ghost' }}>
              {null}
            </EntryMenu>
          ) : null}
          {statusVisible ? (
            status && href ? (
              <a href={href} className="underline">
                {status}
              </a>
            ) : (
              status
            )
          ) : null}
        </span>
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
        if (
          !controls.isCurrent() ||
          !controls.sortAdmitted() ||
          !sortable ||
          !['added', 'finished', 'lastActivity'].includes(field)
        )
          return;
        const orderBy = field === 'added' ? 'createdAt' : field === 'finished' ? 'finishedAt' : 'lastActivity';
        void navigate({
          to: '/library',
          search: (previous) => {
            const { state: _state, cursor: _cursor, columns: _columns, ...rest } = previous;
            return {
              ...rest,
              ...(controls.type ? { type: controls.type } : {}),
              ...(state ? { state } : {}),
              orderBy,
              direction,
              layout: controls.layout,
              size: controls.size,
              ...(controls.columns ? { columns: controls.columns } : {}),
            };
          },
        });
      }}
    />
  );
}
type ShelfEntriesProps = {
  mutationLease?: ShelfMutationLease;
  isCurrent?: () => boolean;
  empty?: ReactNode;
  type?: string;
  entries: PersonalLibraryEntry[];
  locale: string;
  layout: ShelfLayout;
  size: ShelfSize;
  sort?: ShelfSort;
  filterSort?: ShelfSort;
  columns?: string;
  cursor?: string;
  state?: string;
};

export function ShelfEntries(props: ShelfEntriesProps) {
  const session = useSession();
  const location = useLocation();
  // Display preferences cannot change the loaded population. The actual composition owns viewer/source
  // retirement; its authoritative refreshes reconcile rows without replacing an unresolved command.
  const sourceUrl = new URL(location.href, 'https://shelf.invalid');
  for (const field of ['columns', 'layout', 'size']) sourceUrl.searchParams.delete(field);
  const population = props.isCurrent
    ? JSON.stringify([props.type, props.state, props.sort, props.cursor])
    : sourceUrl.href;
  const context = `${session.subject ?? session.state}:${props.locale}:${population}`;
  const [source, setSource] = useState({
    entries: props.entries,
    context,
    generation: 0,
    active: true,
    landedEntries: [] as ShelfRemovalIdentity[],
  });
  const latest = useRef(props.isCurrent);
  latest.current = props.isCurrent;
  const [fallbackLease] = useState(shelfMutationLease);
  const mutationLease = props.mutationLease ?? fallbackLease;
  if ((!props.isCurrent && source.entries !== props.entries) || source.context !== context) {
    source.active = false;
    setSource({
      entries: props.entries,
      context,
      generation: source.generation + 1,
      active: true,
      landedEntries: [],
    });
  }
  const sourceGeneration = source.generation;
  const onBulkRemovalLanded = (targets: readonly ShelfRemovalIdentity[]) => {
    if (source.generation !== sourceGeneration || !source.active || !(latest.current?.() ?? true)) return;
    setSource((current) => {
      if (current.generation !== sourceGeneration || !current.active) return current;
      const known = new Set(
        current.landedEntries.map(({ subjectId, revision, incarnationId, removeKey }) =>
          JSON.stringify([subjectId, revision, incarnationId ?? null, removeKey]),
        ),
      );
      const added = targets.filter(
        ({ subjectId, revision, incarnationId, removeKey }) =>
          !known.has(JSON.stringify([subjectId, revision, incarnationId ?? null, removeKey])),
      );
      return added.length ? { ...current, landedEntries: [...current.landedEntries, ...added] } : current;
    });
  };
  return (
    <ShelfEntriesPage
      key={source.generation}
      {...props}
      entries={props.entries.filter(
        (entry) => !source.landedEntries.some((landed) => matchesRemovedShelfEntry(entry, landed)),
      )}
      isCurrent={() => source.active && (latest.current?.() ?? true)}
      mutationLease={mutationLease}
      onBulkRemovalLanded={onBulkRemovalLanded}
    />
  );
}

function ShelfEntriesPage({
  entries,
  locale,
  layout,
  size,
  sort,
  filterSort,
  type,
  columns,
  cursor,
  state,
  mutationLease,
  onBulkRemovalLanded,
  isCurrent,
  empty,
}: ShelfEntriesProps & {
  mutationLease: ShelfMutationLease;
  onBulkRemovalLanded: (targets: readonly ShelfRemovalIdentity[]) => void;
}) {
  const hydrated = useHydrated();
  const shelfRows = useShelfRows(entries, locale, mutationLease, isCurrent);
  const [selectionLimitReached, setSelectionLimitReached] = useState(false);
  const controls: Controls = {
    ...shelfRows,
    locale,
    hydrated,
    selectionLimitReached,
    select: (subjectId, value) => {
      if (!value) {
        setSelectionLimitReached(false);
        shelfRows.select(subjectId, false);
        return;
      }
      const addition = appendSelectionWithinLimit(shelfRows.selected, subjectId, shelfSelectionLimit);
      setSelectionLimitReached(addition.overflow);
      if (!addition.overflow) shelfRows.select(subjectId, true);
    },
    selectPage: () => {
      const eligible = shelfRows.rows.reduce((count, row) => count + Number(shelfRows.selectable(row.entry)), 0);
      shelfRows.selectPage();
      setSelectionLimitReached(eligible > shelfSelectionLimit);
    },
    clearSelection: () => {
      setSelectionLimitReached(false);
      shelfRows.clearSelection();
    },
    layout,
    size,
    ...(columns ? { columns } : {}),
    ...(type ? { type } : {}),
    ...(sort ? { sort } : {}),
    ...(filterSort ? { filterSort } : {}),
  };
  const bulkRemoval = useBulkLibraryRemoval({
    rows: shelfRows.rows,
    selected: shelfRows.selected,
    locale,
    isCurrent: shelfRows.isCurrent,
    selectionBlocked: shelfRows.selectionBlocked,
    writeAdmitted: shelfRows.bulkStatusWriteAdmitted,
    readAdmitted: shelfRows.bulkStatusReadAdmitted,
    pending: shelfRows.pending,
    mutationLease,
    onLanded: onBulkRemovalLanded,
  });
  const leaving = shelfRows.rows.find((row) => row.entry.subjectId === shelfRows.removing)?.entry;
  const notices = layout === 'grid' ? [] : shelfRows.rows.filter((row) => row.conflict || row.failure);
  if (
    !shelfRows.rows.length &&
    !shelfRows.restoreMessage &&
    !shelfRows.outcomes.length &&
    !shelfRows.labelOutcomes.length &&
    !shelfRows.bulkStatusReview &&
    !bulkRemoval.review
  )
    return empty ?? null;
  return (
    <>
      {shelfRows.bulkStatusReviewChanged ? (
        <p role="status" className="text-sm">
          {m.library_bulk_status_review_required()}
        </p>
      ) : null}
      {shelfRows.bulkStatusError === 'preview' ? (
        <p role="alert" className="text-sm">
          {m.library_bulk_status_preview_error()}
        </p>
      ) : null}
      <ShelfSelectionBar controls={controls} bulkRemoval={bulkRemoval} selectionLimitReached={selectionLimitReached} />
      <BulkStatusReview controls={controls} />
      <BulkLibraryRemovalReviewView controller={bulkRemoval} pending={shelfRows.pending} />
      <ShelfLabelOutcomes controls={controls} />
      {shelfRows.restoreMessage ? (
        <p role="status" className="text-sm">
          {shelfRows.restoreMessage}
        </p>
      ) : null}
      {shelfRows.canRetryRestore ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={shelfRows.pending}
          onClick={() => void shelfRows.retryRestore()}
        >
          {m.library_entry_restore_retry_action()}
        </Button>
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
              returnTo={shelfHref(locale, {
                layout,
                size,
                ...sort,
                ...(columns ? { columns } : {}),
                ...(type ? { type } : {}),
                ...(state ? { state } : {}),
                ...(cursor ? { cursor } : {}),
              })}
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
      {shelfRows.selected.length ? <div aria-hidden="true" className="h-40 md:hidden" /> : null}
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
  display,
  isCurrent,
}: {
  isCurrent?: () => boolean;
  display: ShelfDisplay;
  entry: LabelShelfEntry;
  labelName: string;
  locale: string;
  csrfToken: string | null;
}) {
  const admitted = useOperation('library_label.unassign');
  const labelNameId = useId();
  if (!admitted) return null;
  return (
    <form
      method="post"
      action={shelfHref(locale, { label: entry.labelId, ...display })}
      onSubmit={(event) => {
        if (isCurrent && !isCurrent()) event.preventDefault();
      }}
    >
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
  columns,
  csrfToken,
  isCurrent,
}: {
  isCurrent?: () => boolean;
  columns?: string;
  entries: LabelShelfEntry[];
  label: { id: string; name: string };
  locale: string;
  layout: ShelfLayout;
  size: ShelfSize;
  csrfToken: string | null;
}) {
  const removeAdmitted = useOperation('library_label.unassign');
  const display: ShelfDisplay = { layout, size, ...(columns ? { columns } : {}) };
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
                          display={display}
                          {...(isCurrent ? { isCurrent } : {})}
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
                        display={display}
                        {...(isCurrent ? { isCurrent } : {})}
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
                <LabelAssignmentRemoveForm
                  display={display}
                  {...(isCurrent ? { isCurrent } : {})}
                  entry={entry}
                  labelName={label.name}
                  locale={locale}
                  csrfToken={csrfToken}
                />
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
                        display={display}
                        {...(isCurrent ? { isCurrent } : {})}
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
  const chosen = (shelfColumns(columns) ?? shelfColumnIds.join(',')).split(',');
  const statusVisible = chosen.includes('status');
  // The endpoint supplies no dates or sort authority. Its display grammar has no progress column,
  // so keep real progress in the status cell, alongside the family's existing action placement.
  // The shared title cell requires a link. Its content-capable creator cell carries this table's
  // title instead, preserving unlinkable tombstones without claiming a creator or a destination.
  const tableColumns: ShelfColumn[] = [
    { id: 'cover', label: m.library_column_cover(), visible: chosen.includes('cover') },
    { id: 'creator', label: m.library_column_title(), visible: true },
    { id: 'type', label: m.library_column_type(), visible: chosen.includes('type') },
    {
      id: 'status',
      label: statusVisible ? m.library_label_table_status_progress() : m.library_column_actions(),
      visible: statusVisible || removeAdmitted,
    },
  ];
  const tableRows: ShelfTableRow[] = entries.map((entry) => {
    const entryTitle = entry.subject
      ? displayLibraryTitle(entry.subject.label, locale)
      : { text: m.library_subject_unavailable(), lang: undefined };
    const progress = labelEntryProgress(entry, locale);
    return {
      id: entry.id,
      title: entryTitle.text,
      href: entry.subject ? href(entry) : '',
      cover: shelfCover(entry.subject),
      creator: entry.subject ? (
        <a className="font-medium break-words hover:underline" href={href(entry)} lang={entryTitle.lang}>
          {entryTitle.text}
        </a>
      ) : (
        <Tombstone shape="row" labels={{ unavailable: m.library_subject_unavailable() }} />
      ),
      type: entry.subject?.typeLabel,
      status: (
        <div className="flex flex-wrap items-center gap-2">
          {statusVisible ? (
            <div className="min-w-0 space-y-1">
              {entry.state ? <span>{entry.stateLabel ?? m.library_other()}</span> : null}
              {progress ? <ProgressRow {...progress} /> : null}
            </div>
          ) : null}
          {removeAdmitted ? (
            <ItemMenu
              title={m.library_entry_actions({ title: entryTitle.text })}
              backLabel={m.library_menu_back()}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 pointer-coarse:size-11"
                  aria-label={m.library_entry_actions({ title: entryTitle.text })}
                >
                  <EllipsisIcon aria-hidden="true" />
                </Button>
              }
              content={
                <LabelAssignmentRemoveForm
                  display={display}
                  {...(isCurrent ? { isCurrent } : {})}
                  entry={entry}
                  labelName={label.name}
                  locale={locale}
                  csrfToken={csrfToken}
                />
              }
            />
          ) : null}
        </div>
      ),
    };
  });
  return <ShelfTable rows={tableRows} columns={tableColumns} onSort={() => {}} />;
}
