'use client';

import { resourceHref } from '../address/path.ts';
import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogHeader } from '@rezics/ui/dialog';
import { CircleCheckIcon, CircleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { type ActionRequest, controlsFor, type Control } from './actions.ts';
import { type Fields, fieldsOf, headerOf, rebaseFields, type Source } from './candidate.ts';
import { bffProposalApi, type ProposalApi, newKey, type Outcome } from './commands.ts';
import { CorrectionEditor } from './correction-editor.tsx';
import { leaves } from './diff.ts';
import { ActionDialog, type DialogAction } from './action-dialog.tsx';
import { failureKey, kindLabel } from './labels.ts';
import type { ProposalMessages } from './messages.ts';
import { type Agents, agentName, BlockerList, blockerText, ChangeList, EvidenceList, StateBadge, Timeline } from './parts.tsx';
import { WatchToggle } from './watch-toggle.tsx';
import type { BaseHead, HeaderState, ProposalRead, TargetName } from './types.ts';

/** What a revise dialog starts from, read from the candidate of a header correction; null for other candidates. */
export function reviseSeed(view: ProposalRead): { state: HeaderState; language: string; fields: Fields;
  sources: Source[] } | null {
  const state = headerOf(view.revision.candidate);
  if (!state) return null;
  const language = leaves(view.preview).find(leaf => leaf.language)?.language ?? state.localized[0]?.language ?? 'en';
  return { state, language, fields: fieldsOf(state, language),
    sources: view.revision.evidence.length ? view.revision.evidence.map(item => ({ source: item.resource,
      locator: item.locator ?? '' })) : [{ source: '', locator: '' }] };
}

/** A revision the owner refused as stale, carried onto the header as it is now. */
interface Rebase { state: HeaderState; baseHeads: BaseHead[]; language: string; fields: Fields; sources: Source[];
  count: number }
/** A dialog, pinned to the revision it opened on. */
interface Open { action: DialogAction | 'revise'; revision: number }

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
  const [dialog, setDialog] = useState<Open | null>(null);
  const [rebase, setRebase] = useState<Rebase | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The dialog as the async steps below see it; what shows is `dialog`.
  const opened = useRef<Open | null>(null);
  // One key per intent: sending the same request again after a lost answer replays its receipt.
  const keys = useRef(new Map<string, string>());
  const proposal = view.proposal;
  const seed = reviseSeed(view);
  const work = proposal.target.work;
  // A revise control needs an editor for the candidate; only header corrections have one so far.
  const controls = controlsFor(view.allowedActions).filter(control => control.action !== 'revise' || seed);
  const show = (next: Open | null) => { opened.current = next; setDialog(next); };

  /** Main's state again. A dialog opened on an earlier revision closes: nothing is sent for a revision nobody saw. */
  const reread = async (): Promise<ProposalRead | null> => {
    const next = await api.read(proposal.id);
    if (!next.ok) return null;
    setView(next.data);
    if (opened.current && opened.current.revision !== next.data.revision.n) {
      show(null); setRebase(null);
      setNotice({ tone: 'error', text: t.changedMeanwhile });
    }
    return next.data;
  };
  /** The words for a refused command, after reading again where the refusal means the page was out of date or out of authority. */
  const fail = async (outcome: Extract<Outcome<unknown>, { ok: false }>, from: Open | null) => {
    const text = String(t[failureKey[outcome.failure]]);
    const full = outcome.blocker ? `${text} ${blockerText(outcome.blocker, t)}` : text;
    if (!['stale', 'pending', 'denied', 'missing', 'conflict'].includes(outcome.failure)) return full;
    const next = await reread();
    // The controls Main now allows are the only ones shown; a dialog for one that is gone closes with the reason.
    if (next && from && opened.current && !next.allowedActions.includes(from.action)) {
      show(null); setRebase(null);
      setNotice({ tone: 'error', text: full });
    }
    return full;
  };
  const perform = async (request: ActionRequest) => {
    const signature = JSON.stringify(request);
    const key = keys.current.get(signature) ?? newKey();
    keys.current.set(signature, key);
    const from = opened.current;
    setPending(true); setError(null); setNotice(null);
    const outcome = await api.act(request, key);
    setPending(false);
    if (!outcome.ok) {
      const text = await fail(outcome, from);
      if (opened.current) setError(text); else setNotice(current => current ?? { tone: 'error', text });
      return;
    }
    keys.current.delete(signature);
    show(null);
    await reread();
    const created = request.kind === 'revert' && typeof outcome.data === 'object' && outcome.data !== null
      && 'proposal' in outcome.data && typeof outcome.data.proposal === 'string' ? outcome.data.proposal : null;
    setNotice(created ? { tone: 'success', text: t.revertedTo, href: `/proposals/${created}` }
      : { tone: 'success', text: t.sent });
  };
  /**
   * A revision. When the owner refuses it as stale (the only place staleness shows), the header is read
   * again and only the fields this person changed are carried onto it: other languages and other
   * people's changes stay. The form then asks to submit once more, against the heads Main named.
   */
  const revise = async (candidate: unknown, evidence: ProposalRead['revision']['evidence'], key: string,
    edit: { language: string; fields: Fields; sources: Source[] }) => {
    const from = opened.current;
    const outcome = await api.revise(from?.revision ?? view.revision.n, { candidate,
      baseHeads: rebase?.baseHeads ?? view.revision.baseHeads, evidence }, key);
    if (outcome.ok) {
      show(null); setRebase(null);
      await reread();
      setNotice({ tone: 'success', text: t.sent });
      return outcome;
    }
    const before = rebase?.state ?? headerOf(view.revision.before);
    if (outcome.blocker?.code === 'stale_base' && before && work) {
      const current = await api.current(work);
      if (current.ok) {
        setRebase({ state: current.data.state, baseHeads: outcome.blocker.actualHeads, language: edit.language,
          fields: rebaseFields(current.data.state, before, edit.language, edit.fields), sources: edit.sources,
          count: (rebase?.count ?? 0) + 1 });
        return outcome;
      }
    }
    const text = await fail(outcome, from);
    if (opened.current) setError(text);
    return outcome;
  };
  const more = async () => {
    if (!view.nextCursor) return;
    const next = await api.more(view.nextCursor);
    if (next.ok) setView({ ...view, timeline: [...view.timeline, ...next.data.timeline], nextCursor: next.data.nextCursor });
  };
  const open = (control: Control) => {
    setError(null);
    if (control.action === 'recover') void perform({ kind: 'recover' });
    else show({ action: control.action as DialogAction | 'revise', revision: view.revision.n });
  };
  const revisionHref = (n: number) => `?revision=${n}`;
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
        {work ? <LocalizedLink href={resourceHref('/w/', work)} className="font-medium text-primary hover:underline">
          {t.openWork}</LocalizedLink> : null}
        {reverts ? <span>{t.revertsLead}{' '}<LocalizedLink href={`/proposals/${reverts}`}
          className="font-medium text-primary hover:underline">{t.revertsLink}</LocalizedLink></span> : null}
      </p>
      {linkedRevision !== null && linkedRevision !== latest ? <Alert variant="info" role="status">
        <AlertDescription className="text-foreground">{(linkedRevision < latest ? t.linkedOlder : t.linkedUnknown)({
          linked: String(linkedRevision), latest: String(latest) })}</AlertDescription></Alert> : null}
    </header>

    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <div className="order-2 grid min-w-0 gap-6 lg:order-1">
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
        <WatchToggle proposal={proposal.id} actingSubject={actingSubject} />
      </aside>
    </div>

    {dialog && dialog.action !== 'revise' ? <ActionDialog key={dialog.action} action={dialog.action}
      revision={dialog.revision} pending={pending} error={error} onSend={request => void perform(request)}
      onClose={() => show(null)} locale={locale} messages={messages} /> : null}
    {dialog?.action === 'revise' && seed ? <Dialog open onOpenChange={details => { if (!details.open) show(null); }}>
      <DialogContent size="lg">
        <DialogHeader title={t.reviseTitle} description={t.reviseDescription} />
        <DialogBody>
          <CorrectionEditor key={rebase?.count ?? 0} state={rebase?.state ?? seed.state}
            language={rebase?.language ?? seed.language}
            initial={{ fields: rebase?.fields ?? seed.fields, sources: rebase?.sources ?? seed.sources }}
            rebased={rebase !== null} submitLabel={t.submitRevision} locale={locale} messages={messages}
            onCancel={() => show(null)} onSubmit={revise} />
        </DialogBody>
      </DialogContent>
    </Dialog> : null}
  </article>;
}
