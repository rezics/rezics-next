'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { cn } from '@rezics/ui/utils';
import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, GlobeIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import { type ReactNode, useId, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { type ChapterPublication, type ChapterTarget, type DraftBasis, publishChapter } from './content-api.ts';
import type { StudioMessages } from './messages.ts';
import { manuscriptLength } from './counts.ts';
import { languageName, lengthLabel } from './parts.tsx';
import { AgentIdentity } from './studio-frame.tsx';
import { type Publication, publishText, selectMainText, type StepOutcome } from './text-api.ts';
import type { MainClient } from './types.ts';

type T = ContractOf<StudioMessages>;
type Outcome = StepOutcome | 'running' | 'skipped';
type Step = { id: string; label: string; outcome: Outcome; detail?: string };
type Update = (id: string, outcome: Outcome, detail?: string) => void;

function StepIcon({ outcome }: { outcome: Outcome }) {
  if (outcome === 'running') return <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin text-info-foreground" />;
  if (outcome === 'done') return <CircleCheckIcon aria-hidden="true" className="size-4 text-success-foreground" />;
  if (outcome === 'skipped') return <CircleDashedIcon aria-hidden="true" className="size-4 text-muted-foreground" />;
  return <CircleXIcon aria-hidden="true" className="size-4 text-destructive-foreground" />;
}

const excerpt = (body: string) => body.split('\n').filter(line => line.trim()).slice(0, 2);

/**
 * Publishing, in three explicit parts: who publishes (the Studio Agent), where
 * (public on REZICS) and what readers will see (this exact saved text). Each
 * command's outcome is shown on its own; nothing is retried behind the writer's back.
 */
function PublishShell({ open, onOpenChange, heading, agent, where, title, language, body, options, plan, run, locale,
  messages }: {
  open: boolean; onOpenChange: (open: boolean) => void; heading: string; agent: AgentOption; where: string;
  title: { value: string; language: string }; language: string; body: string; options?: ReactNode;
  plan: () => Step[]; run: (update: Update) => Promise<string | null>; locale: UiLocale; messages: StudioMessages;
}) {
  const t = materializeData(messages, { locale });
  const formId = useId();
  const [rights, setRights] = useState(false);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const lines = excerpt(body);
  const start = async () => {
    setRunning(true);
    setError(null);
    const planned = plan();
    setSteps(planned);
    const update: Update = (id, outcome, detail) =>
      setSteps(current => (current ?? planned).map(step => step.id === id ? { ...step, outcome, detail } : step));
    try { setError(await run(update)); }
    catch { setError(t.publishFailed); }
    finally { setRunning(false); }
  };
  const finished = steps !== null && !running && steps.every(step => step.outcome === 'done' || step.outcome === 'skipped');
  return <Dialog open={open} onOpenChange={details => { if (!running) onOpenChange(details.open); }}>
    <DialogContent size="lg">
      <DialogHeader title={finished ? t.publishDone : heading} />
      <DialogBody className="grid gap-5">
        {steps ? <ol aria-label={t.publish} className="grid gap-2">
          {steps.map(step => <li key={step.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 text-sm">
            <span className="mt-0.5"><StepIcon outcome={step.outcome} /></span>
            <span className="flex flex-wrap justify-between gap-x-3"><span>{step.label}</span>
              <span className="text-muted-foreground">{step.outcome === 'done' ? t.stepDone : step.outcome === 'skipped'
                ? t.stepSkipped : step.outcome === 'running' ? t.publishing : t.stepFailed}</span></span>
            {step.detail ? <span className="col-start-2 text-muted-foreground text-xs">{step.detail}</span> : null}
          </li>)}
        </ol> : <form id={formId} className="grid gap-5" onSubmit={event => { event.preventDefault(); void start(); }}>
          <dl className="grid gap-4 text-sm">
            <div className="grid gap-1.5"><dt className="text-muted-foreground text-xs">{t.publishWho}</dt>
              <dd><AgentIdentity agent={agent} messages={messages} locale={locale} /></dd></div>
            <div className="grid gap-1.5"><dt className="text-muted-foreground text-xs">{t.publishWhere}</dt>
              <dd className="flex items-center gap-2"><GlobeIcon aria-hidden="true" className="size-4 text-primary" />
                {where}</dd></div>
            <div className="grid gap-1.5"><dt className="text-muted-foreground text-xs">{t.publishWhat}</dt>
              <dd className="grid gap-2 rounded-2xl border border-border/60 bg-background p-4">
                <p lang={title.language} className="font-semibold font-work-title text-lg">{title.value}</p>
                <p className="text-muted-foreground text-xs">{[languageName(language, locale), lengthLabel(manuscriptLength(body, language), t)]
                  .join(' · ')}</p>
                <div lang={language} className="grid gap-1 font-work-title text-sm/[1.8] [text-autospace:normal]">
                  {lines.map((line, index) => <p key={index} className={cn(index === lines.length - 1 && 'line-clamp-3')}>
                    {line}</p>)}</div>
                <p className="text-muted-foreground text-xs">{t.publishSnapshot}</p>
              </dd></div>
          </dl>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" required checked={rights} onChange={event => setRights(event.target.checked)}
              className="mt-0.5 size-4 accent-primary" />
            <span>{t.publishRights}</span></label>
          {options}
        </form>}
        {error ? <Alert variant="destructive"><TriangleAlertIcon aria-hidden="true" />
          <AlertDescription role="alert" className="text-destructive-foreground">{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        {steps && !running ? <>
          {!finished ? <Button type="button" variant="outline" onClick={() => { setSteps(null); setError(null); }}>
            {t.back}</Button> : null}
          <Button type="button" onClick={() => onOpenChange(false)}>{t.close}</Button>
        </> : <>
          <Button type="button" variant="outline" disabled={running} onClick={() => onOpenChange(false)}>{t.cancel}</Button>
          <Button type="submit" form={formId} disabled={!rights || running} isLoading={running}>
            {running ? t.publishing : t.publish}</Button>
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export interface PublishTarget {
  agent: AgentOption; work: string; title: { value: string; language: string }; mainVersion: string;
  language: string; text: string; head: string; body: string;
  /** Main's current publication of this text, when known; null for a first publication. */
  publicationHead: string | null;
  /** A Book's own text is its introduction. */
  book?: boolean;
}

const failure = (outcome: StepOutcome, t: T) => outcome === 'denied' ? t.publishDenied : outcome === 'stale' ? t.publishStale
  : outcome === 'pending' ? t.publishPending : t.publishFailed;

/** Publishing a Work's own text, and optionally making it the text readers open for the Work. */
export function PublishDialog({ open, onOpenChange, target, onPublished, locale, messages, main }: {
  open: boolean; onOpenChange: (open: boolean) => void; target: PublishTarget;
  onPublished: (publication: Publication) => void; locale: UiLocale; messages: StudioMessages;
  /** Stories pass a stand-in Main; the app uses the browser client. */
  main?: MainClient;
}) {
  const t = materializeData(messages, { locale });
  const [makeMain, setMakeMain] = useState(true);
  // One key per command for this dialog: a retry after a lost answer replays instead of publishing twice.
  const keys = useRef<Record<string, string>>({});
  const key = (id: string) => (keys.current[`${id}\0${target.head}`] ??= crypto.randomUUID());
  return <PublishShell open={open} onOpenChange={onOpenChange} heading={t.publishHeading({ title: target.title.value })}
    agent={target.agent} where={t.publishWhereValue} title={target.title} language={target.language} body={target.body}
    locale={locale} messages={messages}
    options={<label className="flex items-start gap-3 text-sm">
      <input type="checkbox" checked={makeMain} onChange={event => setMakeMain(event.target.checked)}
        className="mt-0.5 size-4 accent-primary" />
      <span className="grid gap-0.5"><span>{target.book ? t.makeMainBook : t.makeMain}</span>
        <span className="text-muted-foreground text-xs">{t.makeMainHelp}</span></span></label>}
    plan={() => [{ id: 'publish', label: t.stepPublish, outcome: 'running' },
      ...makeMain ? [{ id: 'main', label: t.stepMain, outcome: 'skipped' as const }] : []]}
    run={async update => {
      const agent = target.agent.iri;
      const published = await publishText({ actingSubject: agent, text: target.text, head: target.head,
        expectedPublicationHead: target.publicationHead, key: key('publish') }, main);
      if (published.outcome !== 'done' || !published.publication) {
        update('publish', published.outcome);
        return failure(published.outcome, t);
      }
      update('publish', 'done');
      onPublished(published.publication);
      if (makeMain) {
        update('main', 'running');
        const outcome = await selectMainText({ actingSubject: agent, work: target.work, mainVersion: target.mainVersion,
          text: target.text, publication: published.publication, key: key('main') }, main).catch(() => 'failed' as const);
        update('main', outcome, outcome === 'denied' ? t.mainDenied : outcome === 'done' ? undefined : t.mainFailed);
      }
      return null;
    }} />;
}

/** Publishing a chapter: its Content publication, then letting readers find and open it. */
export function ChapterPublishDialog({ open, onOpenChange, agent, book, title, target, basis, current, onPublished, locale,
  messages, main }: {
  open: boolean; onOpenChange: (open: boolean) => void; agent: AgentOption; book: { value: string; language: string };
  title: { value: string; language: string }; target: ChapterTarget; basis: DraftBasis & { body: string };
  /** The publication this chapter has now, when this device knows it; null for a first publication. */
  current: ChapterPublication | null;
  onPublished: (publication: ChapterPublication, basis: DraftBasis) => void;
  locale: UiLocale; messages: StudioMessages; main?: MainClient;
}) {
  const t = materializeData(messages, { locale });
  const keys = useRef<Record<string, string>>({});
  const key = keys.current[basis.head] ??= crypto.randomUUID();
  return <PublishShell open={open} onOpenChange={onOpenChange}
    heading={current ? t.publishUpdateHeading({ title: title.value }) : t.publishHeading({ title: title.value })}
    agent={agent} where={t.publishChapterWhere({ book: book.value })} title={title} language={target.language}
    body={basis.body} locale={locale} messages={messages}
    plan={() => [{ id: 'publish', label: current ? t.stepPublishUpdate : t.stepPublishChapter, outcome: 'running' },
      { id: 'eligibility', label: t.stepEligibility, outcome: 'skipped' }]}
    run={async update => {
      const result = await publishChapter({ target, basis, current, key }, main);
      if (result.step === 'publish') {
        update('publish', result.outcome);
        return result.outcome === 'stale' ? t.publishChapterStale : failure(result.outcome, t);
      }
      update('publish', 'done');
      update('eligibility', result.outcome);
      if (result.publication) onPublished(result.publication, basis);
      return result.outcome === 'done' ? null : result.outcome === 'stale' ? t.eligibilityStale : t.eligibilityFailed;
    }} />;
}
