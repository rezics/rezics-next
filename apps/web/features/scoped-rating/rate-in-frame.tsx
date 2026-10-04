'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTrigger } from '@rezics/ui/sheet';
import { cn } from '@rezics/ui/utils';
import { LayersIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { ProjectionRead, QuestionScope, ScopedRatingApi } from './api.ts';
import { FailureNote } from './failure.tsx';
import { FramePicker } from './frame-picker.tsx';
import type { FrameCandidate } from './frames.ts';
import { translate } from './format.ts';
import type { ScopedRatingMessages } from './messages.ts';
import { ProjectionHeader } from './projection-header.tsx';
import { QuestionList, type EntryHref, type Viewer } from './question-rating.tsx';
import type { FrameSource } from './sources.ts';
import type { Failure, Subject } from './types.ts';

type Step =
  | { step: 'choose' }
  | { step: 'opening' }
  | { step: 'rate'; read: ProjectionRead }
  | { step: 'failed'; failure: Failure };

/**
 * Rate one subject in a place of its own: choose the episode, chapter, match, map, continuity or game version, then see
 * the questions that accept it and rate, review and discuss them. The place is got or created when it is first used,
 * so choosing never leaves an empty record behind, and the same choice always reaches the same place.
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

  async function openPlace() {
    setState({ step: 'opening' });
    const answer = await api.projection(subject.iri, frames.map(frame => frame.iri))
      .catch(() => ({ ok: false as const, failure: 'unavailable' as const }));
    setState(answer.ok ? { step: 'rate', read: answer.data } : { step: 'failed', failure: answer.failure });
  }
  const back = () => setState({ step: 'choose' });

  return <Sheet open={open} onOpenChange={details => setOpen(details.open)}>
    <SheetTrigger disabled={!hydrated} data-hydrated={hydrated ? 'true' : undefined}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), className)}>
      <LayersIcon aria-hidden="true" />{t.trigger}</SheetTrigger>
    <SheetContent placement="bottom" className="max-h-[88svh] sm:mx-auto sm:max-w-xl">
      <SheetHeader title={t.sheetTitle({ name: subject.name.value })} description={t.sheetBody} />
      <SheetBody>
        {state.step === 'choose' || state.step === 'opening'
          ? <FramePicker sources={sources} value={frames} onChange={setFrames} onContinue={() => void openPlace()}
            busy={state.step === 'opening'} locale={locale} messages={messages} />
          : state.step === 'failed'
            ? <div className="grid gap-3">
              <FailureNote failure={state.failure} locale={locale} messages={messages}
                signInHref={viewer.kind === 'signed-out' ? viewer.signInHref : undefined}
                retry={() => void openPlace()} />
              <Button variant="ghost" size="sm" className="justify-self-start" onClick={back}>{t.chooseDifferently}</Button>
            </div>
            : <div className="grid gap-5">
              <ProjectionHeader summary={state.read.summary} locale={locale} messages={messages} />
              <QuestionList api={api} target={state.read.projection.id} scope={scope} viewer={viewer} entryHref={entryHref}
                locale={locale} messages={messages} />
              <Button variant="ghost" size="sm" className="justify-self-start" onClick={back}>{t.chooseDifferently}</Button>
            </div>}
      </SheetBody>
    </SheetContent>
  </Sheet>;
}
