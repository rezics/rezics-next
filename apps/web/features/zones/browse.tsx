import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import type { ZoneBrowseEntry, ZoneWork } from '@rezics/zone-sdk';
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, InfoIcon, LayoutGridIcon, ListIcon, SearchIcon,
  SearchXIcon, SlidersHorizontalIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { slotRatio } from '../catalogue/work.ts';
import type { BrowseFacetGroup, BrowseModel } from './browse-view.ts';
import type { ZoneMessages } from './messages.ts';
import type { CardRenderer } from './modules.tsx';

// A Zone's browse page, laid out as search-first catalogues are (Modrinth's
// search, a novel site's library): search and sort above the results, the
// Facets beside them, what is chosen as removable chips. Every control is a
// link or a GET form, so each view has its own URL and needs no script.

const field = cn('h-11 w-full min-w-0 rounded-xl border border-border/80 bg-card ps-10 pe-3 text-base',
  'text-foreground shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] outline-none placeholder:text-muted-foreground/70',
  'hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 md:text-sm');

/** The search form: its text goes to the browse page as `q`, keeping the Conditions given. */
export function BrowseSearch({ action, label, placeholder, value, kept, submit, className }: {
  action: string; label: string; placeholder: string; value?: string | null;
  kept?: readonly { name: string; value: string }[]; submit: string; className?: string;
}) {
  return <form action={action} method="get" role="search" aria-label={label}
    className={cn('flex min-w-0 items-center gap-2', className)}>
    <div className="relative min-w-0 flex-1">
      <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2
        text-muted-foreground" />
      <input type="search" name="q" defaultValue={value ?? ''} placeholder={placeholder} aria-label={label}
        maxLength={100} enterKeyHint="search" className={field} />
    </div>
    {kept?.map(item => <input key={`${item.name}=${item.value}`} type="hidden" name={item.name} value={item.value} />)}
    <button type="submit" className={cn(buttonVariants(), 'h-11 shrink-0 max-sm:px-3')}>
      <SearchIcon aria-hidden="true" className="sm:hidden" /><span className="max-sm:sr-only">{submit}</span>
    </button>
  </form>;
}

const chip = cn('inline-flex h-8 items-center gap-1.5 rounded-full border border-border/80 bg-card px-3 text-sm',
  'outline-none transition-colors hover:border-primary/50 hover:text-primary focus-visible:ring-2',
  'focus-visible:ring-ring');

/**
 * What a Zone home leads with: its search, then the values Main measures as
 * one-filter links (status and length), each with how many picks it opens.
 */
export function ZoneBrowseBar({ browse, messages }: { browse: ZoneBrowseEntry; messages: ZoneMessages }) {
  return <section aria-label={browse.searchLabel} data-zone-browse-bar="" className="grid grid-cols-1 gap-3">
    {browse.groups.length ? <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {browse.groups.map(group => <div key={group.facet} className="flex flex-wrap items-center gap-1.5">
        <span className="me-0.5 text-muted-foreground text-xs">{group.label}</span>
        <ul className="contents">
          {group.chips.map(item => <li key={item.value}>
            <LocalizedLink href={item.href} lang={item.label.lang || undefined} className={chip}>
              <span>{item.label.value}</span>
              <span className="text-muted-foreground text-xs tabular-nums">{item.count}</span>
            </LocalizedLink></li>)}
        </ul>
      </div>)}
      <LocalizedLink href={browse.href} className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'px-0')}>
        {messages.browseAll}<ArrowRightIcon aria-hidden="true" className="rtl:rotate-180" /></LocalizedLink>
    </div> : null}
    <BrowseSearch action={browse.href} label={browse.searchLabel} placeholder={browse.placeholder}
      submit={messages.search} kept={browse.kept} />
  </section>;
}

const MANY = 6;

function FacetValues({ group, messages }: { group: BrowseFacetGroup; messages: ZoneMessages }) {
  const item = (value: BrowseFacetGroup['values'][number]) => <li key={value.value} className="flex items-center gap-1">
    <LocalizedLink href={value.href} aria-current={value.chosen ? 'true' : undefined} lang={value.label.lang || undefined}
      className="group/value flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-none
        hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:font-medium">
      <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center rounded border border-border
        group-aria-[current=true]/value:border-primary group-aria-[current=true]/value:bg-primary
        group-aria-[current=true]/value:text-primary-foreground">
        {value.chosen ? <CheckIcon className="size-3" /> : null}</span>
      <span className="min-w-0 flex-1 truncate">
        {value.label.value}{value.chosen ? <span className="sr-only"> ({messages.chosen})</span> : null}</span>
      <span className="text-muted-foreground text-xs tabular-nums">{value.count}</span>
    </LocalizedLink>
    {value.excludeHref ? <LocalizedLink href={value.excludeHref} aria-current={value.excluded ? 'true' : undefined}
      aria-label={`${value.excluded ? messages.excluded : messages.exclude}: ${value.label.value}`}
      className="shrink-0 rounded-lg px-2 py-1 text-muted-foreground text-xs outline-none hover:text-primary
        focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:font-semibold aria-[current=true]:text-primary">
      {value.excluded ? messages.excluded : messages.exclude}</LocalizedLink> : null}</li>;
  const shown = group.values.filter((value, index) => index < MANY || value.chosen);
  const rest = group.values.filter(value => !shown.includes(value));
  return <>
    <ul className="grid grid-cols-1">{shown.map(item)}</ul>
    {rest.length ? <details className="group/more">
      <summary className="cursor-pointer list-none rounded-lg px-2 py-1.5 text-primary text-sm outline-none
        hover:underline focus-visible:ring-2 focus-visible:ring-ring group-open/more:hidden">
        {messages.showAllValues}</summary>
      <ul className="grid grid-cols-1">{rest.map(item)}</ul>
    </details> : null}
  </>;
}

