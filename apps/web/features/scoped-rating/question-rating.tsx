'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Rating, RatingLabel } from '@rezics/ui/rating';
import { cn } from '@rezics/ui/utils';
import { MessageSquareIcon, PenLineIcon } from 'lucide-react';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { identityHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import Link from '../shell/localized-link.tsx';
import type { QuestionScope, ScopedRatingApi } from './api.ts';
import { Distribution, Mean } from '../work-page/ratings.tsx';
import { FailureNote, failureText } from './failure.tsx';
import { formatNumber, translate } from './format.ts';
import type { ScopedRatingMessages } from './messages.ts';
import { figuresOfRating } from './score.ts';
import type { Failure, Outcome, Question, TargetRating } from './types.ts';
import { useLoad } from './use-load.ts';

/** Who is looking: a signed-out reader is sent to sign in where a signed-in one rates. */
export type Viewer = { kind: 'signed-out'; signInHref: string } | { kind: 'reader' };

/**
 * Where the review and the discussion of a rated place live; the host's pages decide, and a null says there is none.
 * Whether there is one must not depend on the target: a place nobody has rated yet is asked with the question's own IRI
 * as a stand-in, only to learn whether an entry exists.
 */
export type EntryHref = (entry: 'review' | 'discussion', target: string, question: string) => string | null;

/** Default: the place's own page, at the sections that hold its reviews and its discussion. */
export const defaultEntryHref = (locale: UiLocale): EntryHref => (entry, target) =>
  `${localizedPath(identityHref('/e/', target), locale)}#${entry === 'review' ? 'work-reviews' : 'discussion'}`;

type Saving = { state: 'idle' } | { state: 'saving' } | { state: 'saved'; pending: boolean } | { state: 'failed'; failure: Failure };

/** The question's own words, in their language and direction. */
export const questionText = (question: Question) =>
  ({ value: question.displayQuestion.value, language: question.displayQuestion.language,
    direction: question.displayQuestion.direction });

/**
 * One question asked of one rated place: the question, the place's own figures for it, the signed-in person's rating,
 * and the way on to a review and the discussion. Figures and the person's rating belong to this place and this
 * question only; nothing here averages across places.
 *
 * A `target` of null is a place that does not exist yet: it has no figures, and `open` creates it on the first rating,
 * review or discussion, so looking never leaves an empty place behind.
 */
export function QuestionRating({ api, target, open, question, scope, viewer, entryHref, level = 4, locale, messages, className }: {
  api: ScopedRatingApi; target: string | null; open?: () => Promise<Outcome<string>>; question: Question; scope: QuestionScope;
  viewer: Viewer; entryHref?: EntryHref; level?: 3 | 4; locale: UiLocale; messages: ScopedRatingMessages; className?: string;
}) {
  const Heading = `h${level}` as const;
  const t = translate(messages, locale);
  // The place once this question's first write created it; the figures and the rating are then read from it.
  const [opened, setOpened] = useState<string | null>(null);
  const place = target ?? opened;
  const [figures, reload] = useLoad<TargetRating | null>(() => place ? api.rating(place, question.context, scope)
    : Promise.resolve({ ok: true as const, data: null }), `${target}\n${question.context}\n${scope.kind === 'realm' ? scope.realm : 'global'}`);
  // The person's own rating comes from Main, so a new device or a cleared browser shows what they already gave.
  const signedIn = viewer.kind === 'reader';
  const [ownRead, reloadOwn] = useLoad(() => signedIn && place ? api.own(place, question.context) : Promise.resolve({ ok: true as const, data: { value: null } }),
    `${signedIn}\n${target}\n${question.context}`);
  const [changed, setChanged] = useState<{ value: number | null } | null>(null);
  const own = changed ? changed.value : ownRead.state === 'ready' ? ownRead.data.value : null;
  const [saving, setSaving] = useState<Saving>({ state: 'idle' });
  const text = questionText(question);
  const max = question.scale.max;
  const hrefFor = entryHref ?? defaultEntryHref(locale);
  const reviewHref = hrefFor('review', place ?? question.context, question.context);
  const discussHref = hrefFor('discussion', place ?? question.context, question.context);
  const [entering, setEntering] = useState(false);
  const busy = saving.state === 'saving' || entering;

  /** The place this question is asked of, created now if it does not exist yet; null where creating failed (and said so). */
  async function ensure(): Promise<string | null> {
    if (place) return place;
    const answer = await (open?.() ?? Promise.resolve({ ok: false as const, failure: 'unavailable' as const }))
      .catch(() => ({ ok: false as const, failure: 'unavailable' as const }));
    if (!answer.ok) { setSaving({ state: 'failed', failure: answer.failure }); return null; }
    setOpened(answer.data);
    return answer.data;
  }

  async function enter(entry: 'review' | 'discussion') {
    setEntering(true);
    const id = await ensure();
    const href = id ? hrefFor(entry, id, question.context) : null;
    if (href) window.location.assign(href.startsWith('/') ? localizedPath(href, locale) : href);
    else setEntering(false);
  }

  async function save(next: number | null) {
    // The input is read-only while a save runs; this keeps a second press from starting another all the same.
    if (busy) return;
    const before = changed;
    setChanged({ value: next });
    setSaving({ state: 'saving' });
    const id = await ensure();
    const answer = id ? await api.rate(id, question.context, next).catch(() => ({ ok: false as const, failure: 'unavailable' as const }))
      : null;
    if (!answer) { setChanged(before); return; }
    if (!answer.ok) {
      setChanged(before);
      setSaving({ state: 'failed', failure: answer.failure });
      // Another device may have rated meanwhile: read what Main holds, so the next press starts from it.
      if (answer.failure === 'conflict') { setChanged(null); reloadOwn(); }
      return;
    }
    setSaving({ state: 'saved', pending: answer.data.pending });
    reload();
  }

  const read = figures.state === 'ready' && figures.data ? figuresOfRating(figures.data) : null;
  return <section data-question={question.context} aria-label={text.value} className={cn('grid gap-3', className)}>
    <Heading lang={text.language} dir={text.direction} className="font-medium text-base leading-snug">{text.value}</Heading>
    {figures.state === 'loading' ? <p className="text-muted-foreground text-sm" aria-busy="true">{t.loading}</p>
      : figures.state === 'failed' ? <FailureNote failure={figures.failure} locale={locale} messages={messages} retry={reload} />
        : read ? <div className="grid gap-3">
          <Mean figures={read} size="sm" empty={t.noRatings} locale={locale} messages={messages} />
          <Distribution figures={read} locale={locale} messages={messages} />
        </div>
          : <p className="text-muted-foreground text-sm">{t.noRatings}</p>}

    {viewer.kind === 'signed-out'
      ? <Link href={viewer.signInHref} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'justify-self-start')}>
        {t.signInToRate}</Link>
      : ownRead.state === 'loading' ? <p className="text-muted-foreground text-sm" aria-busy="true">{t.loading}</p>
        : ownRead.state === 'failed' ? <FailureNote failure={ownRead.failure} locale={locale} messages={messages} retry={reloadOwn} />
          : <div className="grid justify-items-start gap-1.5">
        <Rating size="md" count={max} value={own ?? 0} readOnly={busy} className="items-start"
          onValueChange={({ value }) => { if (value >= 1 && value !== own) void save(value); }}>
          <RatingLabel className="font-normal text-muted-foreground text-sm">
            {own ? t.yourRatingValue({ value: formatNumber(own, locale), max: formatNumber(max, locale) }) : t.yourRating}
          </RatingLabel>
        </Rating>
        {own ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => void save(null)}>{t.removeRating}</Button> : null}
        <p role="status" aria-live="polite" className={cn('min-h-5 text-xs', saving.state === 'failed' ? 'text-destructive-foreground' : 'text-muted-foreground')}>
          {saving.state === 'saving' ? t.saving
            : saving.state === 'saved' ? (saving.pending ? t.savedPending : t.saved)
              : saving.state === 'failed' ? (saving.failure === 'conflict' ? t.saveConflict : saving.failure === 'sign-in' ? t.failSignIn
                : saving.failure === 'denied' ? t.failDenied
                  : saving.failure === 'work-mismatch' || saving.failure === 'invalid' || saving.failure === 'missing' ? failureText(saving.failure, t) : t.saveFailed) : null}
        </p>
      </div>}

    {reviewHref || discussHref ? <div className="flex flex-wrap gap-2">
      {reviewHref ? place ? <Link href={reviewHref} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
        <PenLineIcon aria-hidden="true" />{t.writeReview}</Link>
        : <Button size="sm" variant="ghost" disabled={busy} onClick={() => void enter('review')}>
          <PenLineIcon aria-hidden="true" />{t.writeReview}</Button> : null}
      {discussHref ? place ? <Link href={discussHref} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
        <MessageSquareIcon aria-hidden="true" />{t.discuss}</Link>
        : <Button size="sm" variant="ghost" disabled={busy} onClick={() => void enter('discussion')}>
          <MessageSquareIcon aria-hidden="true" />{t.discuss}</Button> : null}
    </div> : null}
  </section>;
}

