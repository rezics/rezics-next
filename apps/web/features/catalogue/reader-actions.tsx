'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { ButtonGroup } from '@rezics/ui/button-group';
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { Rating, RatingLabel } from '@rezics/ui/rating';
import { cn } from '@rezics/ui/utils';
import { BookmarkCheckIcon, BookmarkPlusIcon, CheckIcon, ChevronDownIcon, StarIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { createContext, lazy, type ReactNode, Suspense, useContext, useRef, useState, useSyncExternalStore } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import type { TrackingApi } from '../tracking/api.ts';
import { copyOf as trackingCopy } from '../tracking/messages.ts';
import { messages } from './messages.ts';
import { createReaderStore, type RatingTarget, type ReaderSeed } from './reader-store.ts';

/** A status shelf: a Work is on at most one of them (Main's reader status, G-285). */
export const readingStatuses = ['want-to-read', 'reading', 'read'] as const;
export type ReadingStatus = (typeof readingStatuses)[number];

/** The reader's own state for one Work. */
export interface ReaderWorkState {
  status: ReadingStatus | null;
  rating: number | null;
  /**
   * Set while the rating shown is a write Main admitted but has not applied yet: `pending` while it is read back,
   * `unsettled` once the bounded read-backs ended without it (the control then says so and offers a refresh).
   */
  ratingWrite?: 'pending' | 'unsettled';
}

/**
 * What a page can do for its reader, the seam between catalogue controls and
 * Main. Signed out, controls lead to sign-in; signed in without an Agent to
 * act as, none is drawn rather than one that cannot act; a `ready` adapter
 * reads and writes the reader's status shelves and rating (`reader-store.ts`
 * over Main's reader library, or an in-memory one in stories).
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
    /** Reads the Work's reader state again, for a rating that is still being processed. */
    refresh?: (work: string) => Promise<void>;
    ratingMax: number;
    /** Tells controls when state read later (a "Show more" page) arrives. */
    subscribe?: (listener: () => void) => () => void;
    snapshot?: () => number;
    /** False once Main denies this Agent a reader library; controls then withdraw. */
    available?: () => boolean;
    /** Attempts, series progress and edition preferences; null where they are not wired, and "Details" is then not drawn. */
    tracking?: TrackingApi | null;
  };

// The details sheet is loaded when a reader first asks for it, not with every card that carries a shelf button.
const TrackingSheet = lazy(() => import('../tracking/tracking-sheet.tsx').then(module => ({ default: module.TrackingSheet })));

const ReaderActionsContext = createContext<ReaderActions>({ kind: 'unavailable' });

/**
 * Supplies reader actions below it. Server pages pass whether the reader is
 * signed in, the Agent they act as, where sign-in returns, and the reader
 * state they read for the Works on the page (plus, on a Work page, what its
 * stars rate); `actions` overrides all of it (stories).
 */
export function ReaderActionsProvider({ signedIn, signInHref, actingSubject, seed, ratingTarget, actions, children }: {
  signedIn: boolean; signInHref: string; actingSubject?: string | null; seed?: ReaderSeed;
  ratingTarget?: RatingTarget | null; actions?: ReaderActions; children: ReactNode;
}) {
  const [store] = useState(() => signedIn && actingSubject && !actions
    ? createReaderStore({ actingSubject, seed, ratingTarget }) : null);
  const value: ReaderActions = actions ?? store
    ?? (signedIn ? { kind: 'unavailable' } : { kind: 'signed-out', signInHref });
  return <ReaderActionsContext value={value}>{children}</ReaderActionsContext>;
}

const unsubscribed = () => () => {};
const still = () => 0;

/** The page's reader actions, re-rendering when state read in the browser arrives. */
export function useReaderActions(): ReaderActions {
  const actions = useContext(ReaderActionsContext);
  const ready = actions.kind === 'ready' ? actions : null;
  useSyncExternalStore(ready?.subscribe ?? unsubscribed, ready?.snapshot ?? still, still);
  return ready?.available?.() === false ? withdrawn : actions;
}

