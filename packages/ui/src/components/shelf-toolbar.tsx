import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '../shadcn/button.tsx';
import { ToggleGroup, ToggleGroupItem } from '../shadcn/toggle-group.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../shadcn/tabs.tsx';
import { Badge } from '../shadcn/badge.tsx';
import { Menu } from './menu.tsx';

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
          onClick={() => onValueChange(tab.value)}
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
  const sort = (
    <div className="grid gap-3">
      <label className="grid gap-1 text-sm">
        {l.sort}
        <select
          className="rounded-md border bg-background p-2"
          value={p.sort}
          onChange={(e) => p.onSortChange(e.target.value, p.direction)}
        >
          {p.sorts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        {l.direction}
        <select
          className="rounded-md border bg-background p-2"
          value={p.direction}
          onChange={(e) => p.onSortChange(p.sort, e.target.value as 'asc' | 'desc')}
        >
          <option value="asc">{l.ascending}</option>
          <option value="desc">{l.descending}</option>
        </select>
      </label>
    </div>
  );
  const filter = (
    <div className="grid gap-3">
      {p.filters}
      <div className="flex flex-wrap gap-2">
        {p.active.map((f) => (
          <Button
            key={f.key}
            variant="secondary"
            size="sm"
            aria-label={`${l.removeFilter}: ${f.label}`}
            onClick={() => p.onRemoveFilter(f.key)}
          >
            {f.label} ×
          </Button>
        ))}
      </div>
      {p.active.length > 0 && (
        <Button variant="outline" onClick={p.onClearFilters}>
          {l.clearFilters}
        </Button>
      )}
    </div>
  );
  const display = (
    <div className="grid gap-3">
      <div className="sm:hidden">
        <ToggleGroup
          aria-label={l.layout}
          value={[p.layout]}
          onValueChange={(v) => {
            if (v[0]) p.onLayoutChange(v[0] as Layout);
          }}
          variant="outline"
        >
          {(['grid', 'list'] as const).map((v) => (
            <ToggleGroupItem key={v} value={v}>
              {l[v]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <span className="text-sm">{l.density}</span>
      <ToggleGroup
        aria-label={l.density}
        value={[p.density]}
        onValueChange={(v) => {
          if (v[0]) p.onDensityChange(v[0] as Density);
        }}
        variant="outline"
      >
        {(['small', 'medium', 'large'] as const).map((v) => (
          <ToggleGroupItem key={v} value={v}>
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
            <Button variant="outline" className="sm:hidden">
              {l.view} {badge}
            </Button>
          }
          content={
            <Tabs defaultValue="sort" className="p-4">
              <TabsList>
                <TabsTrigger value="sort">{l.sort}</TabsTrigger>
                <TabsTrigger value="filter">
                  {l.filter} {badge}
                </TabsTrigger>
                <TabsTrigger value="display">{l.display}</TabsTrigger>
              </TabsList>
              <TabsContent value="sort">{sort}</TabsContent>
              <TabsContent value="filter">{filter}</TabsContent>
              <TabsContent value="display">{display}</TabsContent>
            </Tabs>
          }
        />
        <div className="hidden items-center gap-2 sm:flex">
          <Menu title={l.sort} trigger={<Button variant="outline">{l.sort}</Button>} content={sort} />
          <Menu
            title={l.filter}
            trigger={
              <Button variant="outline">
                {l.filter} {badge}
              </Button>
            }
            content={filter}
          />
          <ToggleGroup
            aria-label={l.layout}
            value={[p.layout]}
            onValueChange={(v) => {
              if (v[0]) p.onLayoutChange(v[0] as Layout);
            }}
            variant="outline"
            spacing={0}
          >
            {(['grid', 'list', 'table'] as const).map((v) => (
              <ToggleGroupItem key={v} value={v} className={v === 'table' ? 'hidden md:inline-flex' : undefined}>
                {l[v]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Menu title={l.display} trigger={<Button variant="outline">{l.display}</Button>} content={display} />
        </div>
        <Button variant="outline" onClick={p.onSelect}>
          {l.select}
        </Button>
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {p.count} {l.items}
        </span>
      </div>
      {p.active.length > 0 && (
        <div className="hidden flex-wrap items-center gap-2 sm:flex">
          {p.active.map((f) => (
            <Button
              key={f.key}
              variant="secondary"
              size="sm"
              aria-label={`${l.removeFilter}: ${f.label}`}
              onClick={() => p.onRemoveFilter(f.key)}
            >
              {f.label} ×
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={p.onClearFilters}>
            {l.clearFilters}
          </Button>
        </div>
      )}
    </div>
  );
}
