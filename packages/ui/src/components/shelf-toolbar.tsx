import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../shadcn/button.tsx';
import { ToggleGroup, ToggleGroupItem } from '../shadcn/toggle-group.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../shadcn/tabs.tsx';
import { Badge } from '../shadcn/badge.tsx';
import { ChoiceSelect } from './choice-select.tsx';
import { Menu } from './menu.tsx';
import { LayoutSelect } from './layout-select.tsx';

type Option = { value: string; label: string };
type Layout = 'grid' | 'list' | 'table';
type Density = 'small' | 'medium' | 'large';

/** A navigable status strip; shadcn has no link-based shelf navigation. */
export function ShelfTabs({
  tabs,
  value,
  onValueChange,
}: {
  tabs: (Option & { href: string; count: number; shown?: number })[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const active = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    active.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [value]);
  return (
    <nav className="flex min-w-0 gap-1 overflow-x-auto border-b">
      {tabs.map((tab) => (
        <a
          key={tab.value}
          ref={tab.value === value ? active : undefined}
          href={tab.href}
          aria-current={tab.value === value ? 'page' : undefined}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.defaultPrevented
            )
              return;
            const nativeEvent = event.nativeEvent;
            const nextValue = tab.value;
            queueMicrotask(() => {
              if (!nativeEvent.defaultPrevented) onValueChange(nextValue);
            });
          }}
          className="shrink-0 border-b-2 border-transparent px-3 py-3 text-sm text-muted-foreground aria-[current=page]:border-primary aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
        >
          {tab.label}{' '}
          <span className="ml-1 tabular-nums">
            {tab.shown === undefined ? tab.count : `${tab.shown} / ${tab.count}`}
          </span>
        </a>
      ))}
    </nav>
  );
}

