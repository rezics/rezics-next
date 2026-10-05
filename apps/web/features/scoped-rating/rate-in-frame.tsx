'use client';

import { badgeVariants } from '@rezics/ui/badge';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTrigger } from '@rezics/ui/sheet';
import { cn } from '@rezics/ui/utils';
import { LayersIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { ProjectionRead, QuestionScope, ScopedRatingApi } from './api.ts';
import { FailureNote } from './failure.tsx';
import { FramePicker } from './frame-picker.tsx';
import { frameDimensions, type FrameCandidate } from './frames.ts';
import { translate } from './format.ts';
import type { ScopedRatingMessages } from './messages.ts';
import { ProjectionHeader } from './projection-header.tsx';
import { QuestionList, QuestionRating, type EntryHref, type Viewer } from './question-rating.tsx';
import type { FrameSource } from './sources.ts';
import type { Failure, Outcome, Subject } from './types.ts';
import { useLoad } from './use-load.ts';

type Step =
  | { step: 'choose' }
  | { step: 'opening' }
  /** `read` is the place as it exists; without one, `created` is the place a first rating, review or discussion made. */
  | { step: 'rate'; read: ProjectionRead | null; created: ProjectionRead | null }
  | { step: 'failed'; failure: Failure };

/**
 * Rate one subject in a place of its own: choose the episode, chapter, match, map, continuity or game version, then see
 * the questions that accept it and rate, review and discuss them. Choosing only looks the place up; it is created by the
 * first rating, review or discussion, so choosing never leaves an empty record behind, and the same choice always
 * reaches the same place.
 */
export function RateInFrame({ subject, api, sources, scope = { kind: 'global' }, viewer, entryHref, initialFrames = [],
  defaultOpen = false, locale, messages, className }: {
  subject: Subject; api: ScopedRatingApi; sources: readonly FrameSource[]; scope?: QuestionScope; viewer: Viewer;
  entryHref?: EntryHref; initialFrames?: readonly FrameCandidate[]; defaultOpen?: boolean; locale: UiLocale;
  messages: ScopedRatingMessages; className?: string;
}) {
  const t = translate(messages, locale);
  const [open, setOpen] = useState(defaultOpen);
  const [frames, setFrames] = useState<FrameCandidate[]>([...initialFrames]);
  const [state, setState] = useState<Step>({ step: 'choose' });
  // Tests and scripts wait for this before they press the trigger: the server-rendered button does nothing until then.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [questions, reload] = useLoad(() => api.frameQuestions
    ? api.frameQuestions(subject.iri, scope)
    : Promise.resolve({ ok: false as const, failure: 'unavailable' as const }),
    `${subject.iri}\n${scope.kind === 'realm' ? scope.realm : 'global'}`);
  const applicable = questions.state === 'ready' ? questions.data : [];
  const dimensions = new Set(applicable.flatMap(question => question.acceptedFrameDimensions ?? frameDimensions));
  const offered = sources.filter(source => dimensions.has(source.dimension));
  // A union of dimensions can contain a combination no single question accepts.
  const accepted = frames.length > 0 && applicable.some(question =>
    frames.every(frame => !question.acceptedFrameDimensions || question.acceptedFrameDimensions.includes(frame.dimension)));

  // The place a first write created, so the questions of one unopened place share it.
  const made = useRef<string | null>(null);

  async function openPlace() {
    if (!accepted) return;
    made.current = null;
    setState({ step: 'opening' });
    const answer = await api.lookup(subject.iri, frames.map(frame => frame.iri))
      .catch(() => ({ ok: false as const, failure: 'unavailable' as const }));
    setState(answer.ok ? { step: 'rate', read: answer.data, created: null } : { step: 'failed', failure: answer.failure });
  }
  const back = () => setState({ step: 'choose' });

  /** Creates the place the first time one of its questions is rated, reviewed or discussed; later calls reuse it. */
  async function createPlace(): Promise<Outcome<string>> {
    if (made.current) return { ok: true, data: made.current };
    const answer = await api.projection(subject.iri, frames.map(frame => frame.iri));
    if (!answer.ok) return answer;
    made.current = answer.data.projection.id;
    setState(current => current.step === 'rate' ? { ...current, created: answer.data } : current);
    return { ok: true, data: answer.data.projection.id };
  }
  // Questions asked of a place that does not exist yet: those whose accepted dimensions cover every chosen frame.
  const unopened = applicable.filter(question =>
    frames.every(frame => !question.acceptedFrameDimensions || question.acceptedFrameDimensions.includes(frame.dimension)));

  return <Sheet open={open} onOpenChange={details => setOpen(details.open)}>
    <SheetTrigger disabled={!hydrated} data-hydrated={hydrated ? 'true' : undefined}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), className)}>
      <LayersIcon aria-hidden="true" />{t.trigger}</SheetTrigger>
    <SheetContent placement="bottom" className="max-h-[88svh] sm:mx-auto sm:max-w-xl">
      <SheetHeader title={t.sheetTitle({ name: subject.name.value })} description={t.sheetBody} />
      <SheetBody>
        {state.step === 'choose' || state.step === 'opening'
          ? questions.state === 'loading' ? <p aria-busy="true" className="text-muted-foreground text-sm">{t.loading}</p>
            : questions.state === 'failed' ? <FailureNote failure={questions.failure} retry={reload} locale={locale} messages={messages} />
              : !applicable.length ? <p className="text-muted-foreground text-sm">{t.noQuestions}</p>
                : <div className="grid gap-3">
                  {frames.length > 0 && !accepted ? <p role="status" className="text-muted-foreground text-sm">{t.noQuestions}</p> : null}
                  <FramePicker sources={offered} value={frames} onChange={setFrames} onContinue={() => void openPlace()}
                    canContinue={accepted} busy={state.step === 'opening'} locale={locale} messages={messages} />
                </div>
          : state.step === 'failed'
            ? <div className="grid gap-3">
              <FailureNote failure={state.failure} locale={locale} messages={messages}
                signInHref={viewer.kind === 'signed-out' ? viewer.signInHref : undefined}
                retry={() => void openPlace()} />
              <Button variant="ghost" size="sm" className="justify-self-start" onClick={back}>{t.chooseDifferently}</Button>
            </div>
            : <div className="grid gap-5">
              {state.read || state.created
                ? <ProjectionHeader summary={(state.read ?? state.created)!.summary} retry={() => void openPlace()} locale={locale} messages={messages} />
                : <header data-projection-header className="grid min-w-0 gap-1.5">
                  <h3 className="break-words font-semibold font-work-title text-lg leading-tight tracking-tight">
                    <bdi lang={subject.name.language} dir={subject.name.direction}>{subject.name.value}</bdi></h3>
                  <ul aria-label={t.within} className="flex min-w-0 flex-wrap gap-1.5">
                    {frames.map(frame => <li key={frame.iri} className={cn(badgeVariants({ variant: 'outline' }), 'max-w-full')}>
                      <bdi lang={frame.name.language || undefined} dir={frame.name.direction} className="truncate">{frame.name.value}</bdi></li>)}
                  </ul>
                </header>}
              {state.read
                ? <QuestionList api={api} target={state.read.projection.id} scope={scope} viewer={viewer} entryHref={entryHref}
                  locale={locale} messages={messages} />
                : <div data-questions className="grid gap-5">
                  <h3 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">{t.questions}</h3>
                  {unopened.map(question => <QuestionRating key={question.context} api={api} target={null} open={createPlace}
                    question={question} scope={scope} viewer={viewer} entryHref={entryHref} locale={locale} messages={messages} />)}
                </div>}
              <Button variant="ghost" size="sm" className="justify-self-start" onClick={back}>{t.chooseDifferently}</Button>
            </div>}
      </SheetBody>
    </SheetContent>
  </Sheet>;
}
