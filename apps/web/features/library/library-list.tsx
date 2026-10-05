'use client';

import { Checkbox } from '@rezics/ui/checkbox';

import { ActionBar, ActionBarBody, ActionBarClose, ActionBarContent, ActionBarSeparator, ActionBarValue }
  from '@rezics/ui/action-bar';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { BookmarkMinusIcon, BookXIcon, CheckSquareIcon, ChevronDownIcon, FolderInputIcon, FolderMinusIcon, LockIcon,
  TagIcon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { type ReactNode, useState, useSyncExternalStore } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { relativeTime } from '../feed/time.ts';
import { AuthorNames } from '../catalogue/author-names.tsx';
import { ShelfButton, ShelfMark } from '../catalogue/reader-actions.tsx';
import { RatingInline } from '../catalogue/rating.tsx';
import { slotRatio } from '../catalogue/work.ts';
import { CoverLink, WorkTile, workTitle } from '../catalogue/work-tile.tsx';
import Link from '../shell/localized-link.tsx';
import { TrackingControl } from '../tracking/tracking-control.tsx';
import { formatDay } from './format.ts';
import { hasKindWords, isUseWork, rowStatusLabel, statusLabel } from './labels.ts';
import { useLibrary } from './library-context.tsx';
import type { LibraryMessages } from './messages.ts';
import { OwnRating, PrivateReviewCell, ReadDates, ReadingProgress, ReviewCell } from './row-parts.tsx';
import { type LibraryShelf, libraryHref, parseLibraryState, statusShelves } from './state.ts';
import type { CustomShelf, LibraryRow, ShelfStatus } from './types.ts';

type T = ReturnType<typeof materializeData<LibraryMessages>>;

const shelfHref = (id: string) => libraryHref(parseLibraryState({}), { shelf: { kind: 'custom', id: id.slice(-36) } });

/** A shelf row Main could not name: no generated cover, so it is not mistaken for a Work. */
function PlaceholderCover({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('grid place-items-center rounded-md border border-dashed border-border',
    'bg-muted/50 text-muted-foreground', className)}>
    <BookXIcon className="size-5" /></div>;
}

/** "Added Sep 3, 2026 · Last read 2 days ago", and the reader's own shelves the Work is on. */
function RowMeta({ row, now, locale, t }: { row: LibraryRow; now: number; locale: UiLocale; t: T }) {
  const facts = [row.shelvedAt ? t.added({ date: formatDay(row.shelvedAt, locale) }) : null,
    row.lastReadAt ? (isUseWork(row) ? t.lastUsed : t.lastRead)({
      date: relativeTime(row.lastReadAt, now, locale, 'long') }) : null]
    .filter(fact => fact !== null);
  if (!facts.length && !row.customShelves.length) return null;
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
    {facts.length ? <span>{facts.join(' · ')}</span> : null}
    {row.customShelves.length ? <ul className="flex flex-wrap items-center gap-1.5">
      <TagIcon aria-hidden="true" className="size-3.5" />
      {row.customShelves.map(shelf => <li key={shelf.id}>
        <Link href={shelfHref(shelf.id)} className="rounded-full bg-muted px-2 py-0.5 text-foreground outline-none
          hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">{shelf.name}</Link>
      </li>)}
    </ul> : null}
  </div>;
}

/** A selection box that names the Work it selects. */
function SelectBox({ title, checked, onChange, t, className }: {
  title: string; checked: boolean; onChange: (checked: boolean) => void; t: T; className?: string;
}) {
  return <Checkbox className={cn('shrink-0 cursor-pointer', className)} checked={checked} aria-label={t.selectWork({ title })} onCheckedChange={event => onChange(event.checked === true)} />;
}

/**
 * One Work as a row, Goodreads' My Books with StoryGraph's progress: cover,
 * title and the shelf button, then what the Work's shelf calls for — progress
 * and Continue while reading; dates, stars and the review once read.
 */
function Row({ row, selecting, selected, onSelect, now, avatarQuery, locale, messages }: {
  row: LibraryRow; selecting: boolean; selected: boolean; onSelect: (checked: boolean) => void; now: number;
  avatarQuery?: string; locale: UiLocale; messages: LibraryMessages;
}) {
  const t = materializeData(messages, { locale });
  const unavailable = row.available === false;
  const title = unavailable ? t.unavailableWork : workTitle(row.work, locale);
  return <li className={cn('flex gap-3 py-6 first:pt-2 sm:gap-4', selected && 'bg-accent/40')}>
    {selecting ? <SelectBox title={title} checked={selected} onChange={onSelect} t={t} className="mt-1" /> : null}
    <article className="group/tile relative grid min-w-0 flex-1 grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4
      sm:grid-cols-[5.5rem_minmax(0,1fr)_auto] sm:gap-x-6">
      {unavailable ? <PlaceholderCover className="aspect-[2/3] row-span-2 self-start sm:row-span-1" />
        : <CoverLink work={row.work} avatarQuery={avatarQuery} className="row-span-2 self-start sm:row-span-1" />}
      <div className="grid min-w-0 content-start gap-2.5">
        {unavailable ? <h3 className="text-pretty font-medium text-lg/snug text-muted-foreground">{title}</h3> : <>
          <div className="grid gap-1">
            <h3 lang={row.work.title?.language} dir={row.work.title?.direction}
              className="text-pretty font-medium font-work-title text-lg/snug [overflow-wrap:anywhere]">
              <Link href={row.work.href} className="rounded-sm outline-none decoration-1 underline-offset-2 hover:underline
                focus-visible:ring-2 focus-visible:ring-ring">{title}</Link>
            </h3>
            {row.work.authors.length ? <p className="text-muted-foreground">
              <AuthorNames authors={row.work.authors} /></p> : null}
            {hasKindWords(row) && row.status ? <p className="text-muted-foreground text-xs">
              {rowStatusLabel(row, t)}</p> : null}
          </div>
          {row.status === 'reading' ? <ReadingProgress row={row} locale={locale} messages={messages} /> : null}
          {row.status === 'read' ? <ReadDates row={row} now={now} locale={locale} messages={messages} /> : null}
          {row.stateRead && (row.status === 'read' || row.rating !== null)
            ? <OwnRating row={row} locale={locale} messages={messages} /> : null}
          {row.status === 'read' ? <ReviewCell row={row} locale={locale} messages={messages} /> : null}
          {row.status === 'read' ? <PrivateReviewCell row={row} locale={locale} messages={messages} /> : null}
        </>}
        <RowMeta row={row} now={now} locale={locale} t={t} />
      </div>
      <div className="col-start-2 mt-3 grid gap-2 self-start sm:col-start-3 sm:mt-0">
        <ShelfButton work={row.work.id} title={title} locale={locale} size="sm" variant="outline" className="w-44" />
        {/* Attempts (paused, did not finish, reread) are kept and edited in G-838's sheet. */}
        {unavailable ? null : <TrackingControl work={row.work.id} title={title} locale={locale} size="sm" className="w-44" />}
      </div>
    </article>
  </li>;
}

/** One Work as a cover, with the reader's stars once read and how far they are while reading. */
function Tile({ row, slot, selecting, selected, onSelect, avatarQuery, locale, messages }: {
  row: LibraryRow; slot: number; selecting: boolean; selected: boolean; onSelect: (checked: boolean) => void;
  avatarQuery?: string; locale: UiLocale; messages: LibraryMessages;
}) {
  const t = materializeData(messages, { locale });
  const unavailable = row.available === false;
  const title = unavailable ? t.unavailableWork : workTitle(row.work, locale);
  const chapters = row.progress?.chapters;
  if (unavailable) return <li className="relative min-w-0">
    <article className="group/tile relative flex min-w-0 flex-col">
      <div className="relative" style={{ aspectRatio: String(slot) }}>
        <PlaceholderCover className="absolute inset-0" />
        <ShelfMark work={row.work.id} title={title} locale={locale} />
      </div>
      <h3 className="mt-3 text-pretty text-muted-foreground text-sm">{title}</h3>
    </article>
    {selecting ? <label className="absolute start-2 top-2 z-30 grid size-9 cursor-pointer place-items-center rounded-full
      bg-background/92 shadow-[0_2px_8px_rgb(0_0_0/0.18)] backdrop-blur">
      <SelectBox title={title} checked={selected} onChange={onSelect} t={t} />
    </label> : null}
  </li>;
  return <li className="relative min-w-0">
    <WorkTile work={{ ...row.work, rating: null }} slot={slot} headingLevel={3} avatarQuery={avatarQuery}
      locale={locale} className={cn(selected
        && '[&_[data-slot=work-cover]]:ring-4 [&_[data-slot=work-cover]]:ring-primary')} />
    {row.rating !== null ? <RatingInline rating={{ mean: row.rating, count: 0, max: 5, own: true }} locale={locale}
      className="mt-1" /> : null}
    {row.status === 'reading' && chapters ? <div className="mt-2 grid gap-1">
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-primary" style={{ width: `${(chapters.read / chapters.total) * 100}%` }} />
      </div>
      <p className="text-muted-foreground text-xs tabular-nums">{t.chaptersRead({
        read: new Intl.NumberFormat(locale).format(chapters.read),
        total: new Intl.NumberFormat(locale).format(chapters.total) })}</p>
    </div> : null}
    {selecting ? <label className="absolute start-2 top-2 z-30 grid size-9 cursor-pointer place-items-center rounded-full
      bg-background/92 shadow-[0_2px_8px_rgb(0_0_0/0.18)] backdrop-blur">
      <SelectBox title={title} checked={selected} onChange={onSelect} t={t} />
    </label> : null}
  </li>;
}

const phone = '(max-width: 767px)';
const subscribePhone = (listener: () => void) => {
  const query = matchMedia(phone);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};

/**
 * What to do with the selected Works, in a bar over the page: move them to
 * a status shelf, add them to one of the reader's shelves, or take them off.
 */
function SelectionBar({ selected, rows, shelf, custom, customShelves, clear, locale, messages }: {
  selected: ReadonlySet<string>; rows: readonly LibraryRow[]; shelf: LibraryShelf; custom: CustomShelf | null;
  customShelves: readonly CustomShelf[]; clear: () => void; locale: UiLocale; messages: LibraryMessages;
}) {
  const t = materializeData(messages, { locale });
  const { api, moveWorks, refresh, announce } = useLibrary();
  const [busy, setBusy] = useState(false);
  // The bar fades out after the selection clears; it keeps the last count rather than read "0 selected".
  const [count, setCount] = useState(selected.size);
  if (selected.size && selected.size !== count) setCount(selected.size);
  // Clear of the phone's bottom navigation.
  const onPhone = useSyncExternalStore(subscribePhone, () => matchMedia(phone).matches, () => false);
  const works = rows.filter(row => selected.has(row.work.id));

  async function run(action: () => Promise<number>, done: string) {
    setBusy(true);
    const refused = await action().catch(() => works.length);
    setBusy(false);
    announce(refused ? { tone: 'destructive', text: t.someFailed(refused) } : { tone: 'default', text: done });
    if (!refused) clear();
  }
  const move = (status: ShelfStatus | null) => run(() => moveWorks(works.map(row => row.work.id), status),
    status ? t.movedTo({ count: works.length, shelf: statusLabel(status, t) }) : t.removedWorks(works.length));
  const add = (target: CustomShelf) => run(async () => {
    const adding = works.filter(row => !row.customShelves.some(item => item.id === target.id));
    const written = adding.length ? await api.addToShelf(target.id, adding.map(row => row.work.id))
      : { ok: true as const, data: null };
    refresh();
    return written.ok ? 0 : adding.length;
  }, t.addedTo({ count: works.length, shelf: target.name }));
  const removeFromShelf = (target: CustomShelf) => run(async () => {
    const occurrences = works.flatMap(row => (row.occurrence ? [row.occurrence] : []));
    const written = await api.removeFromShelf(target.id, occurrences);
    refresh();
    return written.ok ? 0 : occurrences.length;
  }, t.removedWorks(works.length));

  const current = shelf.kind === 'status' ? shelf.status : null;
  const others = customShelves.filter(item => item.id !== custom?.id);
  return <ActionBar open={selected.size > 0} onOpenChange={open => { if (!open) clear(); }}
    positioning={{ placement: 'bottom', gutter: onPhone ? '84px' : '16px' }}>
    <ActionBarContent aria-label={t.selectionActions} aria-busy={busy || undefined} className="max-w-full">
      <ActionBarBody className="flex-wrap justify-center">
        <ActionBarValue count={count}>{t.selected(count)}</ActionBarValue>
        <ActionBarSeparator />
        <Menu onSelect={({ value }) => void move(value as ShelfStatus)}>
          <MenuTrigger disabled={busy} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            <FolderInputIcon aria-hidden="true" />{t.moveTo}<ChevronDownIcon aria-hidden="true" /></MenuTrigger>
          <MenuContent className="w-52">
            {statusShelves.filter(status => status !== current).map(status => <MenuItem key={status} value={status}>
              {statusLabel(status, t)}</MenuItem>)}
          </MenuContent>
        </Menu>
        {others.length ? <Menu onSelect={({ value }) => {
          const target = others.find(item => item.id === value);
          if (target) void add(target);
        }}>
          <MenuTrigger disabled={busy} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            <TagIcon aria-hidden="true" />{t.addToShelf}<ChevronDownIcon aria-hidden="true" /></MenuTrigger>
          <MenuContent className="w-60">
            {others.map(item => <MenuItem key={item.id} value={item.id}>
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.disclosure === 'private' ? <LockIcon aria-label={t.privateShelf} className="size-3.5" /> : null}
            </MenuItem>)}
          </MenuContent>
        </Menu> : null}
        {custom ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void removeFromShelf(custom)}>
          <FolderMinusIcon aria-hidden="true" />{t.removeFromThisShelf}</Button>
          : <Button variant="ghost" size="sm" disabled={busy} className="text-destructive-foreground"
            onClick={() => void move(null)}>
            <BookmarkMinusIcon aria-hidden="true" />{t.removeFromLibrary}</Button>}
        <ActionBarSeparator />
        <ActionBarClose aria-label={t.clearSelection} className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
          <XIcon aria-hidden="true" /></ActionBarClose>
      </ActionBarBody>
    </ActionBarContent>
  </ActionBar>;
}