const withdrawn: ReaderActions = { kind: 'unavailable' };

/** The reader's status with an optimistic update: shown at once, reverted with a note when Main refuses. Choices made while one is saving are coalesced by the store, newest wins. */
function useStatus(work: string) {
  const actions = useReaderActions();
  const known = actions.kind === 'ready' ? actions.stateOf(work).status : null;
  const [pending, setPending] = useState<{ status: ReadingStatus | null } | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'failed'>('idle');
  const newest = useRef(0);
  const status = pending ? pending.status : known;
  async function choose(next: ReadingStatus | null) {
    if (actions.kind !== 'ready' || next === status) return;
    const mine = ++newest.current;
    setPending({ status: next });
    setState('saving');
    const saved = await actions.setStatus(work, next).catch(() => false);
    // Only the newest choice settles the control: an older one resolving late must not undo it.
    if (mine !== newest.current) return;
    // Saved, the store now holds the new status; refused, the known one shows again.
    setPending(null);
    setState(saved ? 'idle' : 'failed');
  }
  return { actions, status, state, choose };
}

/**
 * The words for the three status shelves when the Work is not read: the stored statuses stay
 * `want-to-read`, `reading` and `read`, and a page names them in its Work's own verb.
 */
export type StatusWords = Record<'wantToRead' | 'reading' | 'read', string>;

type Copy = ReturnType<typeof materializeData<typeof messages.en>>;

function statusLabel(status: ReadingStatus, t: Copy, words?: StatusWords) {
  const named = words ?? t;
  return status === 'want-to-read' ? named.wantToRead : status === 'reading' ? named.reading : named.read;
}

function StatusMenuItems({ status, t, words, details }: {
  status: ReadingStatus | null; t: Copy; words?: StatusWords; details?: string;
}) {
  return <>
    <MenuRadioGroup value={status ?? ''}>
      {readingStatuses.map(item => <MenuRadioItem key={item} value={item}>{statusLabel(item, t, words)}</MenuRadioItem>)}
    </MenuRadioGroup>
    {status ? <><MenuSeparator /><MenuItem value="remove">{t.removeFromShelf}</MenuItem></> : null}
    {details ? <><MenuSeparator /><MenuItem value="details">{details}</MenuItem></> : null}
  </>;
}

