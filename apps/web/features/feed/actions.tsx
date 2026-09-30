'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { ArrowBigDownIcon, ArrowBigUpIcon, BellOffIcon, BookOpenIcon, CheckIcon, CopyIcon, DownloadIcon,
  EllipsisIcon, EyeOffIcon, MessageSquareQuoteIcon, Share2Icon, ThumbsDownIcon, Undo2Icon,
  VolumeXIcon } from 'lucide-react';
import { useState } from 'react';
import { ShelfButton } from '../catalogue/reader-actions.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { commandKey } from './api.ts';
import { useFeed } from './feed-context.tsx';
import { barAction } from './post-row.tsx';
import type { FeedbackKind, FeedbackStrength, FeedItem, Vote } from './types.ts';

/** What a vote acts on: a feed activity (a post, a discussion or a reply's placement) and its standing. */
export interface VoteTarget {
  id: string; vote: Vote; score: number; revision: string | null;
  /** False where Main takes no vote on it; the score still shows. */
  open?: boolean;
}

/**
 * Up, score, down. The vote shows at once and settles on Main's receipt; a
 * refused vote returns to what Main last had and says so. Signed out, both
 * arrows lead to sign-in. `plain` drops the pill for dense rows such as replies.
 */
export function VoteControl({ target, plain = false }: { target: VoteTarget; plain?: boolean }) {
  const { t, locale, api, signedIn, actingSubject, signInHref } = useFeed();
  const [state, setState] = useState({ vote: target.vote, score: target.score, revision: target.revision });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const score = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(state.score);
  const arrow = cn('grid place-items-center rounded-full outline-none transition-colors hover:bg-accent '
    + 'focus-visible:ring-2 focus-visible:ring-ring', plain ? 'size-7' : 'size-8');
  const frame = cn('inline-flex items-center rounded-full', !plain && 'bg-muted/70');
  const count = <span className="min-w-6 text-center font-semibold text-sm tabular-nums" aria-label={t.score(state.score)}
    aria-live="polite">{score}</span>;
  if (!signedIn || !actingSubject || target.open === false) {
    // Signed out, the arrows lead to sign-in; without an Agent to act as, or where Main takes no vote, only the score shows.
    const arrowFor = (label: string, Icon: typeof ArrowBigUpIcon) => signedIn || target.open === false
      ? <span aria-hidden="true" className={cn('grid place-items-center', plain ? 'size-7' : 'size-8')}>
        <Icon className="size-5 text-muted-foreground/50" /></span>
      : <a href={signInHref} aria-label={`${label} — ${t.signInToTakePart}`} className={arrow}>
        <Icon aria-hidden="true" className="size-5 text-muted-foreground" /></a>;
    return <div className={frame} title={target.open === false ? t.votesClosed : undefined}>
      {arrowFor(t.upvote, ArrowBigUpIcon)}{count}{arrowFor(t.downvote, ArrowBigDownIcon)}
    </div>;
  }
  async function cast(direction: Exclude<Vote, 0>) {
    const value: Vote = state.vote === direction ? 0 : direction;
    const before = state;
    setState({ ...state, vote: value, score: state.score - state.vote + value });
    setBusy(true);
    setFailed(false);
    const receipt = await api().vote(target.id, { value, expectedRevision: before.revision,
      actingSubject: actingSubject! }, commandKey());
    if (receipt.ok) setState({ vote: receipt.data.value, score: receipt.data.score, revision: receipt.data.revision });
    else { setState(before); setFailed(true); }
    setBusy(false);
  }
  return <div className="inline-flex items-center gap-1">
    <div aria-busy={busy || undefined} className={cn(frame, !plain && state.vote === 1 && 'bg-brand/10',
      !plain && state.vote === -1 && 'bg-vote-down/10')}>
      <button type="button" aria-label={t.upvote} aria-pressed={state.vote === 1} disabled={busy}
        onClick={() => void cast(1)} className={arrow}>
        <ArrowBigUpIcon aria-hidden="true" className={cn('size-5', state.vote === 1
          ? 'fill-brand text-brand' : 'text-muted-foreground')} /></button>
      {count}
      <button type="button" aria-label={t.downvote} aria-pressed={state.vote === -1} disabled={busy}
        onClick={() => void cast(-1)} className={arrow}>
        <ArrowBigDownIcon aria-hidden="true" className={cn('size-5', state.vote === -1
          ? 'fill-vote-down text-vote-down' : 'text-muted-foreground')} /></button>
    </div>
    {failed ? <p role="status" className="text-destructive-foreground text-xs">{t.voteFailed}</p> : null}
  </div>;
}

