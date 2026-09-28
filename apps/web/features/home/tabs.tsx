'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { ArrowLeftIcon, ArrowRightIcon, EllipsisIcon, PencilIcon, PinOffIcon, Trash2Icon, UserMinusIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { tabLink } from '../feed/controls.tsx';
import type { FeedMessages } from '../feed/messages.ts';
import { type FeedDefaults, feedSearch, type FeedState, pinnedTab, withChange } from '../feed/state.ts';
import { mainSavedFilterApi, type SavedFilterApi } from '../saved-filter/api.ts';
import { droppedOn, filterTitle, moved } from '../saved-filter/tabs.ts';
import type { CommandResult, SavedFilter, SavedFilters } from '../saved-filter/types.ts';
import type { HomeMessages } from './messages.ts';

type T = ReturnType<typeof materializeData<HomeMessages>>;

export interface HomeTabsProps {
  state: FeedState;
  defaults: FeedDefaults;
  locale: UiLocale;
  messages: { home: HomeMessages; feed: FeedMessages };
  actingSubject: string;
  /** The reader's filters; null when Main could not read them, so only Following and All show. */
  filters: SavedFilters | null;
  /** The `+` picker, drawn after the tabs. */
  picker?: ReactNode;
  /** Stories: an in-memory Main. */
  api?: SavedFilterApi;
}

/**
 * Home's tabs, as X pins topic timelines: Following, All, then the Saved
 * Filters the reader pinned, and `+`. They scroll sideways on phones; on
 * desktop a pinned tab is dragged to a new place, and every tab's menu moves,
 * renames or removes it with the keyboard too. Each tab has its own address.
 */
export function HomeTabs({ state, defaults, locale, messages, actingSubject, filters, picker, api: given }: HomeTabsProps) {
  const t = materializeData(messages.home, { locale });
  const feed = materializeData(messages.feed, { locale });
  const router = useRouter();
  const api = useRef<SavedFilterApi | null>(given ?? null);
  const client = () => api.current ??= mainSavedFilterApi(actingSubject);
  const server = filters?.pinned.map(filter => filter.id) ?? [];
  // The order shown: the server's, or a reorder waiting for Main's answer.
  const [order, setOrder] = useState<string[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SavedFilter | null>(null);
  const strip = useRef<HTMLUListElement>(null);
  const shown = (order ?? server).flatMap(id => filters?.pinned.find(filter => filter.id === id) ?? []);
  const href = (next: FeedState) => localizedPath(`/${feedSearch(next, defaults)}`, locale);
  const serverKey = server.join();

  // Main's list is the truth once it answers.
  useEffect(() => setOrder(null), [serverKey]);
  // The current tab, with its menu, stays in view on a narrow strip (the page itself never scrolls for
  // it), and tabs past either edge fade out there, so a strip that scrolls says so.
  useEffect(() => {
    const list = strip.current;
    if (!list) return;
    const mark = () => {
      // Right-to-left strips scroll to negative offsets; the distance from the start is the same.
      const from = Math.abs(list.scrollLeft);
      list.toggleAttribute('data-before', from > 1);
      list.toggleAttribute('data-after', from + list.clientWidth < list.scrollWidth - 1);
    };
    const tab = list.querySelector('[aria-current="page"]')?.closest('li');
    if (tab) {
      const end = tab.offsetLeft + tab.offsetWidth;
      if (tab.offsetLeft < list.scrollLeft) list.scrollLeft = tab.offsetLeft;
      else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth;
    }
    mark();
    const resized = new ResizeObserver(mark);
    resized.observe(list);
    list.addEventListener('scroll', mark, { passive: true });
    return () => { resized.disconnect(); list.removeEventListener('scroll', mark); };
  }, [state.tab, state.filter, shown.length]);

  async function settle<R>(result: Promise<CommandResult<R>>, after?: () => void) {
    const done = await result;
    if (done.ok) { setStatus(null); after?.(); router.refresh(); return true; }
    setOrder(null);
    setStatus(done.failure === 'stale' ? t.tabsChanged : t.tabsFailed);
    if (done.failure === 'stale') router.refresh();
    return false;
  }

  function reorder(next: string[]) {
    if (!filters?.revision || next.join() === (order ?? server).join()) return;
    setOrder(next);
    void settle(client().reorder(next, filters.revision));
  }

  /** Leaves a tab that is going away for All, which always exists. */
  const leave = (filter: SavedFilter) => () => {
    if (state.tab === 'pinned' && state.filter === filter.id) router.push(href(withChange(state, { tab: 'all' })));
  };

  function remove(filter: SavedFilter, action: 'unpin' | 'unfollow' | 'delete') {
    void settle(action === 'unpin' ? client().update(filter, { pinned: false })
      : action === 'unfollow' ? client().followConcept(filter.concept!.id, false) : client().remove(filter), leave(filter));
  }

  return <><nav aria-label={feed.views} className="flex min-w-0 items-stretch border-border/60 border-b">
    <ul ref={strip} className="relative flex min-w-0 flex-1 snap-x overflow-x-auto [scrollbar-width:none]
      [&::-webkit-scrollbar]:hidden data-after:[mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)]
      data-before:[mask-image:linear-gradient(to_left,black_calc(100%-3rem),transparent)]
      data-before:data-after:[mask-image:linear-gradient(to_right,transparent,black_3rem,black_calc(100%-3rem),transparent)]
      rtl:data-after:[mask-image:linear-gradient(to_left,black_calc(100%-3rem),transparent)]
      rtl:data-before:[mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)]">
      {(['following', 'all'] as const).map(tab => <li key={tab} className="flex shrink-0 snap-start">
        <Link href={href(withChange(state, { tab }))} aria-current={state.tab === tab ? 'page' : undefined}
          className={tabLink}>{tab === 'following' ? feed.following : feed.all}</Link>
      </li>)}
      {shown.map((filter, index) => {
        const title = filterTitle(filter);
        const name = title?.value ?? t.untitledTab;
        const current = state.tab === 'pinned' && state.filter === filter.id;
        return <li key={filter.id} draggable={shown.length > 1} data-dragging={dragging === filter.id || undefined}
          className="group/tab relative flex shrink-0 snap-start items-stretch data-dragging:opacity-50"
          onDragStart={event => { event.dataTransfer.setData('text/plain', filter.id); setDragging(filter.id); }}
          onDragEnd={() => setDragging(null)}
          onDragOver={event => { if (dragging && dragging !== filter.id) event.preventDefault(); }}
          onDrop={event => {
            event.preventDefault();
            if (dragging) reorder(droppedOn(order ?? server, dragging, filter.id));
            setDragging(null);
          }}>
          <Link href={href(pinnedTab(state, filter.id))} aria-current={current ? 'page' : undefined}
            lang={title?.language} draggable={false}
            className={cn(tabLink, 'max-w-56 sm:pe-10', current && 'pe-9')}>
            <span className="truncate">{name}</span></Link>
          <TabMenu t={t} name={name} filter={filter} first={index === 0} last={index === shown.length - 1}
            visible={current} onSelect={action => {
              if (action === 'rename') setRenaming(filter);
              else if (action === 'left' || action === 'right') {
                reorder(moved(order ?? server, filter.id, action === 'left' ? -1 : 1));
              } else remove(filter, action);
            }} />
        </li>;
      })}
    </ul>
    {picker}
  </nav>
  {status ? <p role="status" className="border-border/60 border-b bg-warning/10 px-4 py-2 text-sm
    text-warning-foreground">{status}</p> : null}
  {renaming ? <RenameDialog t={t} filter={renaming} onClose={() => setRenaming(null)}
    onSave={name => settle(client().update(renaming, { name }), () => setRenaming(null))} /> : null}
  </>;
}