const selectStatus = (choose: (next: ReadingStatus | null) => void, details?: () => void) => ({ value }: { value: string }) => {
  if (value === 'remove') choose(null);
  else if (value === 'details') details?.();
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
export function ShelfButton({ work, title, locale, size = 'lg', variant = 'default', className, words }: {
  work: string; title: string; locale: UiLocale; size?: 'sm' | 'md' | 'lg';
  /** The Work's own verb for the shelves ("Want to play"); the reading words when left out. */
  words?: StatusWords;
  /** `outline` where another action leads, such as Read on the Work page. */
  variant?: 'default' | 'outline'; className?: string;
}) {
  const t = materializeData(messages[locale], { locale });
  const { actions, status, state, choose } = useStatus(work);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsAsked, setDetailsAsked] = useState(false);
  if (actions.kind === 'unavailable') return null;
  if (actions.kind === 'signed-out') {
    return <Link href={actions.signInHref} className={cn(buttonVariants({ size, variant, pill: true }), className)}>
      <BookmarkPlusIcon aria-hidden="true" />{words?.wantToRead ?? t.wantToRead}<span className="sr-only"> — {t.signInToShelve}</span></Link>;
  }
  const tracking = actions.tracking ?? null;
  const details = tracking ? trackingCopy(locale).details : undefined;
  const onSelect = selectStatus(next => void choose(next), tracking ? () => { setDetailsAsked(true); setDetailsOpen(true); } : undefined);
  const sheet = tracking && detailsAsked ? <Suspense fallback={null}>
    <TrackingSheet work={work} title={title} api={tracking} locale={locale} open={detailsOpen} onOpenChange={setDetailsOpen} />
  </Suspense> : null;
  const failure = state === 'failed'
    ? <p role="status" className="text-destructive-foreground text-xs">{t.saveFailed}</p> : null;
  if (status) {
    return <div className={cn('grid gap-1.5', className)}>
      <Menu onSelect={onSelect}>
        <MenuTrigger className={cn(buttonVariants({ size, variant: 'outline', pill: true }), 'w-full')}
          aria-label={`${statusLabel(status, t, words)} — ${t.shelve({ title })}`} aria-busy={state === 'saving' || undefined}>
          <CheckIcon aria-hidden="true" className="text-primary" />{statusLabel(status, t, words)}
          <ChevronDownIcon aria-hidden="true" className="ms-auto" />
        </MenuTrigger>
        <MenuContent className="w-56"><StatusMenuItems status={status} t={t} words={words} details={details} /></MenuContent>
      </Menu>
      {failure}
      {sheet}
    </div>;
  }
  return <div className={cn('grid gap-1.5', className)}>
    <ButtonGroup className="w-full">
      <Button size={size} variant={variant} className="flex-1 rounded-s-full" isLoading={state === 'saving'}
        onClick={() => void choose('want-to-read')}>
        <BookmarkPlusIcon aria-hidden="true" />{words?.wantToRead ?? t.wantToRead}</Button>
      <Menu onSelect={onSelect}>
        <MenuTrigger aria-label={t.shelfOptions}
          className={cn(buttonVariants({ variant, size: size === 'lg' ? 'icon-lg' : size === 'md' ? 'icon-md' : 'icon-sm' }),
            'w-11 flex-none rounded-e-full', variant === 'default' && 'border-s border-s-primary-foreground/25')}>
          <ChevronDownIcon aria-hidden="true" /></MenuTrigger>
        <MenuContent className="w-56"><StatusMenuItems status={status} t={t} words={words} details={details} /></MenuContent>
      </Menu>
    </ButtonGroup>
    {failure}
    {sheet}
  </div>;
}

/** Inline stars for the reader's own rating of a Work. Signed out, they lead to sign-in. */
export function RateWork({ work, locale, className }: { work: string; locale: UiLocale; className?: string }) {
  const t = materializeData(messages[locale], { locale });
  const actions = useReaderActions();
  const own = actions.kind === 'ready' ? actions.stateOf(work) : null;
  const known = own?.rating ?? null;
  const newest = useRef(0);
  const [pending, setPending] = useState<{ value: number | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const value = pending ? pending.value : known;
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
    const mine = ++newest.current;
    setPending({ value: next });
    setFailed(false);
    const saved = await rate(work, next).catch(() => false);
    if (mine !== newest.current) return;
    // Admitted but not yet applied, the store keeps the choice as pending and says when it settles; refused, the known value shows again.
    setPending(null);
    setFailed(!saved);
  }
  return <div className={cn('grid justify-items-center gap-1', className)}>
    <Rating size="lg" count={actions.ratingMax === 10 ? 10 : 5} value={value ?? 0} className="items-center"
      onValueChange={({ value: next }) => void save(next)}>
      <RatingLabel className="order-last font-normal text-muted-foreground text-sm">
        {value ? t.yourRating : t.rateThis}</RatingLabel>
    </Rating>
    {failed ? <p role="status" className="text-destructive-foreground text-xs">{t.saveFailed}</p>
      : own?.ratingWrite === 'pending' ? <p role="status" className="text-muted-foreground text-xs">{t.saving}</p>
        : own?.ratingWrite === 'unsettled'
          ? <p role="status" className="flex flex-wrap items-center justify-center gap-x-2 text-muted-foreground text-xs">
            {t.ratingProcessing}
            {actions.refresh ? <Button size="sm" variant="link" onClick={() => void actions.refresh?.(work)}>{t.refresh}</Button> : null}
          </p> : null}
  </div>;
}
