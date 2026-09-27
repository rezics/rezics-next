'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { cn } from '@rezics/ui/utils';
import { ArrowBigDownIcon, ArrowBigUpIcon, BellOffIcon, BookOpenIcon, CheckIcon, CopyIcon, DownloadIcon,
  EllipsisIcon, EyeOffIcon, MessageCircleIcon, MessageSquareQuoteIcon, Share2Icon, ThumbsDownIcon, Undo2Icon,
  VolumeXIcon } from 'lucide-react';
import { useState } from 'react';
import { ShelfButton } from '../catalogue/reader-actions.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { commandKey } from './api.ts';
import { useFeed } from './feed-context.tsx';
import type { FeedbackKind, FeedbackStrength, FeedItem, Vote } from './types.ts';

const pill = 'inline-flex h-9 items-center gap-1.5 rounded-full px-3 font-medium text-muted-foreground text-sm '
  + 'outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 '
  + 'focus-visible:ring-ring';

/**
 * Up, score, down. The vote shows at once and settles on Main's receipt; a
 * refused vote returns to what Main last had and says so. Signed out, both
 * arrows lead to sign-in.
 */
function VoteControl({ item }: { item: FeedItem }) {
  const { t, locale, api, signedIn, actingSubject, signInHref } = useFeed();
  const [state, setState] = useState({ vote: item.vote, score: item.score, revision: item.voteRevision });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const score = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(state.score);
  const arrow = 'grid size-8 place-items-center rounded-full outline-none transition-colors '
    + 'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring';
  if (!signedIn || !actingSubject) {
    // Signed out, the arrows lead to sign-in; signed in without an Agent to act as, only the score shows.
    const arrowFor = (label: string, Icon: typeof ArrowBigUpIcon) => signedIn
      ? <span aria-hidden="true" className="grid size-8 place-items-center">
        <Icon className="size-5 text-muted-foreground/60" /></span>
      : <a href={signInHref} aria-label={`${label} — ${t.signInToTakePart}`} className={arrow}>
        <Icon aria-hidden="true" className="size-5 text-muted-foreground" /></a>;
    return <div className="inline-flex items-center rounded-full bg-muted/70">
      {arrowFor(t.upvote, ArrowBigUpIcon)}
      <span className="min-w-6 text-center font-semibold text-sm tabular-nums" aria-label={t.score(state.score)}>
        {score}</span>
      {arrowFor(t.downvote, ArrowBigDownIcon)}
    </div>;
  }
  async function cast(direction: Exclude<Vote, 0>) {
    const value: Vote = state.vote === direction ? 0 : direction;
    const before = state;
    setState({ ...state, vote: value, score: state.score - state.vote + value });
    setBusy(true);
    setFailed(false);
    const receipt = await api().vote(item.id, { value, expectedRevision: before.revision,
      actingSubject: actingSubject! }, commandKey());
    if (receipt.ok) setState({ vote: receipt.data.value, score: receipt.data.score, revision: receipt.data.revision });
    else { setState(before); setFailed(true); }
    setBusy(false);
  }
  return <div className="inline-flex items-center gap-1">
    <div aria-busy={busy || undefined} className={cn('inline-flex items-center rounded-full bg-muted/70',
      state.vote === 1 && 'bg-brand/10', state.vote === -1 && 'bg-vote-down/10')}>
      <button type="button" aria-label={t.upvote} aria-pressed={state.vote === 1} disabled={busy}
        onClick={() => void cast(1)} className={arrow}>
        <ArrowBigUpIcon aria-hidden="true" className={cn('size-5', state.vote === 1
          ? 'fill-brand text-brand' : 'text-muted-foreground')} /></button>
      <span className="min-w-6 text-center font-semibold text-sm tabular-nums" aria-label={t.score(state.score)}
        aria-live="polite">{score}</span>
      <button type="button" aria-label={t.downvote} aria-pressed={state.vote === -1} disabled={busy}
        onClick={() => void cast(-1)} className={arrow}>
        <ArrowBigDownIcon aria-hidden="true" className={cn('size-5', state.vote === -1
          ? 'fill-vote-down text-vote-down' : 'text-muted-foreground')} /></button>
    </div>
    {failed ? <p role="status" className="text-destructive-foreground text-xs">{t.voteFailed}</p> : null}
  </div>;
}