type TabAction = 'rename' | 'left' | 'right' | 'unpin' | 'unfollow' | 'delete';

/** A pinned tab's own menu: shown on the current tab, and on hover or focus for the others. */
function TabMenu({ t, name, filter, first, last, visible, onSelect }: { t: T; name: string; filter: SavedFilter;
  first: boolean; last: boolean; visible: boolean; onSelect: (action: TabAction) => void }) {
  return <Menu onSelect={({ value }) => onSelect(value as TabAction)} positioning={{ placement: 'bottom-end' }}>
    <MenuTrigger aria-label={t.tabOptions({ tab: name })} className={cn('absolute end-1.5 top-1/2 grid size-7',
      '-translate-y-1/2 place-items-center rounded-full text-muted-foreground outline-none transition-opacity',
      'hover:bg-foreground/[0.06] hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2',
      'focus-visible:ring-ring data-[state=open]:opacity-100 sm:end-2',
      // Phones show only the current tab's menu; wider screens show the others on hover or touch.
      visible ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100 max-sm:hidden sm:pointer-coarse:opacity-100')}>
      <EllipsisIcon aria-hidden="true" className="size-4" />
    </MenuTrigger>
    <MenuContent className="w-60">
      <MenuItem value="rename"><PencilIcon aria-hidden="true" />{t.renameTab}</MenuItem>
      {first ? null : <MenuItem value="left"><ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />
        {t.moveLeft}</MenuItem>}
      {last ? null : <MenuItem value="right"><ArrowRightIcon aria-hidden="true" className="rtl:rotate-180" />
        {t.moveRight}</MenuItem>}
      <MenuSeparator />
      <MenuItem value="unpin"><PinOffIcon aria-hidden="true" />{t.unpinTab}</MenuItem>
      {filter.concept ? <MenuItem value="unfollow" variant="destructive"><UserMinusIcon aria-hidden="true" />
        {t.unfollowTopic({ topic: filter.concept.name?.value ?? name })}</MenuItem>
        : <MenuItem value="delete" variant="destructive"><Trash2Icon aria-hidden="true" />{t.deleteFilter}</MenuItem>}
    </MenuContent>
  </Menu>;
}

/** A new name for a tab; a followed Concept's tab can go back to the Concept's own label. */
function RenameDialog({ t, filter, onClose, onSave }: { t: T; filter: SavedFilter; onClose: () => void;
  onSave: (name: string | null) => Promise<boolean> }) {
  const [name, setName] = useState(filter.name ?? filter.concept?.name?.value ?? '');
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const topic = filter.concept?.name?.value;
  async function save(value: string | null) {
    setBusy(true);
    if (!await onSave(value)) setBusy(false);
  }
  return <Dialog open pending={busy} onOpenChange={details => { if (!details.open) onClose(); }}>
    <DialogContent size="sm">
      <DialogHeader title={t.renameTitle} />
      <form onSubmit={event => { event.preventDefault(); if (trimmed) void save(trimmed); }}>
        <DialogBody>
          <Field>
            <FieldLabel>{t.tabName}</FieldLabel>
            <Input value={name} maxLength={80} onChange={event => setName(event.target.value)} />
          </Field>
          {filter.concept && filter.name && topic ? <Button type="button" variant="link" size="sm"
            className="justify-self-start px-0" onClick={() => void save(null)}>{t.useTopicName({ topic })}</Button>
            : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="outline">{t.cancel}</Button></DialogClose>
          <Button type="submit" isLoading={busy} disabled={!trimmed || trimmed === filter.name}>{t.save}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
