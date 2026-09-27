'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { ButtonGroup } from '@rezics/ui/button-group';
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { Rating, RatingLabel } from '@rezics/ui/rating';
import { cn } from '@rezics/ui/utils';
import { BookmarkCheckIcon, BookmarkPlusIcon, CheckIcon, ChevronDownIcon, StarIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { createContext, type ReactNode, useContext, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { messages } from './messages.ts';

/** A status shelf: a Work is on at most one of them (Main's reader status, G-285). */
export const readingStatuses = ['want-to-read', 'reading', 'read'] as const;
export type ReadingStatus = (typeof readingStatuses)[number];

/** The reader's own state for one Work. */
export interface ReaderWorkState { status: ReadingStatus | null; rating: number | null }

/**
 * What a page can do for its reader, the seam between catalogue controls and
 * Main. Pages provide `signed-out` (controls lead to sign-in) or `unavailable`
 * (no control is drawn, rather than one that does nothing); a `ready` adapter
 * reads and writes the reader's status shelves and rating. Main's reading
 * shelves and batch reader state are in progress (G-285); until they land,
 * only stories supply a `ready` adapter.
 */
export type ReaderActions =
  | { kind: 'unavailable' }
  | { kind: 'signed-out'; signInHref: string }
  | {
    kind: 'ready';
    stateOf: (work: string) => ReaderWorkState;
    /** Resolves false when Main refused or could not be reached; the control then says so. */
    setStatus: (work: string, status: ReadingStatus | null) => Promise<boolean>;
    /** Null while the rating write is not wired; the stars are then not drawn. */
    rate: ((work: string, value: number | null) => Promise<boolean>) | null;
    ratingMax: number;
  };

const ReaderActionsContext = createContext<ReaderActions>({ kind: 'unavailable' });

/**
 * Supplies reader actions below it. Server pages pass whether the reader is
 * signed in and where sign-in returns; `actions` overrides both (stories).
 */
export function ReaderActionsProvider({ signedIn, signInHref, actions, children }: {
  signedIn: boolean; signInHref: string; actions?: ReaderActions; children: ReactNode;
}) {
  const value: ReaderActions = actions ?? (signedIn ? { kind: 'unavailable' } : { kind: 'signed-out', signInHref });
  return <ReaderActionsContext value={value}>{children}</ReaderActionsContext>;
}

export const useReaderActions = () => useContext(ReaderActionsContext);

/** The reader's status with an optimistic update: shown at once, reverted with a note when Main refuses. */
function useStatus(work: string) {
  const actions = useReaderActions();
  const initial = actions.kind === 'ready' ? actions.stateOf(work).status : null;
  const [status, setLocal] = useState<ReadingStatus | null>(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'failed'>('idle');
  async function choose(next: ReadingStatus | null) {
    if (actions.kind !== 'ready' || next === status) return;
    const before = status;
    setLocal(next);
    setState('saving');
    const saved = await actions.setStatus(work, next).catch(() => false);
    if (!saved) setLocal(before);
    setState(saved ? 'idle' : 'failed');
  }
  return { actions, status, state, choose };
}

function statusLabel(status: ReadingStatus, t: ReturnType<typeof materializeData<typeof messages.en>>) {
  return status === 'want-to-read' ? t.wantToRead : status === 'reading' ? t.reading : t.read;
}

function StatusMenuItems({ status, t }: { status: ReadingStatus | null; t: ReturnType<typeof materializeData<typeof messages.en>> }) {
  return <>
    <MenuRadioGroup value={status ?? ''}>
      {readingStatuses.map(item => <MenuRadioItem key={item} value={item}>{statusLabel(item, t)}</MenuRadioItem>)}
    </MenuRadioGroup>
    {status ? <><MenuSeparator /><MenuItem value="remove">{t.removeFromShelf}</MenuItem></> : null}
  </>;
}

const selectStatus = (choose: (next: ReadingStatus | null) => void) => ({ value }: { value: string }) => {
  if (value === 'remove') choose(null);
  else if ((readingStatuses as readonly string[]).includes(value)) choose(value as ReadingStatus);
};

const markClass = cn('absolute end-2 top-2 z-20 grid size-9 place-items-center rounded-full outline-none',
  'bg-background/92 text-foreground shadow-[0_2px_8px_rgb(0_0_0/0.18)] backdrop-blur transition-opacity',
  'hover:bg-background focus-visible:ring-2 focus-visible:ring-ring',
  // Shown on hover and focus where there is a pointer; always on touch screens and once shelved.
  'opacity-0 group-focus-within/tile:opacity-100 group-hover/tile:opacity-100 pointer-coarse:opacity-100',
  'data-shelved:bg-primary data-shelved:text-primary-foreground data-shelved:opacity-100');

/** The shelf control on a cover's corner, for tiles in shelves and grids. */
export function ShelfMark({ work, title, locale }: { work: string; title: string; locale: UiLocale }) {
  const t = materializeData(messages[locale], { locale });
  const { actions, status, state, choose } = useStatus(work);
  if (actions.kind === 'unavailable') return null;
  if (actions.kind === 'signed-out') {
    return <Link href={actions.signInHref} aria-label={t.signInToShelve} title={t.signInToShelve} className={markClass}>
      <BookmarkPlusIcon aria-hidden="true" className="size-4.5" /></Link>;
  }
  const label = status ? `${t.shelve({ title })} · ${statusLabel(status, t)}` : t.shelve({ title });
  return <Menu onSelect={selectStatus(next => void choose(next))}>
    <MenuTrigger aria-label={label} title={label} data-shelved={status ? '' : undefined}
      aria-busy={state === 'saving' || undefined} className={markClass}>
      {status ? <BookmarkCheckIcon aria-hidden="true" className="size-4.5" />
        : <BookmarkPlusIcon aria-hidden="true" className="size-4.5" />}
    </MenuTrigger>
    <MenuContent className="w-52"><StatusMenuItems status={status} t={t} /></MenuContent>
    {state === 'failed' ? <span role="status" className="sr-only">{t.saveFailed}</span> : null}
  </Menu>;
}

/**
 * The primary shelf action: "Want to read" in one press, the other status
 * shelves and removal in its menu. Signed out, it leads to sign-in.
 */
export function ShelfButton({ work, title, locale, size = 'lg', variant = 'default', className }: {
  work: string; title: string; locale: UiLocale; size?: 'sm' | 'md' | 'lg';
  /** `outline` where another action leads, such as Read on the Work page. */
  variant?: 'default' | 'outline'; className?: string;
}) {
  const t = materializeData(messages[locale], { locale });
  const { actions, status, state, choose } = useStatus(work);
  if (actions.kind === 'unavailable') return null;
  if (actions.kind === 'signed-out') {
    return <Link href={actions.signInHref} className={cn(buttonVariants({ size, variant, pill: true }), className)}>
      <BookmarkPlusIcon aria-hidden="true" />{t.wantToRead}<span className="sr-only"> — {t.signInToShelve}</span></Link>;
  }
  const failure = state === 'failed'
    ? <p role="status" className="text-destructive-foreground text-xs">{t.saveFailed}</p> : null;
  if (status) {
    return <div className={cn('grid gap-1.5', className)}>
      <Menu onSelect={selectStatus(next => void choose(next))}>
        <MenuTrigger className={cn(buttonVariants({ size, variant: 'outline', pill: true }), 'w-full')}
          aria-label={`${statusLabel(status, t)} — ${t.shelve({ title })}`} aria-busy={state === 'saving' || undefined}>
          <CheckIcon aria-hidden="true" className="text-primary" />{statusLabel(status, t)}
          <ChevronDownIcon aria-hidden="true" className="ms-auto" />
        </MenuTrigger>
        <MenuContent className="w-56"><StatusMenuItems status={status} t={t} /></MenuContent>
      </Menu>
      {failure}
    </div>;
  }
  return <div className={cn('grid gap-1.5', className)}>
    <ButtonGroup className="w-full">
      <Button size={size} variant={variant} className="flex-1 rounded-s-full" isLoading={state === 'saving'}
        onClick={() => void choose('want-to-read')}>
        <BookmarkPlusIcon aria-hidden="true" />{t.wantToRead}</Button>
      <Menu onSelect={selectStatus(next => void choose(next))}>
        <MenuTrigger aria-label={t.shelfOptions}
          className={cn(buttonVariants({ variant, size: size === 'lg' ? 'icon-lg' : size === 'md' ? 'icon-md' : 'icon-sm' }),
            'w-11 flex-none rounded-e-full', variant === 'default' && 'border-s border-s-primary-foreground/25')}>
          <ChevronDownIcon aria-hidden="true" /></MenuTrigger>
        <MenuContent className="w-56"><StatusMenuItems status={status} t={t} /></MenuContent>
      </Menu>
    </ButtonGroup>
    {failure}
  </div>;
}

/** Inline stars for the reader's own rating of a Work. Signed out, they lead to sign-in. */
export function RateWork({ work, locale, className }: { work: string; locale: UiLocale; className?: string }) {
  const t = materializeData(messages[locale], { locale });
  const actions = useReaderActions();
  const initial = actions.kind === 'ready' ? actions.stateOf(work).rating : null;
  const [value, setValue] = useState<number | null>(initial);
  const [failed, setFailed] = useState(false);
  if (actions.kind === 'unavailable' || (actions.kind === 'ready' && !actions.rate)) return null;
  if (actions.kind === 'signed-out') {
    return <Link href={actions.signInHref} className={cn('group/rate grid justify-items-center gap-1 rounded-xl px-3 py-2',
      'text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', className)}>
      <span aria-hidden="true" className="flex gap-1.5 text-rating/70 group-hover/rate:text-rating">
        {[1, 2, 3, 4, 5].map(star => <StarIcon key={star} className="size-7" strokeWidth={1.25} />)}</span>
      <span className="text-sm">{t.rateThis}</span><span className="sr-only"> — {t.signInToRate}</span>
    </Link>;
  }
  const rate = actions.rate!;
  async function save(next: number) {
    const before = value;
    setValue(next);
    setFailed(false);
    const saved = await rate(work, next).catch(() => false);
    if (!saved) { setValue(before); setFailed(true); }
  }
  return <div className={cn('grid justify-items-center gap-1', className)}>
    <Rating size="lg" count={actions.ratingMax === 10 ? 10 : 5} value={value ?? 0} className="items-center"
      onValueChange={({ value: next }) => void save(next)}>
      <RatingLabel className="order-last font-normal text-muted-foreground text-sm">
        {value ? t.yourRating : t.rateThis}</RatingLabel>
    </Rating>
    {failed ? <p role="status" className="text-destructive-foreground text-xs">{t.saveFailed}</p> : null}
  </div>;
}
