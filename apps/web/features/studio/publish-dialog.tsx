'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { cn } from '@rezics/ui/utils';
import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, GlobeIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import { useId, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { textStats } from '@rezics/ui/editor';
import type { StudioMessages } from './messages.ts';
import { AgentIdentity } from './studio-frame.tsx';
import { languageName } from './studio-home.tsx';
import { type Publication, publishText, selectMainText, type StepOutcome, submitToRealm } from './text-api.ts';
import type { Loaded, MainClient, RealmChoice } from './types.ts';

type T = ContractOf<StudioMessages>;
type Step = { id: string; label: string; outcome: StepOutcome | 'running' | 'skipped'; detail?: string };

export interface PublishTarget {
  agent: AgentOption; work: string; title: { value: string; language: string }; mainVersion: string;
  language: string; text: string; head: string; body: string;
  /** Main's current publication of this text, when known; null for a first publication. */
  publicationHead: string | null;
}

function StepIcon({ outcome }: { outcome: Step['outcome'] }) {
  if (outcome === 'running') return <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin text-info-foreground" />;
  if (outcome === 'done') return <CircleCheckIcon aria-hidden="true" className="size-4 text-success-foreground" />;
  if (outcome === 'skipped') return <CircleDashedIcon aria-hidden="true" className="size-4 text-muted-foreground" />;
  return <CircleXIcon aria-hidden="true" className="size-4 text-destructive-foreground" />;
}

const excerpt = (body: string) => body.split('\n').filter(line => line.trim()).slice(0, 2);

/**
 * Publishing a text, in three explicit parts: who publishes (the Studio Agent),
 * where (public on REZICS) and what readers will see (this exact saved text).
 * Making it the Work's main text and submitting to Realms are separate,
 * optional commands; each one's outcome is shown on its own.
 */
export function PublishDialog({ open, onOpenChange, target, realms, onPublished, locale, messages, main }: {
  open: boolean; onOpenChange: (open: boolean) => void; target: PublishTarget; realms: Loaded<RealmChoice[]>;
  onPublished: (publication: Publication) => void; locale: UiLocale; messages: StudioMessages;
  /** Stories pass a stand-in Main; the app uses the browser client. */
  main?: MainClient;
}) {
  const t = materializeData(messages, { locale });
  const formId = useId();
  const [rights, setRights] = useState(false);
  const [makeMain, setMakeMain] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // One key per command for this dialog: a retry after a lost answer replays instead of publishing twice.
  const keys = useRef<Record<string, string>>({});
  const key = (id: string) => (keys.current[id] ??= crypto.randomUUID());
  const realmName = (realm: RealmChoice) => realm.name.value;
  const lines = excerpt(target.body);
  const stats = textStats(target.body, target.language);

  const run = async () => {
    setRunning(true);
    setError(null);
    const agent = target.agent.iri;
    const selected = realms.ok ? realms.data.filter(realm => chosen.includes(realm.id)) : [];
    const plan: Step[] = [{ id: 'publish', label: t.stepPublish, outcome: 'running' },
      ...makeMain ? [{ id: 'main', label: t.stepMain, outcome: 'skipped' as const }] : [],
      ...selected.map(realm => ({ id: realm.id, label: t.stepSubmit({ realm: realmName(realm) }), outcome: 'skipped' as const }))];
    const update = (id: string, outcome: Step['outcome'], detail?: string) =>
      setSteps(current => (current ?? plan).map(step => step.id === id ? { ...step, outcome, detail } : step));
    setSteps(plan);
    try {
      const published = await publishText({ actingSubject: agent, text: target.text, head: target.head,
        expectedPublicationHead: target.publicationHead, key: key('publish') }, main);
      if (published.outcome !== 'done' || !published.publication) {
        update('publish', published.outcome);
        setError(published.outcome === 'denied' ? t.publishDenied : published.outcome === 'stale' ? t.publishStale
          : published.outcome === 'pending' ? t.publishPending : t.publishFailed);
        return;
      }
      const publication = published.publication;
      update('publish', 'done');
      onPublished(publication);
      if (makeMain) {
        update('main', 'running');
        const outcome = await selectMainText({ actingSubject: agent, work: target.work, mainVersion: target.mainVersion,
          text: target.text, publication, key: key('main') }, main).catch(() => 'failed' as const);
        update('main', outcome, outcome === 'denied' ? t.mainDenied : outcome === 'done' ? undefined : t.mainFailed);
      }
      await Promise.all(selected.map(async realm => {
        update(realm.id, 'running');
        const outcome = await submitToRealm({ actingSubject: agent, realm: realm.id, work: target.work,
          mainVersion: target.mainVersion, text: target.text, publication, key: key(realm.id) }, main)
          .catch(() => 'failed' as const);
        update(realm.id, outcome, outcome === 'denied' ? t.submitDenied : outcome === 'done' ? undefined : t.submitFailed);
      }));
    } catch {
      update('publish', 'failed');
      setError(t.publishFailed);
    } finally { setRunning(false); }
  };

  const finished = steps !== null && !running && steps[0]?.outcome === 'done';
  return <Dialog open={open} onOpenChange={details => { if (!running) onOpenChange(details.open); }}>
    <DialogContent size="lg">
      <DialogHeader title={finished ? t.publishDone : t.publishHeading({ title: target.title.value })} />
      <DialogBody className="grid gap-5">
        {steps ? <ol aria-label={t.publish} className="grid gap-2">
          {steps.map(step => <li key={step.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 text-sm">
            <span className="mt-0.5"><StepIcon outcome={step.outcome} /></span>
            <span className="flex flex-wrap justify-between gap-x-3"><span>{step.label}</span>
              <span className="text-muted-foreground">{step.outcome === 'done' ? t.stepDone : step.outcome === 'skipped'
                ? t.stepSkipped : step.outcome === 'running' ? t.publishing : t.stepFailed}</span></span>
            {step.detail ? <span className="col-start-2 text-muted-foreground text-xs">{step.detail}</span> : null}
          </li>)}
        </ol> : <form id={formId} className="grid gap-5" onSubmit={event => { event.preventDefault(); void run(); }}>
          <dl className="grid gap-4 text-sm">
            <div className="grid gap-1.5"><dt className="text-muted-foreground text-xs">{t.publishWho}</dt>
              <dd><AgentIdentity agent={target.agent} messages={messages} locale={locale} /></dd></div>
            <div className="grid gap-1.5"><dt className="text-muted-foreground text-xs">{t.publishWhere}</dt>
              <dd className="flex items-center gap-2"><GlobeIcon aria-hidden="true" className="size-4 text-primary" />
                {t.publishWhereValue}</dd></div>
            <div className="grid gap-1.5"><dt className="text-muted-foreground text-xs">{t.publishWhat}</dt>
              <dd className="grid gap-2 rounded-2xl border border-border/60 bg-background p-4">
                <p lang={target.title.language} className="font-semibold font-work-title text-lg">{target.title.value}</p>
                <p className="text-muted-foreground text-xs">{[languageName(target.language, locale),
                  t.wordCount(stats.words)].join(' · ')}</p>
                <div lang={target.language} className="grid gap-1 font-work-title text-sm/[1.8] [text-autospace:normal]">
                  {lines.map((line, index) => <p key={index} className={cn(index === lines.length - 1 && 'line-clamp-3')}>
                    {line}</p>)}</div>
                <p className="text-muted-foreground text-xs">{t.publishSnapshot}</p>
              </dd></div>
          </dl>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" required checked={rights} onChange={event => setRights(event.target.checked)}
              className="mt-0.5 size-4 accent-primary" />
            <span>{t.publishRights}</span></label>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={makeMain} onChange={event => setMakeMain(event.target.checked)}
              className="mt-0.5 size-4 accent-primary" />
            <span className="grid gap-0.5"><span>{t.makeMain}</span>
              <span className="text-muted-foreground text-xs">{t.makeMainHelp}</span></span></label>
          <fieldset className="grid min-w-0 gap-2">
            <legend className="mb-1 font-medium text-sm">{t.submitRealms}</legend>
            <p className="text-muted-foreground text-xs">{t.submitRealmsHelp}</p>
            {realms.ok ? realms.data.length ? <div className="grid gap-1.5">{realms.data.map(realm =>
              <label key={realm.id} className="flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2 text-sm
                has-checked:border-primary has-checked:bg-primary/5">
                <input type="checkbox" checked={chosen.includes(realm.id)} className="size-4 accent-primary"
                  onChange={event => setChosen(current => event.target.checked ? [...current, realm.id]
                    : current.filter(id => id !== realm.id))} />
                <span className="min-w-0 truncate" lang={realm.name.language}>{realmName(realm)}</span></label>)}</div>
              : <p className="text-muted-foreground text-sm">{t.noRealms}</p>
              : <p className="text-muted-foreground text-sm">{t.realmsFailed}</p>}
          </fieldset>
        </form>}
        {error ? <Alert variant="destructive"><TriangleAlertIcon aria-hidden="true" />
          <AlertDescription role="alert" className="text-destructive-foreground">{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        {steps && !running ? <>
          {!finished ? <Button type="button" variant="outline" onClick={() => { setSteps(null); setError(null); }}>
            {t.cancel}</Button> : null}
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