/** The one action that fits what the post is about: read, install, use, or put on a shelf. */
export function PrimaryAction({ item, title }: { item: FeedItem; title: string }) {
  const { t, locale } = useFeed();
  const action = item.primaryAction;
  const link = (href: string, icon: typeof BookOpenIcon, label: string) => {
    const Icon = icon;
    return <LocalizedLink href={href} className={cn(buttonVariants({ size: 'sm', variant: 'soft' }),
      'ms-1 h-7 rounded-full px-3')}>
      <Icon aria-hidden="true" />{label}</LocalizedLink>;
  };
  switch (action.kind) {
    case 'read-chapter': {
      const number = item.card.kind === 'chapter' && item.card.number !== undefined
        ? new Intl.NumberFormat(locale).format(item.card.number) : null;
      return link(action.href, BookOpenIcon, number ? t.readChapter({ number }) : t.read);
    }
    case 'next-unread': return link(action.href, BookOpenIcon, t.continueReading);
    case 'install': return link(action.href, DownloadIcon, t.install);
    case 'copy-prompt': return link(action.href, CopyIcon, t.usePrompt);
    case 'want-to-read': return <ShelfButton work={action.work} title={title} locale={locale} size="sm" variant="outline"
      className="ms-1 w-auto [&_a]:h-7 [&_button]:h-7" />;
    case 'read-review': return link(action.href, MessageSquareQuoteIcon, t.readReview);
    case 'open': return null;
  }
}

/** Shares a page: the system share sheet where there is one, otherwise a copied link. */
async function sharePage(href: string, title: string, locale: string): Promise<'shared' | 'copied' | 'failed'> {
  const url = new URL(href.startsWith(`/${locale}/`) ? href : `/${locale}${href}`, location.origin).toString();
  if (typeof navigator.share === 'function') {
    return navigator.share({ title, url }).then(() => 'shared' as const, () => 'failed' as const);
  }
  return navigator.clipboard.writeText(url).then(() => 'copied' as const, () => 'failed' as const);
}

/** Share: the system share sheet where there is one, otherwise a copied link. A bare icon, as the bar's others. */
export function ShareButton({ href, title }: { href: string; title: string }) {
  const { t, locale } = useFeed();
  const [copied, setCopied] = useState(false);
  return <button type="button" aria-label={copied ? t.linkCopied : t.share} title={t.share}
    onClick={() => void sharePage(href, title, locale).then(done => setCopied(done === 'copied'))}
    className={cn(barAction, 'w-8 justify-center px-0')}>
    {copied ? <CheckIcon aria-hidden="true" className="text-success-foreground" />
      : <Share2Icon aria-hidden="true" />}
    {copied ? <span role="status" className="sr-only">{t.linkCopied}</span> : null}
  </button>;
}

/** What the reader asked Main to stop showing, so the post can say so and offer Undo. */
export interface Dismissal {
  message: string;
  undo: { kind: FeedbackKind; target: string } | null;
}

export function MoreMenu({ item, onDismiss }: { item: FeedItem; share?: { href: string; title: string } | null;
  onDismiss: (dismissal: Dismissal) => void }) {
  const { t, api, actingSubject } = useFeed();
  const [failed, setFailed] = useState(false);
  if (!actingSubject) return null;
  const choices = feedbackChoices(item, t);
  async function choose(value: string) {
    const choice = choices.find(item => item.value === value);
    if (!choice || !actingSubject) return;
    setFailed(false);
    const result = await api().feedback({ actingSubject, kind: choice.kind, target: choice.target,
      strength: choice.strength }, commandKey());
    if (result.ok) onDismiss({ message: choice.done, undo: { kind: choice.kind, target: choice.target } });
    else setFailed(true);
  }
  return <>
    {failed ? <p role="status" className="text-destructive-foreground text-xs">{t.feedbackFailed}</p> : null}
    <Menu onSelect={({ value }) => void choose(value)}>
      <MenuTrigger aria-label={t.moreOptions} title={t.moreOptions} className={cn(barAction, 'size-7 justify-center px-0')}>
        <EllipsisIcon aria-hidden="true" />
      </MenuTrigger>
      <MenuContent className="w-64">
        {choices.map((choice, index) => <span key={choice.value} className="contents">
          {index === 2 ? <MenuSeparator /> : null}
          <MenuItem value={choice.value}><choice.icon aria-hidden="true" />{choice.label}</MenuItem>
        </span>)}
      </MenuContent>
    </Menu>
  </>;
}

