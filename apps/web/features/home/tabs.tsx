'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { ArrowLeftIcon, ArrowRightIcon, EllipsisIcon, PencilIcon, PinOffIcon, RefreshCwIcon, RotateCwIcon,
  TagIcon, Trash2Icon, TriangleAlertIcon, UserMinusIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { resourceHref } from '../address/path.ts';
import { useOperationGate } from '../shell/shell-provider.tsx';
import { tabLink } from '../feed/controls.tsx';
import { useFeed } from '../feed/feed-context.tsx';
import type { FeedMessages } from '../feed/messages.ts';
import { postRhythm } from '../feed/post-row.tsx';
import { type FeedDefaults, feedSearch, type FeedState, pinnedTab, withChange } from '../feed/state.ts';
import { failureText, type Loaded, type ReadFailure } from '../feed/types.ts';
import type { OperationGate } from '../api/platform-access.ts';
import { conceptPath } from '../concept/state.ts';
import { mainSavedFilterApi, type SavedFilterApi } from '../saved-filter/api.ts';
import { droppedOn, filterTitle, moved } from '../saved-filter/tabs.ts';
import type { CommandResult, SavedFilter, SavedFilters } from '../saved-filter/types.ts';
import { EmptyState, failureDetail } from '../shell/empty-state.tsx';
import {
  appendConceptTabs, applyConceptWorks, type ConceptFeedPage, type ConceptTabList, type ConceptWork,
  conceptFeedIdentity, conceptTabsThatFit, conceptWorksExhausted, type FollowedConceptTab, filtersBesideTopics,
  readConceptFeed, readConceptFollows, topicContinuation, topicFeedFrom, visibleConceptTabs,
} from './followed-concept-feed.ts';
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
  /** The first page of topics the reader follows, in follow order. Each may be a tab. */
  concepts?: readonly FollowedConceptTab[];
  /** The follows cursor after `concepts`, when that page is not the whole list. */
  conceptCursor?: string | null;
  /** Stories: the next follows page. Absent, Home asks the follows API. */
  loadTopics?: (cursor?: string) => Promise<Loaded<ConceptTabList>>;
  /** The `+` picker, drawn after the tabs. */
  picker?: ReactNode;
  /** Stories: an in-memory Main. */
  api?: SavedFilterApi;
  /** Stories: the operations open for the reader, instead of the shell's. */
  gate?: OperationGate;
}

/**
 * Home's tabs, as X pins topic timelines: Following, All, then the Saved
 * Filters the reader pinned, and `+`. They scroll sideways on phones; on
 * desktop a pinned tab is dragged to a new place, and every tab's menu moves,
 * renames or removes it with the keyboard too. Each tab has its own address.
 */
