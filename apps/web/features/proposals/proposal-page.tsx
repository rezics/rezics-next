'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogHeader } from '@rezics/ui/dialog';
import { CircleCheckIcon, CircleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { type ActionRequest, controlsFor, type Control } from './actions.ts';
import { type Fields, fieldsOf, type Source } from './candidate.ts';
import { bffProposalApi, type ProposalApi, newKey, type Outcome } from './commands.ts';
import { CorrectionEditor } from './correction-editor.tsx';
import { leaves } from './diff.ts';
import { ActionDialog, type DialogAction } from './action-dialog.tsx';
import { failureKey, kindLabel } from './labels.ts';
import type { ProposalMessages } from './messages.ts';
import { type Agents, agentName, BlockerList, blockerText, ChangeList, EvidenceList, StateBadge, Timeline } from './parts.tsx';
import type { BaseHead, HeaderState, Loaded, ProposalRead, TargetName } from './types.ts';
import { uuidOf } from './types.ts';

/** What a revise dialog starts from, read from the candidate of a header correction; null for other candidates. */
export function reviseSeed(view: ProposalRead): { state: HeaderState; language: string; fields: Fields;
  sources: Source[] } | null {
  const candidate = view.revision.candidate;
  if (typeof candidate !== 'object' || candidate === null || !('command' in candidate) || candidate.command !== 'work-metadata'
    || !('state' in candidate)) return null;
  const state = candidate.state as HeaderState;
  if (state?.kind !== 'header' || !Array.isArray(state.localized)) return null;
  const language = leaves(view.preview).find(leaf => leaf.language)?.language ?? state.localized[0]?.language ?? 'en';
  return { state, language, fields: fieldsOf(state, language),
    sources: view.revision.evidence.length ? view.revision.evidence.map(item => ({ source: item.resource,
      locator: item.locator ?? '' })) : [{ source: '', locator: '' }] };
}

/** The heads a revision is written against: what Main says the fact is now when it has moved, else the ones it had. */
export function reviseHeads(view: ProposalRead): { baseHeads: BaseHead[]; rebased: boolean } {
  const stale = view.blockers.find(blocker => blocker.code === 'stale_base');
  return stale ? { baseHeads: stale.actualHeads, rebased: true } : { baseHeads: view.revision.baseHeads, rebased: false };
}

const label = (action: Control['action'], t: ReturnType<typeof materializeData<ProposalMessages>>) => ({
  'approve-and-apply': t.actionApprove, apply: t.actionApply, review: t.actionReview, revise: t.actionRevise,
  reject: t.actionReject, withdraw: t.actionWithdraw, revert: t.actionRevert, recover: t.actionRecover })[action];

type Notice = { tone: 'success' | 'error'; text: string; href?: string };

/**
 * One correction: what it changes, its evidence, the blockers Main names, the
 * actions Main allows this viewer and the steps so far. The page renders the
 * read's `allowedActions` and `blockers` and holds no rule of its own: each
 * control sends one G-865 operation and the page then reads the proposal again,
 * so what shows after any step is Main's state.
 */
export function ProposalPage({ initial, target, agents, actingSubject, now, locale, messages, api: givenApi,
  linkedRevision = null }: {
  initial: ProposalRead; target: TargetName | null; agents: Agents; actingSubject: string | undefined; now: number;
  locale: UiLocale; messages: ProposalMessages; api?: ProposalApi; linkedRevision?: number | null;
}) {
  const t = materializeData(messages, { locale });
  const api = useMemo(() => givenApi ?? bffProposalApi(initial.proposal.id, actingSubject),
    [givenApi, initial.proposal.id, actingSubject]);
  const [view, setView] = useState(initial);
  const [dialog, setDialog] = useState<DialogAction | 'revise' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // One key per intent: sending the same request again after a lost answer replays its receipt.
  const keys = useRef(new Map<string, string>());
  const proposal = view.proposal;
  const seed = reviseSeed(view);
  const work = proposal.target.work;
  // A revise control needs an editor for the candidate; only header corrections have one so far.
  const controls = controlsFor(view.allowedActions).filter(control => control.action !== 'revise' || seed);

  const reread = async (): Promise<boolean> => {
    const next: Loaded<ProposalRead> = await api.read(proposal.id);
    if (next.ok) setView(next.data);
    return next.ok;
  };
  const fail = async (outcome: Extract<Outcome<unknown>, { ok: false }>) => {
    // A stale or pending answer means the proposal moved: show Main's state with the reason.
    if (outcome.failure === 'stale' || outcome.failure === 'pending') await reread();
    const text = String(t[failureKey[outcome.failure]]);
    return outcome.blocker ? `${text} ${blockerText(outcome.blocker, t)}` : text;
  };
  const perform = async (request: ActionRequest) => {
    const signature = JSON.stringify(request);
    const key = keys.current.get(signature) ?? newKey();
    keys.current.set(signature, key);
    setPending(true); setError(null); setNotice(null);
    const outcome = await api.act(request, key);
    setPending(false);
    if (!outcome.ok) {
      const text = await fail(outcome);
      if (dialog) setError(text); else setNotice({ tone: 'error', text });
      return;
    }
    keys.current.delete(signature);
    setDialog(null);
    await reread();
    const created = request.kind === 'revert' && typeof outcome.data === 'object' && outcome.data !== null
      && 'proposal' in outcome.data && typeof outcome.data.proposal === 'string' ? outcome.data.proposal : null;
    setNotice(created ? { tone: 'success', text: t.revertedTo, href: `/proposals/${created}` }
      : { tone: 'success', text: t.sent });
  };
  const revise = async (candidate: unknown, evidence: ProposalRead['revision']['evidence'], key: string) => {
    const { baseHeads } = reviseHeads(view);
    const outcome = await api.revise(view.revision.n, { candidate, baseHeads, evidence }, key);
    if (outcome.ok) { setDialog(null); await reread(); setNotice({ tone: 'success', text: t.sent }); }
    else if (outcome.failure === 'stale') await reread();
    return outcome;
  };
  const more = async () => {
    if (!view.nextCursor) return;
    const next = await api.more(view.nextCursor);
    if (next.ok) setView({ ...view, timeline: [...view.timeline, ...next.data.timeline], nextCursor: next.data.nextCursor });
  };
  const revisionHref = (n: number) => `?revision=${n}`;
  const open = (control: Control) => {
    setError(null);
    if (control.action === 'recover') void perform({ kind: 'recover' });
    else setDialog(control.action as DialogAction | 'revise');
  };
  const latest = view.revision.n;
  const reverts = proposal.reverts;

  return <article className="grid gap-6" aria-labelledby="proposal-title">
    <header className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-muted-foreground">{kindLabel(proposal.kind, t as unknown as Record<string, unknown>)}</span>
        <StateBadge state={view.state} t={t} />
        <span className="text-muted-foreground">{t.latestRevision({ n: String(latest) })}</span>
      </div>
      <h1 id="proposal-title" className="text-balance font-semibold text-3xl tracking-tight sm:text-4xl">
        {target ? <span lang={target.language} dir={target.direction}>{target.value}</span> : t.unknownTarget}</h1>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-sm">
        <span>{t.proposedBy({ agent: agentName(proposal.proposer, agents, t) })}</span>
        {work ? <LocalizedLink href={`/w/${uuidOf(work)}`} className="font-medium text-primary hover:underline">
          {t.openWork}</LocalizedLink> : null}
        {reverts ? <span>{t.revertsLead}{' '}<LocalizedLink href={`/proposals/${reverts}`}
          className="font-medium text-primary hover:underline">{t.revertsLink}</LocalizedLink></span> : null}
      </p>
      {linkedRevision !== null && linkedRevision !== latest ? <Alert variant="info" role="status">
        <AlertDescription className="text-foreground">{(linkedRevision < latest ? t.linkedOlder : t.linkedUnknown)({
          linked: String(linkedRevision), latest: String(latest) })}</AlertDescription></Alert> : null}
    </header>

    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <div className="order-2 grid gap-6 lg:order-1">
        <section aria-labelledby="changes-heading" className="grid gap-3 rounded-2xl border border-border/60 bg-card p-5">
          <h2 id="changes-heading" className="font-semibold text-lg">{t.changesHeading}</h2>
          <ChangeList changes={view.preview} locale={locale} t={t} />
        </section>
        <section aria-labelledby="evidence-heading" className="grid gap-3 rounded-2xl border border-border/60 bg-card p-5">
          <h2 id="evidence-heading" className="font-semibold text-lg">{t.evidenceHeading}</h2>
          <EvidenceList evidence={view.revision.evidence} locale={locale} t={t} />
        </section>
        <section aria-labelledby="history-heading" className="grid gap-3 rounded-2xl border border-border/60 bg-card p-5">
          <h2 id="history-heading" className="font-semibold text-lg">{t.timelineHeading}</h2>
          <Timeline timeline={view.timeline} agents={agents} now={now} locale={locale} t={t} href={revisionHref} />
          {view.nextCursor ? <Button variant="outline" className="w-fit" onClick={() => void more()}>{t.loadMore}</Button> : null}
        </section>
      </div>

      <aside className="order-1 grid gap-4 lg:sticky lg:top-20 lg:order-2" aria-label={t.actionsHeading}>
        <BlockerList blockers={view.blockers} stale={view.staleApprovalIds.length}
          staleComplete={view.staleApprovalIdsComplete} t={t} />
        {notice ? <Alert variant={notice.tone === 'success' ? 'success' : 'destructive'}
          role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.tone === 'success' ? <CircleCheckIcon aria-hidden="true" /> : <CircleAlertIcon aria-hidden="true" />}
          <AlertDescription className="text-foreground">{notice.text}
            {notice.href ? <> <LocalizedLink href={notice.href} className="font-medium text-primary hover:underline">
              {t.openReverting}</LocalizedLink></> : null}</AlertDescription></Alert> : null}
        <section className="grid gap-3 rounded-2xl border border-border/60 bg-card p-5" aria-labelledby="actions-heading">
          <h2 id="actions-heading" className="font-semibold text-lg">{t.actionsHeading}</h2>
          {controls.length ? <div className="flex flex-wrap gap-2">
            {controls.map(control => <Button key={control.action} data-action={control.action} disabled={pending}
              variant={control.tone === 'primary' ? 'default' : control.tone === 'destructive' ? 'destructive' : 'outline'}
              onClick={() => open(control)}>{label(control.action, t)}</Button>)}
          </div> : <p className="text-muted-foreground text-sm">{t.actionsNone}</p>}
        </section>
      </aside>
    </div>

    {dialog && dialog !== 'revise' ? <ActionDialog key={dialog} action={dialog} revision={latest} pending={pending}
      error={error} onSend={request => void perform(request)} onClose={() => setDialog(null)} locale={locale}
      messages={messages} /> : null}
    {dialog === 'revise' && seed ? <Dialog open onOpenChange={details => { if (!details.open) setDialog(null); }}>
      <DialogContent size="lg">
        <DialogHeader title={t.reviseTitle} description={t.reviseDescription} />
        <DialogBody>
          <CorrectionEditor state={seed.state} language={seed.language} initial={{ fields: seed.fields, sources: seed.sources }}
            rebased={reviseHeads(view).rebased} submitLabel={t.submitRevision} locale={locale} messages={messages}
            onCancel={() => setDialog(null)} onSubmit={revise} />
        </DialogBody>
      </DialogContent>
    </Dialog> : null}
  </article>;
}