function Facets({ groups, messages, idPrefix, className }: { groups: readonly BrowseFacetGroup[];
  messages: ZoneMessages; idPrefix: string; className?: string }) {
  return <div className={cn('grid grid-cols-1 gap-5', className)}>
    {groups.map(group => <section key={group.facet} aria-labelledby={`${idPrefix}-${group.facet}`}
      className="grid grid-cols-1 gap-1">
      <h3 id={`${idPrefix}-${group.facet}`} className="px-2 font-semibold text-sm">{group.label}</h3>
      <FacetValues group={group} messages={messages} />
    </section>)}
  </div>;
}

function Segmented({ label, items }: { label: string;
  items: readonly { key: string; label: ReactNode; href: string; current: boolean; title?: string }[] }) {
  return <nav aria-label={label} className="inline-flex items-center gap-0.5 rounded-xl border border-border/80 bg-card
    p-0.5">
    {items.map(item => <LocalizedLink key={item.key} href={item.href} aria-current={item.current ? 'true' : undefined}
      title={item.title}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-muted-foreground text-sm outline-none
        transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring
        aria-[current=true]:bg-accent aria-[current=true]:font-medium aria-[current=true]:text-accent-foreground">
      {item.label}</LocalizedLink>)}
  </nav>;
}

/** The browse page of a Zone: search, sort and view above the results, Facets beside them. */
export function ZoneBrowse({ model, card, messages }: {
  model: BrowseModel; card: CardRenderer; messages: ZoneMessages;
}) {
  const chosen = model.chosen.length;
  const slot = slotRatio(model.items);
  const list = (items: readonly ZoneWork[]) => model.state.view === 'grid'
    ? <ul className="grid grid-cols-2 gap-x-(--zone-shelf-gap) gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
      {items.map(work => <li key={work.id} className="min-w-0">{card(work, { layout: 'cover', slot })}</li>)}</ul>
    : <ul className="grid grid-cols-1 divide-y divide-border/60 rounded-(--zone-radius-card) border border-border/60
      bg-card">
      {items.map(work => <li key={work.id} className="min-w-0 p-3 sm:p-4">{card(work, { layout: 'row' })}</li>)}</ul>;
  return <PageContainer className="grid grid-cols-1 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
    <aside aria-labelledby="browse-filters" className="hidden lg:sticky lg:top-32 lg:block">
      <h2 id="browse-filters" className="sr-only">{messages.filters}</h2>
      <Facets groups={model.groups} messages={messages} idPrefix="facet" />
    </aside>
    <section aria-labelledby="browse-title" className="grid min-w-0 grid-cols-1 gap-4">
      <h2 id="browse-title" className="sr-only">{model.title}</h2>
      <BrowseSearch action={model.action} label={model.searchLabel} placeholder={model.placeholder}
        value={model.state.text} kept={model.kept} submit={messages.search} />
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="me-auto font-medium text-sm">{model.results}</p>
        <Segmented label={messages.sortLabel} items={model.sorts.map(item => ({ key: item.sort, label: item.label,
          href: item.href, current: item.current }))} />
        <Segmented label={messages.viewLabel} items={model.views.map(item => ({ key: item.view, href: item.href,
          current: item.current, title: item.label, label: <>
            {item.view === 'list' ? <ListIcon aria-hidden="true" className="size-4" />
              : <LayoutGridIcon aria-hidden="true" className="size-4" />}
            <span className="sr-only">{item.label}</span></> }))} />
      </div>
      {model.groups.length ? <details className="rounded-xl border border-border/80 bg-card lg:hidden">
        <summary className="flex h-11 cursor-pointer items-center gap-2 px-4 font-medium text-sm outline-none
          focus-visible:ring-2 focus-visible:ring-ring">
          <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
          {model.filtersLabel}</summary>
        <div className="border-border/60 border-t p-2"><Facets groups={model.groups} messages={messages}
          idPrefix="facet-phone" /></div>
      </details> : null}
      {chosen ? <ul aria-label={messages.filters} className="flex flex-wrap items-center gap-1.5">
        {model.chosen.map(item => <li key={item.key}>
          <LocalizedLink href={item.href} aria-label={item.remove}
            className={cn(chip, 'h-7 bg-accent text-accent-foreground')}>
            {item.label}<XIcon aria-hidden="true" className="size-3.5" /></LocalizedLink></li>)}
        {model.clearHref ? <li><LocalizedLink href={model.clearHref} className={cn(buttonVariants({ variant: 'link',
          size: 'sm' }), 'h-7 px-1')}>{messages.clearAll}</LocalizedLink></li> : null}
      </ul> : null}
      {model.notes.map(note => <p key={note} className="flex items-start gap-2 text-muted-foreground text-sm">
        <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{note}</p>)}
      {model.items.length ? list(model.items) : <EmptyState icon={SearchXIcon} title={messages.browseEmptyTitle}
        description={messages.browseEmptyBody} headingLevel={3}>
        {model.clearHref ? <LocalizedLink href={model.clearHref} className={buttonVariants({ variant: 'outline' })}>
          {messages.clearAll}</LocalizedLink> : null}
      </EmptyState>}
      {model.next || model.first ? <nav className="flex flex-wrap justify-center gap-2">
        {model.first ? <LocalizedLink href={model.first} className={buttonVariants({ variant: 'ghost' })}>
          <ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />{messages.previous}</LocalizedLink> : null}
        {model.next ? <LocalizedLink href={model.next} className={buttonVariants({ variant: 'outline' })}>
          {messages.next}<ArrowRightIcon aria-hidden="true" className="rtl:rotate-180" /></LocalizedLink> : null}
      </nav> : null}
    </section>
  </PageContainer>;
}
