'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@rezics/ui/menu';
import { Popover, PopoverContent, PopoverTrigger } from '@rezics/ui/popover';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@rezics/ui/sheet';
import { cn } from '@rezics/ui/utils';
import { ChevronDownIcon, ClockIcon, FlameIcon, SlidersHorizontalIcon, TrophyIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { materializeData } from 'native-i18n';
import { type ReactNode, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { FeedMessages } from './messages.ts';
import { activeFilterCount, contentLanguages, type FeedDefaults, feedSearch, type FeedSort, type FeedState,
  topWindows, withChange } from './state.ts';

type T = ReturnType<typeof materializeData<FeedMessages>>;

export interface RealmChoice { id: string; name: string; language: string }

const sortIcons: Record<FeedSort, typeof FlameIcon> = { best: FlameIcon, new: ClockIcon, top: TrophyIcon };

/** A menu's trigger in the control line: its current choice and a caret, as Reddit's `Best ▾`. */
export const lineTrigger = cn(buttonVariants({ variant: 'ghost', size: 'sm', pill: true }),
  'h-8 gap-1 px-2.5 font-semibold text-foreground');

/**
 * A choice among links, as a styled menu: each item goes to its own address,
 * so the page stays linkable and the server renders it.
 */
export function LinkMenu<V extends string>({ label, value, options, icon, className }: {
  label: string; value: V; icon?: ReactNode; className?: string;
  options: readonly { value: V; label: string; help?: string; href: string }[];
}) {
  const router = useRouter();
  const current = options.find(option => option.value === value);
  return <Menu onSelect={({ value: next }) => {
    const option = options.find(candidate => candidate.value === next);
    if (option && option.value !== value) router.push(option.href);
  }}>
    <MenuTrigger aria-label={`${label}: ${current?.label ?? ''}`} className={cn(lineTrigger, className)}>
      {icon}{current?.label}<ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground" />
    </MenuTrigger>
    <MenuContent className="w-60">
      <MenuRadioGroup value={value}>
        {options.map(option => <MenuRadioItem key={option.value} value={option.value}>
          <span className="grid gap-0.5"><span className="font-medium">{option.label}</span>
            {option.help ? <span className="text-muted-foreground text-xs">{option.help}</span> : null}</span>
        </MenuRadioItem>)}
      </MenuRadioGroup>
    </MenuContent>
  </Menu>;
}

/**
 * Home's controls, as Reddit and X keep them: the tabs (Following and All;
 * pinned Saved Filters take their place after these once readers can pin
 * them), then one compact line with the sort menu, Top's period, and the
 * Filters with each active filter as a removable chip. Home has one view of
 * posts, so there is no card/compact switch. Every choice has its own
 * address; filters survive tab and sort changes.
 */
export function FeedControls({ state, defaults, signedIn, locale, messages, realms }: {
  state: FeedState; defaults: FeedDefaults; signedIn: boolean; locale: UiLocale; messages: FeedMessages;
  /** Realms the reader can narrow to: those they follow. */
  realms: readonly RealmChoice[];
}) {
  const t = materializeData(messages, { locale });
  const href = (change: Partial<FeedState>) => localizedPath(`/${feedSearch(withChange(state, change), defaults)}`, locale);
  const sorts: FeedSort[] = state.tab === 'following' ? ['best', 'new'] : ['best', 'new', 'top'];
  const sortHelp = { best: t.bestHelp, new: t.newHelp, top: t.topHelp };
  const SortIcon = sortIcons[state.sort];
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  const chips = [
    ...state.languages.map(language => ({ key: `lang:${language}`, label: names.of(language) ?? language,
      href: href({ languages: state.languages.filter(item => item !== language) }) })),
    ...state.realms.map(realm => ({ key: `realm:${realm}`, label: realms.find(item => item.id === realm)?.name ?? t.realms,
      href: href({ realms: state.realms.filter(item => item !== realm) }) })),
    // A kind from an older address still narrows the feed; it shows here so it can be removed.
    ...state.kind ? [{ key: `kind:${state.kind}`, label: t[state.kind], href: href({ kind: null }) }] : [],
  ];
  return <div className="grid grid-cols-[minmax(0,1fr)] border-border/60 border-b">
    {signedIn ? <nav aria-label={t.views} className="flex border-border/60 border-b">
      {(['following', 'all'] as const).map(tab => <Link key={tab} href={href({ tab })}
        aria-current={state.tab === tab ? 'page' : undefined} className="relative grid h-12 min-w-24 flex-1
          place-items-center px-4 font-medium text-muted-foreground text-sm outline-none transition-colors
          hover:bg-foreground/[0.03] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset
          aria-[current=page]:font-semibold aria-[current=page]:text-foreground sm:flex-none sm:px-6
          aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-4 aria-[current=page]:after:bottom-0
          aria-[current=page]:after:h-1 aria-[current=page]:after:rounded-full aria-[current=page]:after:bg-primary">
        {tab === 'following' ? t.following : t.all}</Link>)}
    </nav> : null}
    <div className="flex min-h-12 items-center gap-1 px-2 py-1.5 sm:px-3">
      <LinkMenu label={t.sortLabel} value={state.sort} icon={<SortIcon aria-hidden="true" className="size-4" />}
        options={sorts.map(sort => ({ value: sort, label: t[sort], help: sortHelp[sort], href: href({ sort }) }))} />
      {state.sort === 'top' ? <LinkMenu label={t.period} value={state.window} options={topWindows.map(window =>
        ({ value: window, label: window === 'week' ? t.week : window === 'month' ? t.month : t.allTime,
          href: href({ window }) }))} /> : null}
      <Filters state={state} defaults={defaults} locale={locale} t={t} realms={realms} />
      {chips.length ? <ul aria-label={t.activeFilters} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto
        [scrollbar-width:none]">
        {chips.map(chip => <li key={chip.key} className="shrink-0">
          <Link href={chip.href} aria-label={t.removeFilter({ filter: chip.label })} className="inline-flex h-7 items-center
            gap-1 rounded-full bg-primary/10 ps-2.5 pe-1.5 font-medium text-primary text-xs outline-none
            transition-colors hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring">
            {chip.label}<XIcon aria-hidden="true" className="size-3.5" /></Link>
        </li>)}
      </ul> : null}
    </div>
  </div>;
}

function Choice({ name, value, checked, lang, children }: { name: string; value: string; checked: boolean;
  lang?: string; children: ReactNode }) {
  return <label className="flex min-h-9 cursor-pointer items-center gap-3 rounded-xl px-2 hover:bg-accent/60">
    <input type="checkbox" name={name} value={value} defaultChecked={checked}
      className="size-4 shrink-0 accent-primary" />
    <span lang={lang} className="min-w-0 truncate text-sm">{children}</span>
  </label>;
}

/**
 * Languages and Realms: a form that loads the same feed with the chosen
 * filters, in a popover beside the line and a sheet on phones.
 */
function Filters({ state, defaults, locale, t, realms }: { state: FeedState; defaults: FeedDefaults;
  locale: UiLocale; t: T; realms: readonly RealmChoice[] }) {
  const [open, setOpen] = useState<'popover' | 'sheet' | null>(null);
  const count = activeFilterCount(state);
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  // Everything but the filters, carried through the form as it is in the URL.
  const kept = new URLSearchParams(feedSearch({ ...state, languages: [], realms: [] }, defaults).slice(1));
  const clearHref = localizedPath(`/${feedSearch({ ...state, languages: [], realms: [] }, defaults)}`, locale);
  const form = (footer: 'popover' | 'sheet') => <form method="get" action={localizedPath('/', locale)}
    className="flex min-h-0 flex-1 flex-col" onSubmit={() => setOpen(null)}>
    {[...kept].map(([name, value]) => <input key={`${name}=${value}`} type="hidden" name={name} value={value} />)}
    <div className={cn('grid content-start gap-5', footer === 'popover' ? 'max-h-[60vh] overflow-y-auto p-4' : '')}>
      <fieldset className="grid gap-0.5">
        <legend className="mb-1.5 font-semibold text-sm">{t.languages}</legend>
        {contentLanguages.map(language => <Choice key={language} name="lang" value={language}
          checked={state.languages.includes(language)}>{names.of(language) ?? language}</Choice>)}
      </fieldset>
      <fieldset className="grid gap-0.5">
        <legend className="mb-1.5 font-semibold text-sm">{t.realms}</legend>
        {realms.length ? realms.map(realm => <Choice key={realm.id} name="realm" value={realm.id}
          checked={state.realms.includes(realm.id)} lang={realm.language}>{realm.name}</Choice>)
          : <p className="text-muted-foreground text-sm">{t.noRealmsToFilter}</p>}
      </fieldset>
    </div>
    <div className={cn('flex justify-end gap-2', footer === 'popover' && 'border-border/60 border-t p-3')}>
      {count ? <Link href={clearHref} onClick={() => setOpen(null)}
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{t.clearFilters}</Link> : null}
      <Button type="submit" size="sm">{t.showPosts}</Button>
    </div>
  </form>;
  const trigger = cn(lineTrigger, 'font-medium', count && 'text-primary');
  const label = <><SlidersHorizontalIcon aria-hidden="true" className="size-4" /><span className="max-sm:sr-only">
    {t.filters}</span>{count ? <><span aria-hidden="true" className="grid min-w-5 place-items-center rounded-full
      bg-primary px-1 text-[11px] text-primary-foreground">{count}</span>
    <span className="sr-only">, {t.filtersOn(count)}</span></> : null}</>;
  return <>
    {/* One trigger: a popover beside the line where there is room, a sheet on phones. */}
    <Popover open={open === 'popover'} onOpenChange={details => setOpen(details.open ? 'popover' : null)}
      positioning={{ placement: 'bottom-start' }}>
      <PopoverTrigger className={trigger} onClick={event => {
        if (window.matchMedia('(min-width: 640px)').matches) return;
        event.preventDefault();
        setOpen('sheet');
      }}>{label}</PopoverTrigger>
      <PopoverContent className="w-80 p-0" aria-label={t.filtersTitle}>
        <p className="border-border/60 border-b px-4 py-3 text-muted-foreground text-xs">{t.filtersDescription}</p>
        {form('popover')}
      </PopoverContent>
    </Popover>
    <Sheet open={open === 'sheet'} onOpenChange={details => setOpen(details.open ? 'sheet' : null)}>
      <SheetContent placement="bottom" className="max-h-[85vh]">
        <SheetHeader>
          <SheetTitle>{t.filtersTitle}</SheetTitle>
          <SheetDescription>{t.filtersDescription}</SheetDescription>
        </SheetHeader>
        <SheetBody className="flex">{form('sheet')}</SheetBody>
        <SheetFooter className="hidden" />
      </SheetContent>
    </Sheet>
  </>;
}