export function HomeTabs({ state, defaults, locale, messages, actingSubject, filters, concepts = [], conceptCursor = null,
  loadTopics, picker, api: given, gate: givenGate }: HomeTabsProps) {
  const t = materializeData(messages.home, { locale });
  const feed = materializeData(messages.feed, { locale });
  const router = useRouter();
  // What the reader may do with a tab follows the grants the layout read; the client asks it at each call, so a
  // refresh that changes the grants applies to the client already made.
  const shellGate = useOperationGate();
  const gate = givenGate ?? shellGate;
  const gateRef = useRef(gate);
  gateRef.current = gate;
  const can = { edit: gate('patchV1MeSaved-filtersById'), order: gate('putV1MeSaved-filtersOrder'),
    delete: gate('deleteV1MeSaved-filtersById') };
  const api = useRef<SavedFilterApi | null>(given ?? null);
  const client = () => api.current ??= mainSavedFilterApi(actingSubject, undefined, operation => gateRef.current(operation));
  const server = filters?.pinned.map(filter => filter.id) ?? [];
  // The order shown: the server's, or a reorder waiting for Main's answer.
  const [order, setOrder] = useState<string[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SavedFilter | null>(null);
  const strip = useRef<HTMLUListElement>(null);
  const gauge = useRef<HTMLDivElement>(null);
  // Topics past the first page arrive only when More topics asks for the next cursor.
  const listKey = `${conceptCursor ?? ''}\n${concepts.map(concept => concept.id).join('\n')}`;
  const [listSeen, setListSeen] = useState(listKey);
  const [loaded, setLoaded] = useState<FollowedConceptTab[] | null>(null);
  const [topicCursor, setTopicCursor] = useState<string | null | undefined>(undefined);
  const [topicsNotice, setTopicsNotice] = useState<'retry' | 'restart' | null>(null);
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [fit, setFit] = useState<number | null>(null);
  const topicsBusy = useRef(false);
  if (listSeen !== listKey) {
    setListSeen(listKey);
    setLoaded(null);
    setTopicCursor(undefined);
    setTopicsNotice(null);
    setTopicsLoading(false);
    topicsBusy.current = false;
  }
  const followed = loaded ?? concepts;
  const followsCursor = topicCursor === undefined ? conceptCursor : topicCursor;
  const currentTopic = state.tab === 'pinned' ? state.filter : null;
  const visibleTopics = visibleConceptTabs(followed, fit ?? followed.length, currentTopic);
  const moreTopics = followsCursor !== null || visibleTopics.length < followed.length;
  // A followed topic has its own tab. The saved filter that only named that topic is not shown beside it.
  const shown = filtersBesideTopics((order ?? server).flatMap(id => filters?.pinned.find(filter => filter.id === id) ?? []),
    followed);
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
  }, [state.tab, state.filter, shown.length, visibleTopics.length]);

  // The strip shows only the topic tabs that fit. The rest stay behind More topics.
  useLayoutEffect(() => {
    const list = strip.current;
    const box = gauge.current;
    if (!list || !box) return;
    const apply = () => {
      const available = list.clientWidth;
      if (available < 1) return;
      const prefix = [...box.querySelectorAll<HTMLElement>('[data-prefix]')]
        .reduce((sum, item) => sum + item.offsetWidth, 0);
      const more = box.querySelector<HTMLElement>('[data-more]')?.offsetWidth ?? 0;
      const tabs = [...box.querySelectorAll<HTMLElement>('[data-topic]')].map(item => item.offsetWidth);
      if (prefix < 1 || (tabs.length > 0 && tabs.every(width => width < 1))) return;
      const count = conceptTabsThatFit({ available, prefix, more, tabs }, followsCursor !== null);
      setFit(current => current === count ? current : count);
    };
    apply();
    const resized = new ResizeObserver(apply);
    resized.observe(list);
    return () => resized.disconnect();
  }, [followed, followsCursor, currentTopic, locale]);

  async function pageTopics(fromStart: boolean) {
    if (topicsBusy.current) return;
    if (!fromStart && !followsCursor) return;
    topicsBusy.current = true;
    setTopicsLoading(true);
    const requested = fromStart ? undefined : followsCursor!;
    const read = await (loadTopics ?? (next => readConceptFollows(browserMainApi(), actingSubject, next)))(requested);
    topicsBusy.current = false;
    setTopicsLoading(false);
    if (!read.ok) { setTopicsNotice(topicContinuation(read.failure)); return; }
    if (fromStart) {
      setLoaded(read.data.tabs);
      setTopicCursor(read.data.nextCursor);
    } else {
      const appended = appendConceptTabs(followed, read.data, requested!);
      setLoaded(appended.tabs);
      setTopicCursor(appended.cursor);
    }
    setTopicsNotice(null);
  }

  async function settle<R>(result: Promise<CommandResult<R>>, after?: () => void) {
    const done = await result;
    if (done.ok) { setStatus(null); after?.(); router.refresh(); return true; }
    setOrder(null);
    // A grant that went away: the refreshed page no longer offers what was just refused, and says nothing.
    if (done.failure === 'closed') { setStatus(null); router.refresh(); return false; }
    setStatus(done.failure === 'stale' ? t.tabsChanged : t.tabsFailed);
    if (done.failure === 'stale') router.refresh();
    return false;
  }

  function reorder(next: string[]) {
    if (!can.order || !filters?.revision || next.join() === (order ?? server).join()) return;
    setOrder(next);
    void settle(client().reorder(next, filters.revision));
  }

  /** Leaves a tab that is going away for All, which always exists. */
  const leave = (filter: SavedFilter) => () => {
    if (state.tab === 'pinned' && state.filter === filter.id) router.push(href(withChange(state, { tab: 'all' })));
  };

  function unfollow(concept: FollowedConceptTab) {
    const leave = state.tab === 'pinned' && state.filter === concept.tab
      ? () => router.push(href(withChange(state, { tab: 'all' }))) : undefined;
    void settle(client().followConcept(concept.id, false), leave);
  }

  function remove(filter: SavedFilter, action: 'unpin' | 'unfollow' | 'delete') {
    void settle(action === 'unpin' ? client().update(filter, { pinned: false })
      : action === 'unfollow' ? client().followConcept(filter.concept!.id, false) : client().remove(filter), leave(filter));
  }

  return <><nav aria-label={feed.views} className="relative flex min-w-0 items-stretch border-border/60 border-b">
    <div ref={gauge} aria-hidden="true" className="pointer-events-none fixed h-0 w-0 overflow-hidden">
      <div className="flex w-max">
        <span data-prefix className={cn(tabLink, 'inline-grid w-max')}>{feed.following}</span>
        <span data-prefix className={cn(tabLink, 'inline-grid w-max')}>{feed.all}</span>
        {followed.map(concept => {
          const name = concept.name?.value ?? t.untitledTab;
          return <span key={concept.id} data-topic className={cn(tabLink, 'inline-grid w-max max-w-56',
            currentTopic === concept.tab && 'pe-9 sm:pe-10')}>{name}</span>;
        })}
        <span data-more className={cn(tabLink, 'inline-grid w-max')}>{t.moreTopics}</span>
      </div>
    </div>
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
      {visibleTopics.map(concept => {
        const title = concept.name;
        const name = title?.value ?? t.untitledTab;
        const current = currentTopic === concept.tab;
        return <li key={concept.id} className="group/tab relative flex shrink-0 snap-start items-stretch">
          <Link href={href(pinnedTab(state, concept.tab))} aria-current={current ? 'page' : undefined}
            lang={title?.language} dir={title?.direction} draggable={false}
            className={cn(tabLink, 'max-w-56', current && 'pe-9 sm:pe-10')}>
            <span className="truncate">{name}</span></Link>
          {current ? <button type="button" aria-label={t.unfollowTopic({ topic: name })}
            className="absolute end-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full
              text-muted-foreground outline-none hover:bg-foreground/[0.06] hover:text-foreground
              focus-visible:ring-2 focus-visible:ring-ring sm:end-2"
            onClick={() => unfollow(concept)}><UserMinusIcon aria-hidden="true" className="size-4" /></button> : null}
        </li>;
      })}
      {moreTopics ? <li className="flex shrink-0 snap-start">
        <button type="button" className={tabLink} aria-haspopup="dialog" onClick={() => setMoreOpen(true)}>
          {t.moreTopics}</button>
      </li> : null}
      {shown.map((filter, index) => {
        const title = filterTitle(filter);
        const name = title?.value ?? t.untitledTab;
        const current = state.tab === 'pinned' && state.filter === filter.id;
        return <li key={filter.id} draggable={can.order && shown.length > 1} data-dragging={dragging === filter.id || undefined}
          className="group/tab relative flex shrink-0 snap-start items-stretch data-dragging:opacity-50"
          onDragStart={event => { event.dataTransfer.setData('text/plain', filter.id); setDragging(filter.id); }}
          onDragEnd={() => setDragging(null)}
          onDragOver={event => { if (dragging && dragging !== filter.id) event.preventDefault(); }}
          onDrop={event => {
            event.preventDefault();
            if (dragging && can.order) reorder(droppedOn(order ?? server, dragging, filter.id));
            setDragging(null);
          }}>
          <Link href={href(pinnedTab(state, filter.id))} aria-current={current ? 'page' : undefined}
            lang={title?.language} draggable={false}
            className={cn(tabLink, 'max-w-56 sm:pe-10', current && 'pe-9')}>
            <span className="truncate">{name}</span></Link>
          <TabMenu t={t} name={name} filter={filter} first={index === 0} last={index === shown.length - 1}
            can={can} visible={current} onSelect={action => {
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
  {moreOpen ? <MoreTopics t={t} topics={followed} cursor={followsCursor} notice={topicsNotice} loading={topicsLoading}
    hrefFor={tab => href(pinnedTab(state, tab))} onClose={() => setMoreOpen(false)}
    onMore={() => void pageTopics(false)} onRestart={() => void pageTopics(true)} /> : null}
  </>;
}

type TabAction = 'rename' | 'left' | 'right' | 'unpin' | 'unfollow' | 'delete';

/** A pinned tab's own menu: shown on the current tab, and on hover or focus for the others. */
function TabMenu({ t, name, filter, first, last, can, visible, onSelect }: { t: T; name: string; filter: SavedFilter;
  first: boolean; last: boolean; can: { edit: boolean; order: boolean; delete: boolean }; visible: boolean;
  onSelect: (action: TabAction) => void }) {
  // A follow is its own public operation; every other action needs its Saved Filter operation open.
  const removable = filter.concept ? true : can.delete;
  if (!can.edit && !can.order && !removable) return null;
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
      {can.edit ? <MenuItem value="rename"><PencilIcon aria-hidden="true" />{t.renameTab}</MenuItem> : null}
      {can.order && !first ? <MenuItem value="left"><ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />
        {t.moveLeft}</MenuItem> : null}
      {can.order && !last ? <MenuItem value="right"><ArrowRightIcon aria-hidden="true" className="rtl:rotate-180" />
        {t.moveRight}</MenuItem> : null}
      {can.edit && (can.order || removable) ? <MenuSeparator /> : null}
      {can.edit ? <MenuItem value="unpin"><PinOffIcon aria-hidden="true" />{t.unpinTab}</MenuItem> : null}
      {filter.concept ? <MenuItem value="unfollow" variant="destructive"><UserMinusIcon aria-hidden="true" />
        {t.unfollowTopic({ topic: filter.concept.name?.value ?? name })}</MenuItem>
        : can.delete ? <MenuItem value="delete" variant="destructive"><Trash2Icon aria-hidden="true" />{t.deleteFilter}</MenuItem>
          : null}
    </MenuContent>
  </Menu>;
}

/** Every followed topic, in follow order. Show more asks for the next follows cursor. */
function MoreTopics({ t, topics, cursor, notice, loading, hrefFor, onClose, onMore, onRestart }: {
  t: T; topics: readonly FollowedConceptTab[]; cursor: string | null; notice: 'retry' | 'restart' | null;
  loading: boolean; hrefFor: (tab: string) => string; onClose: () => void; onMore: () => void; onRestart: () => void;
}) {
  return <Dialog open pending={loading} onOpenChange={details => { if (!details.open) onClose(); }}>
    <DialogContent size="sm">
      <DialogHeader title={t.moreTopics} />
      <DialogBody>
        <ul className="grid max-h-80 overflow-y-auto">
          {topics.map(topic => {
            const title = topic.name;
            const name = title?.value ?? t.untitledTab;
            return <li key={topic.id}>
              <Link href={hrefFor(topic.tab)} lang={title?.language} dir={title?.direction} onClick={onClose}
                className="block rounded-md px-2 py-2 text-sm outline-none hover:bg-foreground/[0.04]
                  focus-visible:ring-2 focus-visible:ring-ring">{name}</Link>
            </li>;
          })}
        </ul>
        {notice === 'restart' ? <p role="status" className="text-sm">{t.topicsChanged}</p> : null}
        {notice === 'retry' ? <p role="status" className="text-destructive-foreground text-sm">{t.topicsMoreFailed}</p> : null}
        {notice === 'restart' ? <Button type="button" variant="outline" size="sm" isLoading={loading} onClick={onRestart}>
          {loading ? t.loadingMoreTopics : t.showTopicsFromStart}</Button>
          : cursor ? <Button type="button" variant="outline" size="sm" isLoading={loading} onClick={onMore}>
            {loading ? t.loadingMoreTopics : t.showMoreWorks}</Button> : null}
      </DialogBody>
    </DialogContent>
  </Dialog>;
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

type ConceptLoader = (cursor?: string) => Promise<Loaded<ConceptFeedPage>>;

/** The first page failed: say what failed, and offer the one next step. */
function TopicFailure({ failure, reference }: { failure: ReadFailure; reference?: string }) {
  const { t, signInHref } = useFeed();
  const router = useRouter();
  const text = failureText(failure, { failedTitle: t.failed, offline: t.failedBody, server: t.serverBody,
    missingTitle: t.feedMissing, missingBody: t.missingBody, deniedTitle: t.deniedTitle, deniedBody: t.deniedBody,
    movedTitle: t.moved, movedBody: t.movedBody, budget: t.budgetBody });
  if (text.kind === 'absent') return null;
  const moved = text.action === 'restart';
  const quiet = text.action === 'none' || text.action === 'sign-in';
  return <EmptyState icon={moved ? RefreshCwIcon : TriangleAlertIcon} tone={quiet || moved ? 'default' : 'destructive'}
    role={quiet ? 'status' : 'alert'} title={text.title}
    description={failureDetail(text.description, reference, t.errorReference, text.reference)} className="m-3 sm:m-4">
    {text.action === 'none' ? null : text.action === 'sign-in'
      ? <Link href={signInHref} className={buttonVariants()}>{t.signIn}</Link>
      : <Button onClick={() => router.refresh()}><RotateCwIcon aria-hidden="true" />{moved ? t.refresh : t.retry}</Button>}
  </EmptyState>;
}

/**
 * One followed topic's public works, newest first. The server renders the first
 * seek page; Show more asks for the next cursor and keeps what is already listed.
 */
export function ConceptTopicFeed({ topic, initial, locale, messages, load }: {
  topic: FollowedConceptTab | null; initial: Loaded<ConceptFeedPage>; locale: UiLocale;
  messages: { home: HomeMessages }; load?: ConceptLoader;
}) {
  const home = materializeData(messages.home, { locale });
  const identity = conceptFeedIdentity(initial);
  const opened = topicFeedFrom(initial);
  const [seen, setSeen] = useState(identity);
  const [items, setItems] = useState<ConceptWork[]>(opened.items);
  const [cursor, setCursor] = useState<string | null>(opened.cursor);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<'retry' | 'restart' | null>(null);
  const busy = useRef(false);
  // A new read (retry, refresh) replaces the page. The previous cursor is not kept.
  if (seen !== identity) {
    setSeen(identity);
    setItems(opened.items);
    setCursor(opened.cursor);
    setNotice(null);
    setLoading(false);
    busy.current = false;
  }
  const label = topic?.name?.value ?? home.untitledTab;
  async function more(fromStart = false) {
    if (!topic || busy.current) return;
    if (!fromStart && !cursor) return;
    busy.current = true;
    setLoading(true);
    const requested = fromStart ? undefined : cursor!;
    const read = await (load ?? (next => readConceptFeed(browserMainApi(), topic.id, locale, next)))(requested);
    busy.current = false;
    setLoading(false);
    if (!read.ok) { setNotice(topicContinuation(read.failure)); return; }
    const applied = applyConceptWorks(fromStart ? [] : items, read.data, fromStart ? null : cursor);
    setItems(applied.items);
    setCursor(applied.cursor);
    setNotice(null);
  }
  if (!initial.ok) return <TopicFailure failure={initial.failure} reference={initial.reference} />;
  if (conceptWorksExhausted(items, cursor)) {
    return <EmptyState icon={TagIcon} title={home.emptyPinned({ topic: label })} description={home.emptyTopicBody}
      className="m-3 sm:m-4">
      {topic ? <Link href={localizedPath(conceptPath(topic.id), locale)}
        className={buttonVariants({ size: 'sm' })}>{home.openTopic({ topic: label })}</Link> : null}
    </EmptyState>;
  }
  return <div>
    <ul>
      {items.map(item => <li key={item.id} className="border-border/60 border-b">
        <Link href={localizedPath(resourceHref('/w/', item.id), locale)} lang={item.name.language}
          dir={item.name.direction} className={cn(postRhythm.row, postRhythm.title, 'block text-balance outline-none',
            'hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset')}>
          {item.name.value}</Link>
      </li>)}
    </ul>
    {notice === 'restart' || cursor ? <div className="grid justify-items-center gap-2 px-4 py-3">
      {notice === 'restart' ? <p role="status" className="text-center text-sm">{home.topicMoved}</p> : null}
      {notice === 'retry' ? <p role="status" className="text-destructive-foreground text-sm">{home.topicMoreFailed}</p> : null}
      {notice === 'restart'
        ? <Button type="button" variant="outline" size="sm" isLoading={loading} onClick={() => void more(true)}>
          {loading ? home.loadingMoreWorks : home.startFromNewest}</Button>
        : <Button type="button" variant="outline" size="sm" isLoading={loading} onClick={() => void more(false)}>
          {loading ? home.loadingMoreWorks : home.showMoreWorks}</Button>}
    </div> : null}
  </div>;
}
