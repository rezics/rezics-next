import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ToggleGroup, ToggleGroupItem } from '@rezics/ui/shadcn/toggle-group';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { useOperation } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import type { LibraryEntryStateWrite } from './entries-read';
import {
  shelfHref,
  shelfLayouts,
  shelfSizes,
  explicitShelfDisplay,
  validateShelfSearch,
  type ShelfSort,
  type ShelfLayout,
  type ShelfSize,
  type ShelfDisplay,
  type ShelfSearch,
  type ShelfPresentationIntent,
} from './shelf-params';
import { replaceShelfAddress, shelfIntentWith, type ShelfPresentationResolution } from './shelf-preferences';
import { ShelfColumnsControl } from './shelf-columns';
import { useHydrated } from './shelf-rows';

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
function PresentationNotice({
  presentation,
  display,
  label,
}: {
  presentation?: ShelfPresentationResolution;
  display: Display;
  label?: string;
}) {
  if (!presentation) return null;
  return (
    <div role="note" className="w-full text-sm text-muted-foreground" data-testid="shelf-presentation-source">
      {display.layoutSource === 'url'
        ? m.library_layout_source_url()
        : display.layoutSource === 'type'
          ? m.library_layout_source_type()
          : display.layoutSource === 'all'
            ? m.library_layout_source_all()
            : m.library_layout_source_application()}{' '}
      {presentation.sources.size === 'url'
        ? m.library_size_source_url()
        : presentation.sources.size === 'saved'
          ? m.library_size_source_saved()
          : m.library_size_source_application()}{' '}
      {!label
        ? presentation.sources.columns === 'url'
          ? m.library_columns_source_url()
          : presentation.sources.columns === 'saved'
            ? m.library_columns_source_saved()
            : m.library_columns_source_application()
        : null}{' '}
      {!label
        ? presentation.sources.sort === 'url'
          ? m.library_sort_source_url()
          : presentation.sources.sort === 'saved'
            ? m.library_sort_source_saved()
            : m.library_sort_source_application()
        : null}
      {!label && presentation.unsupported.sort ? (
        <span className="block">{m.library_saved_sort_unsupported({ field: presentation.unsupported.sort })}</span>
      ) : null}
      {!label && presentation.unsupported.columns.length ? (
        <span className="block">{m.library_saved_columns_unsupported()}</span>
      ) : null}
    </div>
  );
}
export function DisplayControls({
  state,
  type,
  locale,
  display,
  label,
  cursor,
  filterSort,
  tableAvailable,
  presentation,
  isCurrent,
}: {
  state?: LibraryEntryStateWrite;
  type?: string;
  locale: string;
  display: Display;
  label?: string;
  filterSort?: ShelfSort;
  cursor?: string;
  tableAvailable?: boolean;
  presentation?: ShelfPresentationResolution;
  isCurrent?: () => boolean;
}) {
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const typeSearch = type ? { type } : {};
  const stateSearch: ShelfPresentationIntent = presentation?.intent ?? {
    ...typeSearch,
    ...(state ? { state } : {}),
    ...(filterSort ?? {}),
    ...explicitShelfDisplay(display),
    ...(cursor ? { cursor } : {}),
    ...(label ? { label } : {}),
  };
  const labelSearch = label ? { label } : {};
  const restoreHref = shelfHref(locale, { ...(label ? labelSearch : typeSearch), ...(state ? { state } : {}) });
  const choice = (patch: Partial<ShelfPresentationIntent>, clearCursor = false): ShelfPresentationIntent => {
    const next = presentation ? shelfIntentWith(presentation, patch, { clearCursor }) : { ...stateSearch, ...patch };
    if (clearCursor) delete next.cursor;
    return next;
  };
  const navigateToChoice = (patch: Partial<ShelfPresentationIntent>) => {
    if (!(isCurrent?.() ?? true)) return;
    const next = choice(patch);
    void navigate({ to: '/library', search: (previous) => replaceShelfAddress(previous, next) });
  };
  const clearStateView: ShelfPresentationIntent = { ...stateSearch };
  delete clearStateView.state;
  if (!hydrated) {
    const selected = (current: boolean) => buttonVariants({ variant: current ? 'secondary' : 'outline', size: 'sm' });
    return (
      <div className="flex flex-wrap items-center gap-4">
        <nav aria-label={m.library_layout()} className="flex gap-1">
          {shelfLayouts.map((layout) => (
            <a
              key={layout}
              href={shelfHref(locale, choice({ layout, layoutExplicit: true }))}
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
                href={shelfHref(locale, choice({ size, sizeExplicit: true }))}
                aria-current={display.size === size ? 'page' : undefined}
                className={selected(display.size === size)}
              >
                {sizeLabel(size)}
              </a>
            ))}
          </nav>
        ) : null}
        {state ? (
          <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={shelfHref(locale, clearStateView)}>
            {m.library_clear_state()}
          </a>
        ) : null}
        <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={restoreHref}>
          {m.library_shelf_restore_defaults()}
        </a>
        <PresentationNotice
          {...(presentation ? { presentation } : {})}
          display={display}
          {...(label ? { label } : {})}
        />
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
          if (layout) navigateToChoice({ layout, layoutExplicit: true });
        }}
        variant="outline"
      >
        {shelfLayouts.map((layout) => (
          <ToggleGroupItem
            key={layout}
            value={layout}
            className={`min-h-11 min-w-11 ${layout === 'table' ? 'max-sm:hidden' : ''}`}
          >
            {layoutLabel(layout)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {display.layout === 'table' && !label && tableAvailable ? (
        <div className="hidden sm:block">
          <ShelfColumnsControl
            {...(display.columns ? { value: display.columns } : {})}
            disabled={!hydrated}
            view={stateSearch}
            {...(isCurrent ? { isCurrent } : {})}
          />
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
                search: (previous) => replaceShelfAddress(previous, choice({ size, sizeExplicit: true })),
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
        <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={shelfHref(locale, clearStateView)}>
          {m.library_clear_state()}
        </a>
      ) : null}
      <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={restoreHref}>
        {m.library_shelf_restore_defaults()}
      </a>
      <PresentationNotice {...(presentation ? { presentation } : {})} display={display} {...(label ? { label } : {})} />
    </div>
  );
}

/** Ordinary URL form works before hydration and resets the keyset when the selected predicate changes. */
export function SortControls({
  locale,
  state,
  type,
  display,
  sort,
  presentation,
  isCurrent,
}: {
  locale: string;
  state?: string;
  type?: string;
  display: Display;
  sort: ShelfSort;
  presentation?: ShelfPresentationResolution;
  isCurrent?: () => boolean;
}) {
  const navigate = useNavigate();
  const entries = useOperation('library_entry.list');
  const progress = useOperation('progress_session.list');
  const address = JSON.stringify([
    locale,
    state,
    type,
    display.layout,
    display.size,
    display.columns,
    sort.orderBy,
    sort.direction,
  ]);
  const [selection, setSelection] = useState({ address, ...sort });
  // Replace pending edits with a newly supplied address without remounting focused controls.
  if (selection.address !== address) setSelection({ address, ...sort });
  const scoreOrder = selection.orderBy === 'personalScore';
  const priorityOrder = selection.orderBy === 'priority';
  const unavailableOrder = scoreOrder;
  if (!entries || !progress) return null;
  return (
    <form
      method="get"
      action={`/${locale}/library`}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!(isCurrent?.() ?? true)) return;
        const changed = selection.orderBy !== sort.orderBy || selection.direction !== sort.direction;
        const next: ShelfPresentationIntent = presentation
          ? shelfIntentWith(
              presentation,
              {
                ...(selection.orderBy !== sort.orderBy ? { orderBy: selection.orderBy } : {}),
                ...(selection.direction !== sort.direction ? { direction: selection.direction } : {}),
              },
              { clearCursor: changed },
            )
          : validateShelfSearch(Object.fromEntries(new FormData(event.currentTarget)));
        void navigate({ to: '/library', search: (previous) => replaceShelfAddress(previous, next) });
      }}
    >
      {state ? <input type="hidden" name="state" value={state} /> : null}
      {type ? <input type="hidden" name="type" value={type} /> : null}
      {display.layoutExplicit ? <input type="hidden" name="layout" value={display.layout} /> : null}
      {display.sizeExplicit ? <input type="hidden" name="size" value={display.size} /> : null}
      {display.columnsExplicit && display.columns ? (
        <input type="hidden" name="columns" value={display.columns} />
      ) : null}
      {/* A disabled selected option is not a successful form control. Retain the explicit score address. */}
      {unavailableOrder ? <input type="hidden" name="orderBy" value={selection.orderBy} /> : null}
      <label className="grid min-w-0 max-w-full gap-1 text-sm">
        {m.library_sort_by()}
        <select
          name={unavailableOrder ? undefined : 'orderBy'}
          value={selection.orderBy}
          onChange={(event) => {
            if (!(isCurrent?.() ?? true)) return;
            const orderBy = validateShelfSearch({ orderBy: event.target.value }).orderBy;
            if (orderBy && orderBy !== 'personalScore') setSelection({ ...selection, orderBy });
          }}
          className="min-h-11 max-w-full rounded-md border bg-background p-2"
        >
          <option value="lastActivity">{m.library_sort_activity()}</option>
          <option value="createdAt">{m.library_sort_created()}</option>
          <option value="finishedAt">{m.library_sort_finished()}</option>
          <option value="priority">{m.library_rich_entry_priority()}</option>
          <option value="title">{m.library_column_title()}</option>
          <option value="personalScore" disabled>
            {m.library_score_order()}
          </option>
        </select>
      </label>
      <label className="grid min-w-0 max-w-full gap-1 text-sm">
        {m.library_sort_direction()}
        {scoreOrder ? <input type="hidden" name="direction" value={selection.direction} /> : null}
        <select
          name="direction"
          disabled={scoreOrder}
          value={selection.direction}
          onChange={(event) => {
            if (scoreOrder || !(isCurrent?.() ?? true)) return;
            const direction = validateShelfSearch({ direction: event.target.value }).direction;
            if (direction) setSelection({ ...selection, direction });
          }}
          className="min-h-11 max-w-full rounded-md border bg-background p-2"
        >
          <option value="desc">
            {priorityOrder
              ? m.library_priority_descending()
              : scoreOrder
                ? m.library_score_highest()
                : selection.orderBy === 'title'
                  ? 'Z–A'
                  : m.library_sort_newest()}
          </option>
          <option value="asc">
            {priorityOrder
              ? m.library_priority_ascending()
              : scoreOrder
                ? m.library_score_lowest()
                : selection.orderBy === 'title'
                  ? 'A–Z'
                  : m.library_sort_oldest()}
          </option>
        </select>
      </label>
      <Button type="submit" variant="outline" className="min-h-11">
        {m.library_sort_apply()}
      </Button>
    </form>
  );
}

/** A document navigation deliberately performs a fresh read even when already on the first page. */
export function EntriesFirstPage({ locale, view }: { locale: string; view: ShelfSearch }) {
  const { cursor: _cursor, ...first } = view;
  return (
    <a href={shelfHref(locale, first)} className={buttonVariants({ variant: 'outline' })}>
      {m.library_entries_first_page()}
    </a>
  );
}