/** Every question that accepts the place, each as `QuestionRating`. A place nothing asks about says so. */
export function QuestionList({ api, target, scope, viewer, entryHref, heading = true, quiet = false, locale, messages, className }: {
  api: ScopedRatingApi; target: string; scope: QuestionScope; viewer: Viewer; entryHref?: EntryHref;
  /** Whether the list names itself; a host that heads the section already leaves it off. */
  heading?: boolean;
  /** Draw nothing where no question applies, for a host whose other parts are the point (a subject asked only about its places). */
  quiet?: boolean; locale: UiLocale; messages: ScopedRatingMessages; className?: string;
}) {
  const t = translate(messages, locale);
  const [questions, reload] = useLoad(() => api.questions(target, scope), `${target}\n${scope.kind === 'realm' ? scope.realm : 'global'}`);
  if (quiet && questions.state === 'ready' && questions.data.length === 0) return null;
  return <div data-questions className={cn('grid gap-5', className)}>
    {heading ? <h3 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">{t.questions}</h3> : null}
    {questions.state === 'loading' ? <p className="text-muted-foreground text-sm" aria-busy="true">{t.loading}</p>
      : questions.state === 'failed' ? <FailureNote failure={questions.failure} locale={locale} messages={messages} retry={reload} />
        : questions.data.length === 0 ? <p className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">{t.noQuestions}</p>
          : questions.data.map(question => <QuestionRating key={question.context} api={api} target={target}
            question={question} scope={scope} viewer={viewer} entryHref={entryHref} level={heading ? 4 : 3} locale={locale} messages={messages} />)}
  </div>;
}
