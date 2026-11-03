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
  validateShelfSearch,
  type ShelfSort,
  type ShelfLayout,
  type ShelfSize,
  type ShelfDisplay,
  type ShelfSearch,
} from './shelf-params';
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
export function DisplayControls({
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
  const displaySearch = {
    layout: display.layout,
    size: display.size,
    ...(display.columns !== undefined ? { columns: display.columns } : {}),
  };
  const restoreHref = shelfHref(locale, { ...(label ? labelSearch : typeSearch), ...(state ? { state } : {}) });
  if (!hydrated) {
    const selected = (current: boolean) => buttonVariants({ variant: current ? 'secondary' : 'outline', size: 'sm' });
    return (
      <div className="flex flex-wrap items-center gap-4">
        <nav aria-label={m.library_layout()} className="flex gap-1">
          {shelfLayouts.map((layout) => (
            <a
              key={layout}
              href={shelfHref(locale, { ...stateSearch, ...display, layout, layoutExplicit: true, ...labelSearch })}
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
                href={shelfHref(locale, { ...stateSearch, ...display, size, sizeExplicit: true, ...labelSearch })}
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
        {!label ? (
          <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={restoreHref}>
            {m.library_shelf_restore_defaults()}
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
              search: label
                ? (previous) => ({ ...previous, ...stateSearch, ...labelSearch, ...displaySearch, layout })
                : { ...stateSearch, ...displaySearch, layout },
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
          <ShelfColumnsControl
            {...(display.columns ? { value: display.columns } : {})}
            disabled={!hydrated}
            view={{ ...stateSearch, ...displaySearch }}
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
                search: label
                  ? (previous) => ({ ...previous, ...stateSearch, ...labelSearch, ...displaySearch, size })
                  : { ...stateSearch, ...displaySearch, size },
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
      {!label ? (
        <a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={restoreHref}>
          {m.library_shelf_restore_defaults()}
        </a>
      ) : null}
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
  isCurrent,
}: {
  locale: string;
  state?: string;
  type?: string;
  display: Display;
  sort: ShelfSort;
  isCurrent?: () => boolean;
}) {
  const navigate = useNavigate();
  const entries = useOperation('library_entry.list');
  const progress = useOperation('progress_session.list');
  if (!entries || !progress) return null;
  return (
    <form
      method="get"
      action={`/${locale}/library`}
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!(isCurrent?.() ?? true)) return;
        const search = validateShelfSearch(Object.fromEntries(new FormData(event.currentTarget)));
        void navigate({ to: '/library', search });
      }}
    >
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

/** A document navigation deliberately performs a fresh read even when already on the first page. */
export function EntriesFirstPage({ locale, view }: { locale: string; view: ShelfSearch }) {
  const { cursor: _cursor, ...first } = view;
  return (
    <a href={shelfHref(locale, first)} className={buttonVariants({ variant: 'outline' })}>
      {m.library_entries_first_page()}
    </a>
  );
}