type T = ReturnType<typeof useFeed>['t'];

/** Hide, not interested, fewer or mute: Main's feedback kinds, in the words the menu uses. */
function feedbackChoices(item: FeedItem, t: T) {
  const choices: { value: string; label: string; icon: typeof EyeOffIcon; kind: FeedbackKind; target: string;
    strength: FeedbackStrength; done: string }[] = [
    { value: 'hide', label: t.hide, icon: EyeOffIcon, kind: 'activity', target: item.id, strength: 'hide', done: t.hidden },
    ...(item.target.work ? [{ value: 'not-interested', label: t.notInterested, icon: ThumbsDownIcon, kind: 'work' as const,
      target: item.target.work, strength: 'hide' as const, done: t.notInterestedDone }] : []),
    ...(item.realm ? [
      { value: 'fewer', label: t.showFewer({ realm: item.realm.name.value }), icon: BellOffIcon, kind: 'realm' as const,
        target: item.realm.id, strength: 'fewer' as const, done: t.fewerFrom({ realm: item.realm.name.value }) },
      { value: 'mute-realm', label: t.muteRealm({ realm: item.realm.name.value }), icon: VolumeXIcon,
        kind: 'realm' as const, target: item.realm.id, strength: 'mute' as const,
        done: t.mutedName({ name: item.realm.name.value }) },
    ] : []),
    { value: 'mute-person', label: t.mutePerson({ name: item.actor.name }), icon: VolumeXIcon, kind: 'person',
      target: item.actor.id, strength: 'mute', done: t.mutedName({ name: item.actor.name }) },
  ];
  return choices;
}

/** A post the reader hid or muted: one line that says so, with Undo while the page is open. */
export function DismissedPost({ dismissal, onUndo }: { dismissal: Dismissal; onUndo: () => void }) {
  const { t, api, actingSubject } = useFeed();
  const [failed, setFailed] = useState(false);
  async function undo() {
    if (!dismissal.undo || !actingSubject) return;
    const result = await api().feedback({ actingSubject, ...dismissal.undo, strength: 'clear' }, commandKey());
    if (result.ok) onUndo();
    else setFailed(true);
  }
  return <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border/60 border-b
    bg-muted/40 px-4 py-3 text-muted-foreground text-sm">
    <span className="flex-1">{dismissal.message}</span>
    {failed ? <span className="text-destructive-foreground text-xs">{t.feedbackFailed}</span> : null}
    {dismissal.undo ? <Button variant="ghost" size="sm" onClick={() => void undo()}>
      <Undo2Icon aria-hidden="true" />{t.undo}</Button> : null}
  </div>;
}

/** Follow a Realm from one of its posts. Shown only where the reader is known not to follow it. */
export function FollowRealmButton({ realm }: { realm: NonNullable<FeedItem['realm']> }) {
  const { t, api, signedIn, actingSubject, signInHref, realmState, markFollowed } = useFeed();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [followedHere, setFollowedHere] = useState(false);
  const label = t.followRealm({ realm: realm.name.value });
  const followClass = cn(buttonVariants({ size: 'xs', variant: 'soft' }), 'relative z-10 h-7 shrink-0 rounded-full px-3');
  if (!signedIn) {
    return <a href={signInHref} aria-label={`${label} — ${t.signInToTakePart}`} className={followClass}>{t.follow}</a>;
  }
  if (followedHere) {
    return <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 font-medium
      text-muted-foreground text-xs"><CheckIcon aria-hidden="true" className="size-3.5" />{t.followed}</span>;
  }
  if (!actingSubject || realmState(realm.id) !== 'follow') return null;
  async function follow() {
    setBusy(true);
    setFailed(false);
    const result = await api().follow(realm.id, 'realm', true, actingSubject!, commandKey());
    setBusy(false);
    if (!result.ok) { setFailed(true); return; }
    markFollowed(realm.id, result.data.following);
    setFollowedHere(result.data.following);
  }
  return <>
    {failed ? <span role="status" className="text-destructive-foreground text-xs">{t.followFailed}</span> : null}
    <Button size="xs" variant="soft" aria-label={label} isLoading={busy} onClick={() => void follow()}
      className="relative z-10 h-7 shrink-0 rounded-full px-3">{t.follow}</Button>
  </>;
}
