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
import { FailureNote } from './failure.tsx';
import { ScoreFigure } from './figure.tsx';
import { formatNumber, translate } from './format.ts';
import type { ScopedRatingMessages } from './messages.ts';
import { figuresOfRating } from './score.ts';
import type { Failure, Question } from './types.ts';
import { useLoad } from './use-load.ts';

/** Who is looking: a signed-out reader is sent to sign in where a signed-in one rates. */
export type Viewer = { kind: 'signed-out'; signInHref: string } | { kind: 'reader' };

/** Where the review and the discussion of a rated place live; the host's pages decide. */
export type EntryHref = (entry: 'review' | 'discussion', target: string, question: string) => string;

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
 */
export function QuestionRating({ api, target, question, scope, viewer, entryHref, locale, messages, className }: {
  api: ScopedRatingApi; target: string; question: Question; scope: QuestionScope; viewer: Viewer;
  entryHref?: EntryHref; locale: UiLocale; messages: ScopedRatingMessages; className?: string;
}) {
  const t = translate(messages, locale);
  const [figures, reload] = useLoad(() => api.rating(target, question.context, scope), `${target}\n${question.context}`);
  const [own, setOwn] = useState<number | null>(() => api.own(target, question.context));
  const [saving, setSaving] = useState<Saving>({ state: 'idle' });
  const text = questionText(question);
  const max = question.scale.max;
  const hrefFor = entryHref ?? defaultEntryHref(locale);

  async function save(next: number | null) {
    const before = own;
    setOwn(next);
    setSaving({ state: 'saving' });
    const answer = await api.rate(target, question.context, next).catch(() => ({ ok: false as const, failure: 'unavailable' as const }));
    if (!answer.ok) { setOwn(before); setSaving({ state: 'failed', failure: answer.failure }); return; }
    setSaving({ state: 'saved', pending: answer.data.pending });
    reload();
  }

  const read = figures.state === 'ready' ? figuresOfRating(figures.data) : null;
  return <section data-question={question.context} aria-label={text.value} className={cn('grid gap-3', className)}>
    <h4 lang={text.language} dir={text.direction} className="font-medium text-base leading-snug">{text.value}</h4>
    {figures.state === 'loading' ? <p className="text-muted-foreground text-sm" aria-busy="true">{t.loading}</p>
      : figures.state === 'failed' ? <FailureNote failure={figures.failure} locale={locale} messages={messages} retry={reload} />
        : read ? <ScoreFigure figures={read} histogram locale={locale} messages={messages} />
          : <p className="text-muted-foreground text-sm">{t.noRatings}</p>}

    {viewer.kind === 'signed-out'
      ? <Link href={viewer.signInHref} className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'justify-self-start')}>
        {t.signInToRate}</Link>
      : <div className="grid justify-items-start gap-1.5">
        <Rating size="md" count={max} value={own ?? 0} className="items-start"
          onValueChange={({ value }) => { if (value !== own) void save(value); }}>
          <RatingLabel className="font-normal text-muted-foreground text-sm">
            {own ? t.yourRatingValue({ value: formatNumber(own, locale), max: formatNumber(max, locale) }) : t.yourRating}
          </RatingLabel>
        </Rating>
        {own ? <Button size="xs" variant="ghost" onClick={() => void save(null)}>{t.removeRating}</Button> : null}
        <p role="status" aria-live="polite" className={cn('min-h-5 text-xs', saving.state === 'failed' ? 'text-destructive-foreground' : 'text-muted-foreground')}>
          {saving.state === 'saving' ? t.saving
            : saving.state === 'saved' ? (saving.pending ? t.savedPending : t.saved)
              : saving.state === 'failed' ? (saving.failure === 'conflict' ? t.saveConflict : saving.failure === 'sign-in' ? t.failSignIn
                : saving.failure === 'denied' ? t.failDenied : t.saveFailed) : null}
        </p>
      </div>}

    <div className="flex flex-wrap gap-2">
      <Link href={hrefFor('review', target, question.context)} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
        <PenLineIcon aria-hidden="true" />{t.writeReview}</Link>
      <Link href={hrefFor('discussion', target, question.context)} className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
        <MessageSquareIcon aria-hidden="true" />{t.discuss}</Link>
    </div>
  </section>;
}

/** Every question that accepts the place, each as `QuestionRating`. A place nothing asks about says so. */
export function QuestionList({ api, target, scope, viewer, entryHref, locale, messages, className }: {
  api: ScopedRatingApi; target: string; scope: QuestionScope; viewer: Viewer; entryHref?: EntryHref;
  locale: UiLocale; messages: ScopedRatingMessages; className?: string;
}) {
  const t = translate(messages, locale);
  const [questions, reload] = useLoad(() => api.questions(target, scope), `${target}\n${scope.kind === 'realm' ? scope.realm : 'global'}`);
  return <div data-questions className={cn('grid gap-5', className)}>
    <h3 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">{t.questions}</h3>
    {questions.state === 'loading' ? <p className="text-muted-foreground text-sm" aria-busy="true">{t.loading}</p>
      : questions.state === 'failed' ? <FailureNote failure={questions.failure} locale={locale} messages={messages} retry={reload} />
        : questions.data.length === 0 ? <p className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">{t.noQuestions}</p>
          : questions.data.map(question => <QuestionRating key={question.context} api={api} target={target}
            question={question} scope={scope} viewer={viewer} entryHref={entryHref} locale={locale} messages={messages} />)}
  </div>;
}
