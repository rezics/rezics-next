'use client';

import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { cn } from '@rezics/ui/utils';
import { CircleAlertIcon, LockIcon, LogInIcon, UsersRoundIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { textAttributes, writingLanguage } from '../content-language/writing-language.ts';
import { useFeed } from './feed-context.tsx';
import {
  type ReplyInput,
  type ReplyProgress,
  replyProgress,
  type ThreadApi,
} from './thread-api.ts';
import { BodyEditor } from '../document-editor/body-editor.tsx';
import { bodyText, hasBodyContent } from '../document-editor/body.ts';

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

export interface ReplyTarget extends Omit<
  ReplyInput,
  'parent' | 'body' | 'language' | 'actingSubject'
> {
  mode: ReplyMode;
  api: () => ThreadApi;
}

/**
 * Write a reply to one reply or to the discussion. Once Main places it the
 * thread reads again and it takes its place; a Realm that refuses it says why.
 */
export function ReplyComposer({
  target,
  parent,
  parentAuthor,
  inline = false,
  autoFocus = false,
  onDone,
  id,
}: {
  target: ReplyTarget;
  parent: ReplyInput['parent'];
  /** Whom an inline reply answers, for its label. */
  parentAuthor?: string;
  inline?: boolean;
  autoFocus?: boolean;
  onDone?: () => void;
  /** The anchor `#reply` links jump to. */
  id?: string;
}) {
  const { t, locale, actingSubject, signInHref } = useFeed();
  const router = useRouter();
  const spoilerId = useId();
  const [text, setText] = useState('');
  const [spoiler, setSpoiler] = useState(false);
  const [open, setOpen] = useState(inline);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'idle' | 'failed' | 'refused' | 'posted'>('idle');
  const progress = useRef<ReplyProgress | null>(null);
  const sentParent = useRef(parent);
  if (!progress.current) sentParent.current = parent;
  const storageKey = actingSubject
    ? `rezics:reply-draft:${actingSubject}:${target.realm}:${parent.reply}`
    : null;
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  // The writer's choice, or their first reading language; the interface language is never the answer.
  const [chosen, setChosen] = useState<string | null>(null);
  const reading = useReadingLanguages(actingSubject);
  const language = writingLanguage({ chosen, reading });
  const projection = bodyText(text);
  const written = textAttributes(language, projection);
  const label = parentAuthor ? t.replyTo({ name: parentAuthor }) : t.addComment;

  useEffect(() => {
    progress.current = null;
    setText('');
    setChosen(null);
    setSpoiler(false);
    if (storageKey) {
      try {
        const draft: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        if (
          draft &&
          typeof draft === 'object' &&
          'body' in draft &&
          typeof draft.body === 'string'
        ) {
          setText(draft.body);
          if ('language' in draft && typeof draft.language === 'string') setChosen(draft.language);
          if ('spoiler' in draft && draft.spoiler === true) setSpoiler(true);
          if (
            'progress' in draft &&
            draft.progress &&
            typeof draft.progress === 'object' &&
            ['key', 'reply', 'variantId'].every(
              (key) => typeof (draft.progress as Record<string, unknown>)[key] === 'string',
            )
          ) {
            progress.current = draft.progress as ReplyProgress;
            if ('parentRevision' in draft && typeof draft.parentRevision === 'string') {
              sentParent.current = { ...parent, revisionId: draft.parentRevision };
            }
          }
          if (draft.body || ('spoiler' in draft && draft.spoiler === true) || progress.current) setOpen(true);
        }
      } catch {
        /* An unavailable or malformed local draft does not prevent writing. */
      }
    }
    setHydratedKey(storageKey);
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey || hydratedKey !== storageKey) return;
    try {
      if (!text && !spoiler && !progress.current) localStorage.removeItem(storageKey);
      else
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            body: text,
            language: chosen,
            spoiler,
            progress: progress.current,
            parentRevision: sentParent.current.revisionId,
          }),
        );
    } catch {
      /* Local drafts are optional when storage is unavailable. */
    }
  }, [text, chosen, spoiler, storageKey, hydratedKey, busy, state]);

  if (target.mode !== 'open' || !actingSubject) {
    const mode = target.mode === 'open' ? 'unavailable' : target.mode;
    if (inline && mode === 'sign-in') {
      return (
        <a href={signInHref} className="text-primary text-sm underline-offset-4 hover:underline">
          {t.signInToReply}
        </a>
      );
    }
    const Icon = mode === 'sign-in' ? LogInIcon : mode === 'join' ? UsersRoundIcon : LockIcon;
    const text =
      mode === 'sign-in'
        ? t.signInToReply
        : mode === 'join'
          ? t.joinToReply
          : mode === 'reviewed'
            ? t.repliesReviewed
            : t.replyUnavailable;
    return (
      <div
        id={id}
        className="flex scroll-mt-24 items-center gap-3 rounded-2xl border border-border/70 bg-muted/40
      px-4 py-3 text-muted-foreground text-sm"
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {mode === 'sign-in' ? (
          <a
            href={signInHref}
            className="font-medium text-primary underline-offset-4
        hover:underline"
          >
            {text}
          </a>
        ) : (
          <p>{text}</p>
        )}
      </div>
    );
  }

  const input = (body: string): ReplyInput => ({
    realm: target.realm,
    work: target.work,
    rootRevision: target.rootRevision,
    parent: progress.current ? sentParent.current : parent,
    body,
    language,
    spoiler,
    actingSubject: actingSubject!,
  });
  // Once Main holds the words, they stay as sent until the reply is placed or taken back.
  const saved = Boolean(progress.current?.revisionId);

  async function send() {
    const body = text;
    if (!hasBodyContent(body) || projection.length > MAX_REPLY || busy || !actingSubject) return;
    setBusy(true);
    setState('idle');
    setChosen(language);
    progress.current ??= replyProgress();
    let outcome;
    try {
      outcome = await target.api().reply(input(body), progress.current);
    } catch {
      setBusy(false);
      setState('failed');
      return;
    }
    setBusy(false);
    if (outcome.kind === 'failed') {
      progress.current = outcome.progress;
      setState('failed');
      return;
    }
    progress.current = null;
    if (outcome.kind === 'refused') {
      setState('refused');
      return;
    }
    setText('');
    setChosen(null);
    setSpoiler(false);
    setState('posted');
    if (!inline) setOpen(false);
    onDone?.();
    router.refresh();
  }

  const expanded = open || hasBodyContent(text);
  return (
    <form
      id={id}
      className={cn('grid scroll-mt-24 gap-2', !inline && 'rounded-2xl')}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <BodyEditor
        actingSubject={actingSubject ?? undefined}
        mediaTarget={target.work}
        label={label}
        value={text}
        onChange={setText}
        maxLength={MAX_REPLY}
        locale={locale}
        legacyMarkdown
        autoFocus={autoFocus}
        disabled={busy}
        placeholder={inline ? label : t.joinConversation}
        compact
        readOnly={saved}
        onFocus={() => setOpen(true)}
        lang={written.lang}
        dir={written.dir}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send();
        }}
        className={cn('bg-background', !expanded && 'min-h-11 py-2.5')}
      />
      {expanded ? (
        <>
          <div className="flex items-start gap-3 text-sm">
            <Checkbox
              id={spoilerId}
              checked={spoiler}
              disabled={busy || saved}
              onCheckedChange={(details) => setSpoiler(details.checked === true)}
              aria-label={t.markSpoiler}
            />
            <label htmlFor={spoilerId} className="grid gap-0.5">
              <span className="font-medium">{t.markSpoiler}</span>
              <span className="text-muted-foreground">{t.markSpoilerHelp}</span>
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
          <LanguageSelect
            value={language}
            onChange={setChosen}
            locale={locale}
            reading={reading}
            disabled={busy || saved}
            className="me-auto"
          />
          {projection.length > MAX_REPLY - 500 ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {t.charactersLeft(MAX_REPLY - projection.length)}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            pill
            disabled={busy}
            onClick={() => {
              if (progress.current) void target.api().withdraw(input(text), progress.current);
              setText('');
              setChosen(null);
              setSpoiler(false);
              setOpen(false);
              setState('idle');
              progress.current = null;
              onDone?.();
            }}
          >
            {t.cancel}
          </Button>
          <Button
            type="submit"
            size="sm"
            pill
            isLoading={busy}
            disabled={!hasBodyContent(text) || projection.length > MAX_REPLY}
          >
            {inline ? t.replyAction : t.comment}
          </Button>
          </div>
        </>
      ) : null}
      {state === 'failed' ? (
        <p role="alert" className="flex items-center gap-2 text-destructive-foreground text-sm">
          <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
          {t.replyFailed}
        </p>
      ) : null}
      {state === 'refused' ? (
        <p role="alert" className="flex items-center gap-2 text-warning-foreground text-sm">
          <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
          {t.replyRefused}
        </p>
      ) : null}
      {state === 'posted' ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t.replyPosted}
        </p>
      ) : null}
    </form>
  );
}
