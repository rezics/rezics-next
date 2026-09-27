'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
  SheetTrigger } from '@rezics/ui/sheet';
import { cn } from '@rezics/ui/utils';
import { ClockIcon, FlameIcon, SlidersHorizontalIcon, TrophyIcon } from 'lucide-react';
import Link from 'next/link';
import { materializeData } from 'native-i18n';
import { type ReactNode, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { FeedMessages } from './messages.ts';
import { activeFilterCount, contentLanguages, type FeedDefaults, feedSearch, type FeedSort, type FeedState,
  type InterestKind, interestKinds, kindAvailable, topWindows, withChange } from './state.ts';

type T = ReturnType<typeof materializeData<FeedMessages>>;

export interface RealmChoice { id: string; name: string; language: string }

const segment = 'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 font-medium text-sm '
  + 'text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground '
  + 'focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-foreground '
  + 'aria-[current=page]:text-background';

const sortIcons: Record<FeedSort, typeof FlameIcon> = { best: FlameIcon, new: ClockIcon, top: TrophyIcon };

function kindLabel(kind: InterestKind, t: T): string {
  return t[kind];
}

/**
 * The feed's controls, one tap each and always visible (Reddit hid its sort in
 * 2022 and people read it as removed): Following or All, Best, New or Top with
 * its period, the kind chips and the Filters sheet. Every choice is a link to
 * its own URL; filters survive tab and sort changes.
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
  // One explicit shrinkable column: the kind chips scroll inside it, where an implicit auto column would take their
  // full width and push the page wider than a phone.
  return <div className="grid grid-cols-[minmax(0,1fr)] gap-3 border-border/60 border-b px-3 pt-1 pb-3 sm:px-4">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {signedIn ? <nav aria-label={t.views} className="flex rounded-full bg-muted/70 p-1">
        {(['following', 'all'] as const).map(tab => <Link key={tab} href={href({ tab })}
          aria-current={state.tab === tab ? 'page' : undefined} className={cn(segment, 'h-8')}>
          {tab === 'following' ? t.following : t.all}</Link>)}
      </nav> : null}
      <nav aria-label={t.sortLabel} className="flex items-center gap-1">
        {sorts.map(sort => {
          const Icon = sortIcons[sort];
          return <Link key={sort} href={href({ sort })} title={sortHelp[sort]}
            aria-current={state.sort === sort ? 'page' : undefined} className={segment}>
            <Icon aria-hidden="true" className="size-4" />{t[sort]}</Link>;
        })}
      </nav>
    </div>
    {state.sort === 'top' ? <nav aria-label={t.period} className="flex flex-wrap items-center gap-1">
      {topWindows.map(window => <Link key={window} href={href({ window })}
        aria-current={state.window === window ? 'page' : undefined} className={cn(segment, 'h-8 px-3 text-xs')}>
        {window === 'week' ? t.week : window === 'month' ? t.month : t.allTime}</Link>)}
    </nav> : null}
    <div className="flex items-center gap-2">
      <nav aria-label={t.kinds} className="-ms-3 min-w-0 flex-1 overflow-x-auto ps-3 [scrollbar-width:none] sm:-ms-4
        sm:ps-4">
        <ul className="flex w-max gap-2">
          <li><Link href={href({ kind: null })} aria-current={state.kind === null ? 'page' : undefined}
            className={chip}>{t.everything}</Link></li>
          {interestKinds.filter(kindAvailable).map(kind => <li key={kind}>
            <Link href={href({ kind })} aria-current={state.kind === kind ? 'page' : undefined} className={chip}>
              {kindLabel(kind, t)}</Link>
          </li>)}
        </ul>
      </nav>
      <FiltersSheet state={state} defaults={defaults} locale={locale} t={t} realms={realms} />
    </div>
  </div>;
}

const chip = 'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/70 px-3 '
  + 'font-medium text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring '
  + 'aria-[current=page]:border-transparent aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground';

function Choice({ name, value, checked, lang, children }: { name: string; value: string; checked: boolean;
  lang?: string; children: ReactNode }) {
  return <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-xl px-2 hover:bg-accent/60">
    <input type="checkbox" name={name} value={value} defaultChecked={checked}
      className="size-4 shrink-0 accent-primary" />
    <span lang={lang} className="min-w-0 truncate text-sm">{children}</span>
  </label>;
}

/** Languages and Realms: a form that loads the same feed with the chosen filters. */
function FiltersSheet({ state, defaults, locale, t, realms }: { state: FeedState; defaults: FeedDefaults;
  locale: UiLocale; t: T; realms: readonly RealmChoice[] }) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(state);
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  // Everything but the filters, carried through the form as it is in the URL.
  const kept = new URLSearchParams(feedSearch({ ...state, languages: [], realms: [] }, defaults).slice(1));
  const clearHref = localizedPath(`/${feedSearch({ ...state, languages: [], realms: [] }, defaults)}`, locale);
  return <Sheet open={open} onOpenChange={details => setOpen(details.open)}>
    <SheetTrigger className={cn(buttonVariants({ variant: count ? 'soft' : 'ghost', size: 'sm' }), 'shrink-0 rounded-full')}>
      <SlidersHorizontalIcon aria-hidden="true" />{t.filters}
      {count ? <><span aria-hidden="true" className="grid min-w-5 place-items-center rounded-full bg-primary px-1
        text-[11px] text-primary-foreground">{count}</span><span className="sr-only">, {t.filtersOn(count)}</span></> : null}
    </SheetTrigger>
    <SheetContent placement="right" className="w-full max-w-sm">
      <form method="get" action={localizedPath('/', locale)} className="flex min-h-0 flex-1 flex-col"
        onSubmit={() => setOpen(false)}>
        <SheetHeader>
          <SheetTitle>{t.filtersTitle}</SheetTitle>
          <SheetDescription>{t.filtersDescription}</SheetDescription>
        </SheetHeader>
        <SheetBody className="grid content-start gap-6">
          {[...kept].map(([name, value]) => <input key={`${name}=${value}`} type="hidden" name={name} value={value} />)}
          <fieldset className="grid gap-1">
            <legend className="mb-2 font-semibold text-sm">{t.languages}</legend>
            {contentLanguages.map(language => <Choice key={language} name="lang" value={language}
              checked={state.languages.includes(language)}>{names.of(language) ?? language}</Choice>)}
          </fieldset>
          <fieldset className="grid gap-1">
            <legend className="mb-2 font-semibold text-sm">{t.realms}</legend>
            {realms.length ? realms.map(realm => <Choice key={realm.id} name="realm" value={realm.id}
              checked={state.realms.includes(realm.id)} lang={realm.language}>{realm.name}</Choice>)
              : <p className="text-muted-foreground text-sm">{t.noRealmsToFilter}</p>}
          </fieldset>
        </SheetBody>
        <SheetFooter className="flex-row justify-end gap-2">
          {count ? <Link href={clearHref} onClick={() => setOpen(false)}
            className={buttonVariants({ variant: 'ghost' })}>{t.clearFilters}</Link> : null}
          <Button type="submit">{t.showPosts}</Button>
        </SheetFooter>
      </form>
    </SheetContent>
  </Sheet>;
}
