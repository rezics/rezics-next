import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ToggleGroup, ToggleGroupItem } from '@rezics/ui/shadcn/toggle-group';
import { ShelfEmpty } from '@rezics/ui/shelf-empty';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { EntryRestoreFeedback, EntryUndoForm } from './entry-undo';
import { ContinueSection, useContinueRefresh } from './continue';
import { LibraryNavigation } from './library-nav';
import type { LibraryNavigationRead } from './pins-read';
import { useCurrentLibraryNavigation } from './pins-current';
import { readContinueEntries, type ContinueEntry, type ContinueView } from './continue-read';
import type {
  LibraryEntryStateWrite,
  LibraryRestoreInput,
  LibraryRestoreResult,
  PersonalLibraryView,
} from './entries-read';
import { Exposure, useOperation } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import {
  shelfHref,
  shelfSort,
  type ShelfSort,
  shelfLayouts,
  shelfSizes,
  type ShelfLayout,
  type ShelfSize,
  type ShelfDisplay,
} from './shelf-params';
import { ShelfEntries } from './shelf-view';
import { ShelfColumnsControl } from './shelf-columns';
import { shelfMutationLease, useHydrated, type ShelfMutationLease } from './shelf-rows';
import { LabelShelfEntries } from './shelf-view';
import type { LabelShelfPageData } from './label-shelf-read';
import { SubjectLabelNotice } from './subject-labels.tsx';
import { ShelfTypes } from './shelf-types';

