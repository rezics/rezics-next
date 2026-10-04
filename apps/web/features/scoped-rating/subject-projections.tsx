'use client';

import { Button } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { LockIcon } from 'lucide-react';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { ProjectionRead, QuestionScope, ScopedRatingApi } from './api.ts';
import { FailureNote } from './failure.tsx';
import { ScoreFigure } from './figure.tsx';
import { translate } from './format.ts';
import type { ScopedRatingMessages } from './messages.ts';
import { ProjectionHeader } from './projection-header.tsx';
import { questionText } from './question-rating.tsx';
import { figuresOfRating, type Figures } from './score.ts';
import type { Outcome, Question } from './types.ts';
import { useLoad } from './use-load.ts';

const isVisible = (read: ProjectionRead) => read.summary?.status === 'available';

interface RowFigures { question: Question | null; figures: Figures | null; more: number }

/**
 * One place's own figures for the subject's question: the host's `question`, else the first one that accepts the place.
 * Nothing is read for a place the reader has not reached.
 */
async function readRow(api: ScopedRatingApi, target: string, scope: QuestionScope, question?: Question): Promise<Outcome<RowFigures>> {
  let chosen = question ?? null;
  let more = 0;
  if (!chosen) {
    const asked = await api.questions(target, scope);
    if (!asked.ok) return asked;
    chosen = asked.data[0] ?? null;
    more = Math.max(0, asked.data.length - 1);
  }
  if (!chosen) return { ok: true, data: { question: null, figures: null, more } };
  const rating = await api.rating(target, chosen.context, scope);
  return rating.ok ? { ok: true, data: { question: chosen, figures: figuresOfRating(rating.data), more } } : rating;
}

function ProjectionRow({ read, api, scope, question, locale, messages }: {
  read: ProjectionRead; api: ScopedRatingApi; scope: QuestionScope; question?: Question; locale: UiLocale;
  messages: ScopedRatingMessages;
}) {
  const t = translate(messages, locale);
  const [row, reload] = useLoad(() => readRow(api, read.projection.id, scope, question), `${read.projection.id}\n${question?.context ?? ''}`);
  return <li data-projection={read.projection.id} className="grid gap-3 rounded-2xl border border-border/60 bg-card p-4">
    <ProjectionHeader summary={read.summary} locale={locale} messages={messages} />
    {row.state === 'loading' ? <p className="text-muted-foreground text-sm" aria-busy="true">{t.loading}</p>
      : row.state === 'failed' ? <FailureNote failure={row.failure} locale={locale} messages={messages} retry={reload} />
        : !row.data.question ? <p className="text-muted-foreground text-sm">{t.noQuestions}</p>
          : <div className="grid gap-1.5">
            <p lang={questionText(row.data.question).language} dir={questionText(row.data.question).direction}
              className="text-muted-foreground text-sm">{questionText(row.data.question).value}</p>
            {row.data.figures ? <ScoreFigure figures={row.data.figures} locale={locale} messages={messages} />
              : <p className="text-muted-foreground text-sm">{t.noRatings}</p>}
            {row.data.more > 0 ? <p className="text-muted-foreground text-xs">{t.moreQuestions(row.data.more)}</p> : null}
          </div>}
  </li>;
}

/**
 * Every place a subject is rated in, each with its own figures and none averaged into another's. A place the reader has
 * not reached is not drawn; the list says only how many are hidden, so their names and numbers cannot give the story away.
 */
export function SubjectProjections({ subject, api, scope = { kind: 'global' }, question, level = 2, locale, messages, className }: {
  subject: string; api: ScopedRatingApi; scope?: QuestionScope; question?: Question; level?: 2 | 3; locale: UiLocale;
  messages: ScopedRatingMessages; className?: string;
}) {
  const t = translate(messages, locale);
  const [first, reload] = useLoad(() => api.projections(subject), subject);
  const [later, setLater] = useState<{ items: ProjectionRead[]; next: string | null; busy: boolean; failed: boolean } | null>(null);
  const Heading = `h${level}` as const;
  const items = first.state === 'ready' ? [...first.data.items, ...later?.items ?? []] : [];
  const next = later ? later.next : first.state === 'ready' ? first.data.nextCursor : null;
  const visible = items.filter(isVisible);
  const hidden = items.length - visible.length;

  async function more() {
    if (!next) return;
    setLater(state => ({ items: state?.items ?? [], next, busy: true, failed: false }));
    const page = await api.projections(subject, next).catch(() => null);
    setLater(state => !page?.ok ? { items: state?.items ?? [], next, busy: false, failed: true }
      : { items: [...state?.items ?? [], ...page.data.items], next: page.data.nextCursor, busy: false, failed: false });
  }

  return <section data-subject-projections className={cn('grid gap-4', className)}>
    <Heading className="font-semibold text-lg tracking-tight">{t.byPart}</Heading>
    {first.state === 'loading' ? <p className="text-muted-foreground text-sm" aria-busy="true">{t.loading}</p>
      : first.state === 'failed' ? <FailureNote failure={first.failure} locale={locale} messages={messages} retry={reload} />
        : items.length === 0 ? <p className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">{t.noParts}</p>
          : <>
            {visible.length ? <ul className="grid gap-3">
              {visible.map(read => <ProjectionRow key={read.projection.id} read={read} api={api} scope={scope} question={question}
                locale={locale} messages={messages} />)}
            </ul> : null}
            {hidden > 0 ? <p data-hidden-parts className="flex items-start gap-2 text-muted-foreground text-sm">
              <LockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{t.hiddenParts(hidden)}</p> : null}
            {next ? <div className="grid justify-items-start gap-2">
              <Button variant="outline" size="sm" isLoading={later?.busy} onClick={() => void more()}>{t.showMore}</Button>
              {later?.failed ? <p role="status" className="text-destructive-foreground text-xs">{t.failUnavailable}</p> : null}
            </div> : null}
          </>}
  </section>;
}