/**
 * The chosen shelf's page of Works as a list or a grid of covers. Select
 * turns on boxes for moving several Works at once, as Goodreads' batch edit.
 */
export function LibraryList({ rows, shelf, custom, customShelves, layout, controls, now, avatarQuery, locale,
  messages }: {
  rows: readonly LibraryRow[]; shelf: LibraryShelf; custom: CustomShelf | null;
  customShelves: readonly CustomShelf[]; layout: 'list' | 'grid';
  /** Sort and layout, which are links. */
  controls: ReactNode; now: number; avatarQuery?: string; locale: UiLocale; messages: LibraryMessages;
}) {
  const t = materializeData(messages, { locale });
  const { notice } = useLibrary();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const shown = new Set(rows.map(row => row.work.id));
  // A Work that left the page (moved off this shelf) is no longer selected.
  const chosen = new Set([...selected].filter(work => shown.has(work)));
  const toggle = (work: string, checked: boolean) => setSelected(current => {
    const next = new Set(current);
    if (checked) next.add(work); else next.delete(work);
    return next;
  });
  const every = rows.length > 0 && chosen.size === rows.length;
  const slot = slotRatio(rows.map(row => row.work));
  return <div className="grid gap-4">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="flex flex-wrap items-center gap-2">{controls}</div>
      {rows.length ? <Button variant={selecting ? 'soft' : 'ghost'} size="sm" pill aria-pressed={selecting}
        onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>
        <CheckSquareIcon aria-hidden="true" />{selecting ? t.doneSelecting : t.select}</Button> : null}
    </div>
    {notice ? <p role={notice.tone === 'destructive' ? 'alert' : 'status'} className={cn('rounded-xl px-4 py-2.5 text-sm',
      notice.tone === 'destructive' ? 'bg-destructive/10 text-destructive-foreground' : 'bg-muted')}>
      {notice.text}</p> : null}
    {selecting ? <Checkbox className="flex w-fit cursor-pointer items-center gap-3 text-sm" checked={chosen.size > 0 && !every ? 'indeterminate' : every} onCheckedChange={event => setSelected(event.checked === true ? new Set(rows.map(row => row.work.id)) : new Set())}>
      {t.selectPage}</Checkbox> : null}
    {layout === 'grid'
      ? <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4 xl:grid-cols-5">
        {rows.map(row => <Tile key={row.work.id} row={row} slot={slot} selecting={selecting}
          selected={chosen.has(row.work.id)} onSelect={checked => toggle(row.work.id, checked)}
          avatarQuery={avatarQuery} locale={locale} messages={messages} />)}
      </ul>
      : <ol className="grid divide-y divide-border/70">
        {rows.map(row => <Row key={row.work.id} row={row} selecting={selecting} selected={chosen.has(row.work.id)}
          onSelect={checked => toggle(row.work.id, checked)} now={now} avatarQuery={avatarQuery} locale={locale}
          messages={messages} />)}
      </ol>}
    <SelectionBar selected={chosen} rows={rows} shelf={shelf} custom={custom} customShelves={customShelves}
      clear={() => setSelected(new Set())} locale={locale} messages={messages} />
  </div>;
}