/** The one action that fits what the post is about: read, install, use, or put on a shelf. */
function PrimaryAction({ item, title }: { item: FeedItem; title: string }) {
  const { t, locale } = useFeed();
  const action = item.primaryAction;
  const link = (href: string, icon: typeof BookOpenIcon, label: string) => {
    const Icon = icon;
    return <LocalizedLink href={href} className={cn(buttonVariants({ size: 'sm', variant: 'soft' }), 'rounded-full')}>
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
      className="w-auto" />;
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

/** Share, beside the other actions from `sm` up; on phones it lives in the post's menu so the bar fits one row. */
function ShareButton({ href, title }: { href: string; title: string }) {
  const { t, locale } = useFeed();
  const [copied, setCopied] = useState(false);
  return <button type="button" onClick={() => void sharePage(href, title, locale).then(done => setCopied(done === 'copied'))}
    className={cn(pill, 'max-sm:hidden')}>
    {copied ? <CheckIcon aria-hidden="true" className="size-4 text-success-foreground" />
      : <Share2Icon aria-hidden="true" className="size-4" />}
    {copied ? t.linkCopied : t.share}
    {copied ? <span role="status" className="sr-only">{t.linkCopied}</span> : null}
  </button>;
}

/** What the reader asked Main to stop showing, so the post can say so and offer Undo. */
export interface Dismissal {
  message: string;
  undo: { kind: FeedbackKind; target: string } | null;
}

function MoreMenu({ item, share, onDismiss }: { item: FeedItem; share: { href: string; title: string } | null;
  onDismiss: (dismissal: Dismissal) => void }) {
  const { t, api, actingSubject, locale } = useFeed();
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!actingSubject && !share) return null;
  const choices = !actingSubject ? [] : feedbackChoices(item, t);
  async function choose(value: string) {
    if (value === 'share' && share) {
      setCopied(await sharePage(share.href, share.title, locale) === 'copied');
      return;
    }
    const choice = choices.find(item => item.value === value);
    if (!choice || !actingSubject) return;
    setFailed(false);
    const result = await api().feedback({ actingSubject, kind: choice.kind, target: choice.target,
      strength: choice.strength }, commandKey());
    if (result.ok) onDismiss({ message: choice.done, undo: { kind: choice.kind, target: choice.target } });
    else setFailed(true);
  }
  return <>
    <Menu onSelect={({ value }) => void choose(value)}>
      <MenuTrigger aria-label={t.moreOptions} title={t.moreOptions}
        className={cn(pill, 'w-9 justify-center px-0', !actingSubject && 'sm:hidden')}>
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuContent className="w-64">
        {share ? <MenuItem value="share" className="sm:hidden"><Share2Icon aria-hidden="true" />{t.share}</MenuItem> : null}
        {share && choices.length ? <MenuSeparator className="sm:hidden" /> : null}
        {choices.map((choice, index) => <span key={choice.value} className="contents">
          {index === 2 ? <MenuSeparator /> : null}
          <MenuItem value={choice.value}><choice.icon aria-hidden="true" />{choice.label}</MenuItem>
        </span>)}
      </MenuContent>
    </Menu>
    {copied ? <p role="status" className="text-muted-foreground text-xs">{t.linkCopied}</p> : null}
    {failed ? <p role="status" className="text-destructive-foreground text-xs">{t.feedbackFailed}</p> : null}
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

/** The row under every post: vote, comments, the kind's action, share and more. */
export function EngagementBar({ item, title, href, onDismiss }: {
  item: FeedItem; title: string; href: string | null; onDismiss: (dismissal: Dismissal) => void;
}) {
  const { t, locale } = useFeed();
  const comments = item.target.work ? item.links.comments : null;
  const count = new Intl.NumberFormat(locale, { notation: 'compact' }).format(item.comments.value);
  const commentLabel = item.comments.kind === 'exact' ? t.comments(item.comments.value)
    : t.commentsAtLeast(item.comments.value);
  return <div role="group" aria-label={t.actions} className="-ms-1 flex flex-wrap items-center gap-1.5">
    <VoteControl item={item} />
    {comments ? <LocalizedLink href={comments} aria-label={commentLabel} className={pill}>
      <MessageCircleIcon aria-hidden="true" className="size-4" />
      <span aria-hidden="true" className="tabular-nums">{count}{item.comments.kind === 'exact' ? '' : '+'}</span>
    </LocalizedLink> : null}
    <PrimaryAction item={item} title={title} />
    {href ? <ShareButton href={href} title={title} /> : null}
    <MoreMenu item={item} share={href ? { href, title } : null} onDismiss={onDismiss} />
  </div>;
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

/** Join a Realm from one of its posts. Shown only where the reader is known not to follow it. */
export function JoinButton({ realm }: { realm: NonNullable<FeedItem['realm']> }) {
  const { t, api, signedIn, actingSubject, signInHref, realmState, markJoined } = useFeed();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [joinedHere, setJoinedHere] = useState(false);
  const label = t.joinRealm({ realm: realm.name.value });
  const joinClass = cn(buttonVariants({ size: 'xs', variant: 'soft' }), 'relative z-10 h-7 shrink-0 rounded-full px-3');
  if (!signedIn) {
    return <a href={signInHref} aria-label={`${label} — ${t.signInToTakePart}`} className={joinClass}>{t.join}</a>;
  }
  if (joinedHere) {
    return <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 font-medium
      text-muted-foreground text-xs"><CheckIcon aria-hidden="true" className="size-3.5" />{t.joined}</span>;
  }
  if (!actingSubject || realmState(realm.id) !== 'join') return null;
  async function join() {
    setBusy(true);
    setFailed(false);
    const result = await api().follow(realm.id, 'realm', true, actingSubject!, commandKey());
    setBusy(false);
    if (!result.ok) { setFailed(true); return; }
    markJoined(realm.id, result.data.following);
    setJoinedHere(result.data.following);
  }
  return <>
    {failed ? <span role="status" className="text-destructive-foreground text-xs">{t.joinFailed}</span> : null}
    <Button size="xs" variant="soft" aria-label={label} isLoading={busy} onClick={() => void join()}
      className="relative z-10 h-7 shrink-0 rounded-full px-3">{t.join}</Button>
  </>;
}
