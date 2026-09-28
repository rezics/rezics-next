'use client';

import { Button } from '@rezics/ui/button';
import { Textarea } from '@rezics/ui/textarea';
import { cn } from '@rezics/ui/utils';
import { CircleAlertIcon, LockIcon, LogInIcon, UsersRoundIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { useFeed } from './feed-context.tsx';
import { type ReplyInput, type ReplyProgress, replyProgress, type ThreadApi } from './thread-api.ts';

/** Main's longest reply body (`member-reply-draft-v1`). */
const MAX_REPLY = 8192;

/**
 * Whether the reader can reply here, decided from the Realm's review policy
 * and their membership: Main places a reply at once only for members of a
 * Realm that trusts them (or anyone in an open one). A Realm that reviews
 * every reply has no queue for them yet, so the composer says so instead of
 * taking words it cannot publish.
 */
export type ReplyMode = 'open' | 'sign-in' | 'join' | 'reviewed' | 'unavailable';

export interface ReplyTarget extends Omit<ReplyInput, 'parent' | 'body' | 'language' | 'actingSubject'> {
  mode: ReplyMode;
  /** The UI language the reply is written in. */
  language: string;
  api: () => ThreadApi;
}

/**
 * Write a reply to one reply or to the discussion. Once Main places it the
 * thread reads again and it takes its place; a Realm that refuses it says why.
 */
export function ReplyComposer({ target, parent, parentAuthor, inline = false, autoFocus = false, onDone, id }: {
  target: ReplyTarget;
  parent: ReplyInput['parent'];
  /** Whom an inline reply answers, for its label. */
  parentAuthor?: string;
  inline?: boolean; autoFocus?: boolean;
  onDone?: () => void;
  /** The anchor `#reply` links jump to. */
  id?: string;
}) {
  const { t, actingSubject, signInHref } = useFeed();
  const router = useRouter();
  const fieldId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(inline);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'idle' | 'failed' | 'refused' | 'posted'>('idle');
  const progress = useRef<ReplyProgress | null>(null);
  const label = parentAuthor ? t.replyTo({ name: parentAuthor }) : t.addComment;

  if (target.mode !== 'open' || !actingSubject) {
    const mode = target.mode === 'open' ? 'unavailable' : target.mode;
    if (inline && mode === 'sign-in') {
      return <a href={signInHref} className="text-primary text-sm underline-offset-4 hover:underline">{t.signInToReply}</a>;
    }
    const Icon = mode === 'sign-in' ? LogInIcon : mode === 'join' ? UsersRoundIcon : LockIcon;
    const text = mode === 'sign-in' ? t.signInToReply : mode === 'join' ? t.joinToReply
      : mode === 'reviewed' ? t.repliesReviewed : t.replyUnavailable;
    return <div id={id} className="flex scroll-mt-24 items-center gap-3 rounded-2xl border border-border/70 bg-muted/40
      px-4 py-3 text-muted-foreground text-sm">
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {mode === 'sign-in' ? <a href={signInHref} className="font-medium text-primary underline-offset-4
        hover:underline">{text}</a> : <p>{text}</p>}
    </div>;
  }

  const input = (body: string): ReplyInput => ({ realm: target.realm, work: target.work,
    rootRevision: target.rootRevision, parent, body, language: target.language, actingSubject: actingSubject! });
  // Once Main holds the words, they stay as sent until the reply is placed or taken back.
  const saved = Boolean(progress.current?.revisionId);

  async function send() {
    const body = text.trim();
    if (!body || busy || !actingSubject) return;
    setBusy(true);
    setState('idle');
    progress.current ??= replyProgress();
    const outcome = await target.api().reply(input(body), progress.current);
    setBusy(false);
    if (outcome.kind === 'failed') { progress.current = outcome.progress; setState('failed'); return; }
    progress.current = null;
    if (outcome.kind === 'refused') { setState('refused'); return; }
    setText('');
    setState('posted');
    if (!inline) setOpen(false);
    onDone?.();
    router.refresh();
  }

  const expanded = open || text.length > 0;
  return <form id={id} className={cn('grid scroll-mt-24 gap-2', !inline && 'rounded-2xl')}
    onSubmit={event => { event.preventDefault(); void send(); }}>
    <label htmlFor={fieldId} className="sr-only">{label}</label>
    <Textarea id={fieldId} value={text} maxLength={MAX_REPLY} autoFocus={autoFocus} disabled={busy}
      placeholder={inline ? label : t.joinConversation} rows={expanded ? 4 : 1}
      readOnly={saved} onFocus={() => setOpen(true)} onChange={event => setText(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send(); }}
      className={cn('bg-background', !expanded && 'min-h-11 py-2.5')} />
    {expanded ? <div className="flex flex-wrap items-center justify-end gap-2">
      {text.length > MAX_REPLY - 500 ? <span className="me-auto text-muted-foreground text-xs tabular-nums">
        {t.charactersLeft(MAX_REPLY - text.length)}</span> : null}
      <Button type="button" variant="ghost" size="sm" pill disabled={busy} onClick={() => {
        if (progress.current) void target.api().withdraw(input(text.trim()), progress.current);
        setText(''); setOpen(false); setState('idle'); progress.current = null; onDone?.();
      }}>{t.cancel}</Button>
      <Button type="submit" size="sm" pill isLoading={busy} disabled={!text.trim()}>
        {inline ? t.replyAction : t.comment}</Button>
    </div> : null}
    {state === 'failed' ? <p role="alert" className="flex items-center gap-2 text-destructive-foreground text-sm">
      <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0" />{t.replyFailed}</p> : null}
    {state === 'refused' ? <p role="alert" className="flex items-center gap-2 text-warning-foreground text-sm">
      <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0" />{t.replyRefused}</p> : null}
    {state === 'posted' ? <p role="status" className="text-muted-foreground text-sm">{t.replyPosted}</p> : null}
  </form>;
}