type Display = ShelfDisplay;
function layoutLabel(layout: ShelfLayout): string {
  return layout === 'grid'
    ? m.library_layout_grid()
    : layout === 'list'
      ? m.library_layout_list()
      : m.library_layout_table();
}
function sizeLabel(size: ShelfSize): string {
  return size === 's' ? m.library_size_small() : size === 'm' ? m.library_size_medium() : m.library_size_large();
}
function DisplayControls({
  state,
  type,
  locale,
  display,
  label,
  sort,
  cursor,
  filterSort,
  tableAvailable,
  isCurrent,
}: {
  state?: LibraryEntryStateWrite;
  type?: string;
  locale: string;
  display: Display;
  label?: string;
  sort?: ShelfSort;
  filterSort?: ShelfSort;
  cursor?: string;
  tableAvailable?: boolean;
  isCurrent?: () => boolean;
}) {
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const typeSearch = type ? { type } : {};
  const stateSearch = { ...typeSearch, ...(state ? { state } : {}), ...sort, ...(cursor ? { cursor } : {}) };
  const labelSearch = label ? { label } : {};
  if (!hydrated) {
    const selected = (current: boolean) => buttonVariants({ variant: current ? 'secondary' : 'outline', size: 'sm' });
    return (
      <div className="flex flex-wrap items-center gap-4">
        <nav aria-label={m.library_layout()} className="flex gap-1">
          {shelfLayouts.map((layout) => (
            <a
              key={layout}
              href={shelfHref(locale, { ...stateSearch, ...display, layout, ...labelSearch })}
              aria-current={display.layout === layout ? 'page' : undefined}
              className={`${selected(display.layout === layout)}${layout === 'table' ? ' max-sm:hidden' : ''}`}
            >
              {layoutLabel(layout)}
            </a>
          ))}
        </nav>
        {display.layout === 'grid' ? (
          <nav aria-label={m.library_size()} className="flex gap-1">
            {shelfSizes.map((size) => (
              <a
                key={size}
                href={shelfHref(locale, { ...stateSearch, ...display, size, ...labelSearch })}
                aria-current={display.size === size ? 'page' : undefined}
                className={selected(display.size === size)}
              >
                {sizeLabel(size)}
              </a>
            ))}
          </nav>
        ) : null}
        {state ? (
          <a
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            href={shelfHref(locale, { ...typeSearch, ...filterSort, ...display, ...labelSearch })}
          >
            {m.library_clear_state()}
          </a>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-4">
      <ToggleGroup
        aria-label={m.library_layout()}
        value={[display.layout]}
        onValueChange={(values) => {
          const layout = values[0] as ShelfLayout | undefined;
          if (layout && (isCurrent?.() ?? true))
            void navigate({
              to: '/library',
              search: (previous) => ({ ...previous, ...stateSearch, ...labelSearch, ...display, layout }),
            });
        }}
        variant="outline"
      >
        {shelfLayouts.map((layout) => (
          <ToggleGroupItem key={layout} value={layout} className={layout === 'table' ? 'max-sm:hidden' : undefined}>
            {layoutLabel(layout)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {display.layout === 'table' && !label && tableAvailable ? (
        <div className="hidden sm:block">
          <ShelfColumnsControl {...(display.columns ? { value: display.columns } : {})} disabled={!hydrated} />
        </div>
      ) : null}
      {display.layout === 'grid' ? (
        <ToggleGroup
          aria-label={m.library_size()}
          value={[display.size]}
          onValueChange={(values) => {
            const size = values[0] as ShelfSize | undefined;
            if (size && (isCurrent?.() ?? true))
              void navigate({
                to: '/library',
                search: (previous) => ({ ...previous, ...stateSearch, ...labelSearch, ...display, size }),
              });
          }}
          variant="outline"
        >
          {shelfSizes.map((size) => (
            <ToggleGroupItem key={size} value={size}>
              {sizeLabel(size)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      {state ? (
        <a
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          href={shelfHref(locale, { ...typeSearch, ...filterSort, ...display, ...labelSearch })}
        >
          {m.library_clear_state()}
        </a>
      ) : null}
    </div>
  );
}

/** Ordinary URL form works before hydration and resets the keyset when the selected predicate changes. */
function SortControls({
  locale,
  state,
  type,
  display,
  sort,
}: {
  locale: string;
  state?: string;
  type?: string;
  display: Display;
  sort: ShelfSort;
}) {
  const entries = useOperation('library_entry.list');
  const progress = useOperation('progress_session.list');
  if (!entries || !progress) return null;
  return (
    <form method="get" action={`/${locale}/library`} className="flex flex-wrap items-end gap-2">
      {state ? <input type="hidden" name="state" value={state} /> : null}
      {type ? <input type="hidden" name="type" value={type} /> : null}
      <input type="hidden" name="layout" value={display.layout} />
      <input type="hidden" name="size" value={display.size} />
      {display.columns ? <input type="hidden" name="columns" value={display.columns} /> : null}
      <label className="grid gap-1 text-sm">
        {m.library_sort_by()}
        <select name="orderBy" defaultValue={sort.orderBy} className="rounded-md border bg-background p-2">
          <option value="lastActivity">{m.library_sort_activity()}</option>
          <option value="createdAt">{m.library_sort_created()}</option>
          <option value="finishedAt">{m.library_sort_finished()}</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        {m.library_sort_direction()}
        <select name="direction" defaultValue={sort.direction} className="rounded-md border bg-background p-2">
          <option value="desc">{m.library_sort_newest()}</option>
          <option value="asc">{m.library_sort_oldest()}</option>
        </select>
      </label>
      <Button type="submit" variant="outline">
        {m.library_sort_apply()}
      </Button>
    </form>
  );
}

export function PersonalLibraryPage({
  page,
  locale,
  display,
  cursor,
  continueEntries,
  continueState,
  undo,
  restore,
  csrfToken,
  acceptedNavigation,
  originatingLease,
  continueRead,
  isCurrent,
}: {
  page: PersonalLibraryView;
  locale: string;
  display: Display;
  cursor?: string;
  continueEntries?: ContinueEntry[];
  continueState?: ContinueView;
  undo?: LibraryRestoreInput;
  restore?: LibraryRestoreResult;
  csrfToken?: string | null;
  acceptedNavigation?: LibraryNavigationRead;
  originatingLease?: ShelfMutationLease;
  continueRead?: () => Promise<Exclude<ContinueView, { state: 'unknown' }>>;
  isCurrent?: () => boolean;
}) {
  // Keep the write lease while a predicate replaces rows or temporarily shows no matches.
  const [fallbackLease] = useState(shelfMutationLease);
  const mutationLease = originatingLease ?? fallbackLease;
  const navigation = useCurrentLibraryNavigation(
    locale, 8, JSON.stringify(page.signedIn ? [page.type, page.state, cursor, page.sort] : [cursor]), acceptedNavigation === undefined,
  );
  const currentNavigation = acceptedNavigation ?? navigation.data;
  const readContinue = useCallback(() => readContinueEntries({ data: {} }), []);
  const resume = useContinueRefresh(continueState, continueRead ?? readContinue, locale);
  const currentContinue = continueState ? resume.result : undefined;
  // Only a successful exhausted source establishes absence; readiness and failed reads remain visible.
  const continueAbsent =
    currentContinue?.state === 'loaded' && currentContinue.entries.length === 0 && currentContinue.next === null;

  if (!page.signedIn)
    return (
      <div className="container mx-auto max-w-7xl px-4 py-8">
        <p>{m.library_sign_in()}</p>
      </div>
    );
  const sort = page.sort ?? shelfSort(page);
  const filterSort = page.sortExplicit ? sort : undefined;
  const effectiveCursor = page.cursorReset ? undefined : cursor;
  const typeSearch = page.type ? { type: page.type } : {};
  const clearTypeHref = shelfHref(locale, { ...(page.state ? { state: page.state } : {}), ...sort, ...display });
  const typeLabel = page.typeLabel ?? m.library_type_unnamed();
  const heading = page.state
    ? m.library_tracked_entries_state({ status: page.stateLabel ?? m.library_other() })
    : m.library_tracked_entries();
  return (
    <div className="w-full min-w-0 space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <PageHeading>{m.library_heading()}</PageHeading>
        <Exposure operation="library_label.list">
          <a href={`/${locale}/library/labels`} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            {m.library_nav_labels()}
          </a>
        </Exposure>
      </header>
      <LibraryNavigation
        current="tracked"
        locale={locale}
        pins={currentNavigation?.pins ?? { state: navigation.isError ? 'unavailable' : 'preparing' }}
        collections={currentNavigation?.collections ?? []}
        collectionsState={currentNavigation?.collectionsState ?? (navigation.isError ? 'unavailable' : 'preparing')}
      />
      {undo ? (
        <EntryUndoForm
          undo={undo}
          locale={locale}
          csrfToken={csrfToken ?? null}
          returnTo={shelfHref(locale, {
            ...typeSearch,
            ...display,
            ...sort,
            ...(page.state ? { state: page.state } : {}),
            ...(effectiveCursor ? { cursor: effectiveCursor } : {}),
          })}
        />
      ) : null}
      {restore ? <EntryRestoreFeedback restore={restore} locale={locale} /> : null}
      {continueAbsent ? null : (
        <ContinueSection
          {...(currentContinue ? { state: currentContinue } : continueEntries ? { entries: continueEntries } : {})}
          onRetry={() => void resume.refresh()}
          busy={resume.busy}
          locale={locale}
          density={display.size === 's' ? 'small' : display.size === 'l' ? 'large' : 'medium'}
        />
      )}
      <section aria-labelledby="tracked-entries-heading" className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="tracked-entries-heading" className="text-2xl font-semibold">
            {heading}
          </h2>
          <Exposure operation="library_entry.list">
            <DisplayControls
              {...typeSearch}
              {...(page.state ? { state: page.state } : {})}
              locale={locale}
              display={display}
              {...(isCurrent ? { isCurrent } : {})}
              tableAvailable={!page.readState && page.entries.length > 0}
              sort={sort}
              {...(filterSort ? { filterSort } : {})}
              {...(effectiveCursor ? { cursor: effectiveCursor } : {})}
            />
          </Exposure>
        </div>
        <SortControls
          key={`${page.type ?? ''}:${page.state ?? ''}:${sort.orderBy}:${sort.direction}`}
          locale={locale}
          {...(page.state ? { state: page.state } : {})}
          display={display}
          sort={sort}
          {...typeSearch}
        />
        <div className="flex flex-wrap items-center gap-2">
          <ShelfTypes
            key={`${locale}:${page.type ?? ''}`}
            locale={locale}
            view={{ ...typeSearch, ...(page.state ? { state: page.state } : {}), ...sort, ...display }}
            {...(page.typeLabel ? { typeLabel: page.typeLabel } : {})}
          />
          {page.type ? (
            <a href={clearTypeHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              {m.library_type_clear()}
            </a>
          ) : null}
        </div>
        {page.cursorReset ? <p role="status">{m.library_sort_restarted()}</p> : null}
        {page.type ? (
          <p className="text-sm text-muted-foreground">{m.library_type_filtered({ type: typeLabel })}</p>
        ) : null}
        {page.state ? (
          <p className="text-sm text-muted-foreground">
            {m.library_filtered_by({ status: page.stateLabel ?? m.library_other() })}
          </p>
        ) : null}
        {page.readState ? (
          <p role={page.readState === 'preparing' ? 'status' : 'alert'}>
            {page.readState === 'closed'
              ? m.platform_closed_message()
              : page.readState === 'denied'
                ? m.library_sort_denied()
                : page.readState === 'preparing'
                  ? m.library_sort_preparing()
                  : m.error_message()}
          </p>
        ) : (
          <ShelfEntries
            key={`${page.type ?? ''}:${page.state ?? 'all'}:${sort.orderBy}:${sort.direction}:${effectiveCursor ?? ''}`}
            mutationLease={mutationLease}
            {...(isCurrent ? { isCurrent } : {})}
            {...typeSearch}
            sort={sort}
            {...(filterSort ? { filterSort } : {})}
            {...(page.state ? { state: page.state } : {})}
            entries={page.entries}
            {...(effectiveCursor ? { cursor: effectiveCursor } : {})}
            locale={locale}
            {...display}
            empty={
              <ShelfEmpty
                kind={page.type || page.state ? 'no-match' : 'library'}
                title={
                  page.type
                    ? m.library_type_empty_title({ type: typeLabel })
                    : page.state
                      ? m.library_filter_empty_title({ status: page.stateLabel ?? m.library_other() })
                      : m.library_empty_title()
                }
                description={
                  page.type || page.state ? m.library_filter_empty_description() : m.library_empty_description()
                }
                actions={
                  page.type ? (
                    <a href={clearTypeHref} className={buttonVariants({ variant: 'outline' })}>
                      {m.library_type_clear()}
                    </a>
                  ) : (
                    <a href={`/${locale}/search`} className={buttonVariants({ variant: 'outline' })}>
                      {m.library_browse()}
                    </a>
                  )
                }
              />
            }
          />
        )}
        {page.next ? (
          <a
            className={buttonVariants({ variant: 'outline' })}
            href={shelfHref(locale, {
              ...typeSearch,
              ...(page.state ? { state: page.state } : {}),
              ...sort,
              cursor: page.next,
              ...display,
            })}
          >
            {m.library_next_page()}
          </a>
        ) : null}
      </section>
    </div>
  );
}

/** One label's complete current page, with the same presentation controls and shelf tile primitives. */
export function LabelShelfPage({
  page,
  locale,
  display,
}: {
  page: LabelShelfPageData;
  locale: string;
  display: Display;
}) {
  if (page.state === 'unavailable' || page.state === 'denied' || page.state === 'preparing')
    return (
      <div className="max-w-6xl space-y-6 text-foreground">
        <PageHeading>{m.library_labels_heading()}</PageHeading>
        <p role={page.state === 'unavailable' ? 'alert' : 'status'}>
          {page.state === 'preparing'
            ? m.library_labels_preparing()
            : page.state === 'denied'
              ? m.library_labels_denied()
              : m.library_subject_label_unavailable()}
        </p>
        <a href={`/${encodeURIComponent(locale)}/library/labels`}>{m.library_labels_heading()}</a>
      </div>
    );
  if (page.state === 'closed')
    return (
      <div className="max-w-6xl space-y-6 text-foreground">
        <PageHeading>{m.library_heading()}</PageHeading>
        <p role="status">{m.library_label_shelf_closed()}</p>
      </div>
    );
  if (page.state === 'signed-out')
    return (
      <div className="max-w-6xl space-y-6 text-foreground">
        <PageHeading>{m.account_sign_in()}</PageHeading>
      </div>
    );
  return (
    <div className="max-w-6xl space-y-6 text-foreground">
      <PageHeading>{page.label.name}</PageHeading>
      <SubjectLabelNotice {...(page.labelResult !== undefined ? { result: page.labelResult } : {})} />
      <DisplayControls locale={locale} display={display} label={page.label.id} />
      {page.entries.length ? (
        <LabelShelfEntries
          entries={page.entries}
          label={page.label}
          locale={locale}
          {...display}
          csrfToken={page.csrfToken ?? null}
        />
      ) : (
        <Empty role="status" data-kind="library">
          <EmptyHeader>
            <EmptyTitle>{m.library_label_shelf_empty()}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {page.next ? (
        <a
          href={shelfHref(locale, { label: page.label.id, ...display, cursor: page.next })}
          className={buttonVariants({ variant: 'outline', size: 'lg' })}
        >
          {m.library_more()}
        </a>
      ) : null}
      {page.undo ? (
        <Exposure operation="library_label.unassign">
          <form data-label-undo method="post" action={shelfHref(locale, { label: page.label.id, ...display })}>
            <input type="hidden" name="intent" value="restore" />
            <input type="hidden" name="subjectId" value={page.undo.subjectId} />
            <input type="hidden" name="labelId" value={page.undo.labelId} />
            <input type="hidden" name="assignmentId" value={page.undo.assignmentId} />
            <input type="hidden" name="idempotencyKey" value={page.undoKey} />
            <input type="hidden" name="revision" value={page.undo.revision} />
            <input type="hidden" name="csrf_token" value={page.csrfToken ?? ''} />
            <button type="submit" className={buttonVariants({ variant: 'outline' })}>
              {m.library_subject_label_undo()}
            </button>
          </form>
        </Exposure>
      ) : null}
    </div>
  );
}