/** A single-select shelf type row, composed from the shadcn toggle group. */
export function ShelfTypeChips({
  label,
  options,
  value,
  onValueChange,
}: {
  label: string;
  options: Option[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(values) => {
        if (values[0]) onValueChange(values[0]);
      }}
      variant="outline"
      className="max-w-full overflow-x-auto"
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

type Labels = {
  sort: string;
  direction: string;
  ascending: string;
  descending: string;
  filter: string;
  clearFilters: string;
  removeFilter: string;
  layout: string;
  grid: string;
  list: string;
  table: string;
  display: string;
  density: string;
  small: string;
  medium: string;
  large: string;
  select: string;
  view: string;
  items: string;
};
type Props = {
  labels: Labels;
  sorts: Option[];
  sort: string;
  direction: 'asc' | 'desc';
  onSortChange: (sort: string, direction: 'asc' | 'desc') => void;
  filters: ReactNode;
  active: { key: string; label: string }[];
  onRemoveFilter: (key: string) => void;
  onClearFilters: () => void;
  layout: Layout;
  onLayoutChange: (layout: Layout) => void;
  density: Density;
  onDensityChange: (density: Density) => void;
  columns?: ReactNode;
  onSelect: () => void;
  count: number;
};
/** Shelf controls combine shadcn primitives; the registry has no shelf toolbar. */
export function ShelfToolbar(p: Props) {
  const { labels: l } = p;
  const sortId = useId();
  const directionId = useId();
  const sort = (
    <div className="grid min-w-0 gap-3">
      <ChoiceSelect
        id={sortId}
        label={l.sort}
        fieldClassName="min-w-0 gap-1"
        labelClassName="min-w-0 max-w-full whitespace-normal break-words text-sm"
        triggerClassName="w-full min-w-0 max-w-full h-11 min-h-11 md:h-8 md:min-h-8"
        value={p.sort}
        onValueChange={(value) => {
          if (value !== null) p.onSortChange(value, p.direction);
        }}
        options={p.sorts}
      />
      <ChoiceSelect
        id={directionId}
        label={l.direction}
        fieldClassName="min-w-0 gap-1"
        labelClassName="min-w-0 max-w-full whitespace-normal break-words text-sm"
        triggerClassName="w-full min-w-0 max-w-full h-11 min-h-11 md:h-8 md:min-h-8"
        value={p.direction}
        onValueChange={(value) => {
          if (value === 'asc' || value === 'desc') p.onSortChange(p.sort, value);
        }}
        options={[
          { value: 'asc', label: l.ascending },
          { value: 'desc', label: l.descending },
        ]}
      />
    </div>
  );
  const filter = (
    <div className="grid min-w-0 gap-3">
      {p.filters}
      <div className="flex min-w-0 flex-wrap gap-2">
        {p.active.map((f) => (
          <Button
            key={f.key}
            variant="secondary"
            size="sm"
            aria-label={`${l.removeFilter}: ${f.label}`}
            className="min-w-0 max-w-full whitespace-normal break-words text-left"
            onClick={() => p.onRemoveFilter(f.key)}
          >
            {f.label} ×
          </Button>
        ))}
      </div>
      {p.active.length > 0 && (
        <Button
          variant="outline"
          className="min-w-0 max-w-full whitespace-normal break-words text-left"
          onClick={p.onClearFilters}
        >
          {l.clearFilters}
        </Button>
      )}
    </div>
  );
  const display = (
    <div className="grid min-w-0 gap-3">
      <LayoutSelect
        label={l.layout}
        className="sm:hidden"
        value={p.layout}
        options={(['grid', 'list'] as const).map((value) => ({ value, label: l[value] }))}
        onValueChange={p.onLayoutChange}
      />
      <span className="min-w-0 max-w-full whitespace-normal break-words text-sm">{l.density}</span>
      <ToggleGroup
        aria-label={l.density}
        value={[p.density]}
        onValueChange={(v) => {
          if (v[0]) p.onDensityChange(v[0] as Density);
        }}
        variant="outline"
        className="max-w-full flex-wrap"
      >
        {(['small', 'medium', 'large'] as const).map((v) => (
          <ToggleGroupItem key={v} value={v} className="max-w-full whitespace-normal break-words text-left">
            {l[v]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {p.layout === 'table' && p.columns}
    </div>
  );
  const badge = p.active.length > 0 && <Badge variant="secondary">{p.active.length}</Badge>;
  return (
    <div className="space-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Menu
          title={l.view}
          trigger={
            <Button variant="outline" className="min-w-0 max-w-full whitespace-normal break-words text-left sm:hidden">
              {l.view} {badge}
            </Button>
          }
          content={
            <Tabs defaultValue="sort" className="min-w-0 p-4">
              <TabsList className="h-auto min-h-8 w-full">
                <TabsTrigger value="sort" className="min-w-0 whitespace-normal break-words">
                  {l.sort}
                </TabsTrigger>
                <TabsTrigger value="filter" className="min-w-0 whitespace-normal break-words">
                  {l.filter} {badge}
                </TabsTrigger>
                <TabsTrigger value="display" className="min-w-0 whitespace-normal break-words">
                  {l.display}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="sort" className="min-w-0">
                {sort}
              </TabsContent>
              <TabsContent value="filter" className="min-w-0">
                {filter}
              </TabsContent>
              <TabsContent value="display" className="min-w-0">
                {display}
              </TabsContent>
            </Tabs>
          }
        />
        <div className="hidden min-w-0 items-center gap-2 sm:flex">
          <Menu
            title={l.sort}
            trigger={
              <Button variant="outline" className="min-w-0 max-w-full whitespace-normal break-words text-left">
                {l.sort}
              </Button>
            }
            content={sort}
          />
          <Menu
            title={l.filter}
            trigger={
              <Button variant="outline" className="min-w-0 max-w-full whitespace-normal break-words text-left">
                {l.filter} {badge}
              </Button>
            }
            content={filter}
          />
          <LayoutSelect
            label={l.layout}
            value={p.layout}
            options={(['grid', 'list', 'table'] as const).map((value) => ({
              value,
              label: l[value],
              ...(value === 'table' ? { className: 'hidden md:block' } : {}),
            }))}
            onValueChange={p.onLayoutChange}
          />
          <Menu
            title={l.display}
            trigger={
              <Button variant="outline" className="min-w-0 max-w-full whitespace-normal break-words text-left">
                {l.display}
              </Button>
            }
            content={display}
          />
        </div>
        <Button
          variant="outline"
          className="min-w-0 max-w-full whitespace-normal break-words text-left"
          onClick={p.onSelect}
        >
          {l.select}
        </Button>
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {p.count} {l.items}
        </span>
      </div>
      {p.active.length > 0 && (
        <div className="hidden min-w-0 flex-wrap items-center gap-2 sm:flex">
          {p.active.map((f) => (
            <Button
              key={f.key}
              variant="secondary"
              size="sm"
              aria-label={`${l.removeFilter}: ${f.label}`}
              className="min-w-0 max-w-full whitespace-normal break-words text-left"
              onClick={() => p.onRemoveFilter(f.key)}
            >
              {f.label} ×
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 max-w-full whitespace-normal break-words text-left"
            onClick={p.onClearFilters}
          >
            {l.clearFilters}
          </Button>
        </div>
      )}
    </div>
  );
}
