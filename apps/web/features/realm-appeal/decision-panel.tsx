'use client';

import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Textarea } from '@rezics/ui/textarea';
import { materializeData } from 'native-i18n';
import { useEffect, useMemo, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { CommandDialog } from '../manage/command-dialog.tsx';
import { commandInstance } from '../api/command.ts';
import type { ManageMessages } from '../manage/messages.ts';
import { readDecisionBasis } from '../manage/read.ts';
import { attemptStorage, performCommand, readCommand } from '../manage/safety-pending.ts';
import type { DecisionBasis, MainClient, ModerationItem, ModerationDecisionCommand } from '../manage/types.ts';
import { readAppealReceipt } from './ban-read.ts';
import { appealDecisionCommand, resolveRealmAppeal } from './decision-api.ts';
import type { BanReading } from './reading.ts';
import { reviewText } from './review-messages.ts';
import { useOperationGate } from '../shell/shell-provider.tsx';

/** The production queue's sanction appeal: the retained reason and statement precede the decision. */
export function RealmAppealDecisionPanel({ item, realm, actingSubject, principal, authority, locale, messages,
  client: supplied, onDecided }: {
  item: ModerationItem; realm: string; actingSubject: string; principal: string; authority: { dismiss: boolean; restore: boolean };
  locale: UiLocale; messages: ManageMessages; client?: MainClient; onDecided: () => void;
}) {
  const t = materializeData(messages, { locale });
  const copy = reviewText[locale];
  const operationOpen = useOperationGate();
  const client = useMemo(() => supplied ?? browserMainApi(), [supplied]);
  const [loaded, setLoaded] = useState<{ basis: DecisionBasis; reading: BanReading } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'dismiss' | 'restore' | null>(null);
  const [rationale, setRationale] = useState('');
  const [shared, setShared] = useState(true);
  const [sending, setSending] = useState(false);
  const [retained, setRetained] = useState<ModerationDecisionCommand | null>(null);
  const command = useMemo(commandInstance, [item.id, actingSubject]);
  const store = useMemo(() => attemptStorage(principal), [principal]);
  const operation = `sanction-appeal:${item.id}`;
  useEffect(() => {
    let active = true;
    const prior = readCommand<ModerationDecisionCommand>(realm, actingSubject, operation, store)?.input ?? null;
    setLoaded(null); setError(null); setOutcome(null); setRationale(prior?.rationale ?? ''); setRetained(prior);
    void Promise.all([readDecisionBasis(client, realm, item.id, actingSubject),
      readAppealReceipt(client, realm, item.target.resource, operationOpen)]).then(([basis, read]) => {
      if (!active) return;
      if (!basis.ok || !read.ok) {
        setError(!basis.ok ? basis.problem?.title ?? t.unavailableHelp : !read.ok ? read.problem?.title ?? t.unavailableHelp : null);
        return;
      }
      if (read.reading.appeal.state === 'none' || read.reading.appeal.caseId !== item.id || basis.data.caseId !== item.id) {
        setError(t.unavailableHelp); return;
      }
      setLoaded({ basis: basis.data, reading: read.reading });
    }).catch(() => { if (active) setError(t.unavailableHelp); });
    return () => { active = false; };
  }, [client, realm, item.id, item.target.resource, actingSubject, operation, operationOpen, store, t.unavailableHelp]);

  async function submit() {
    if (!loaded || !outcome || sending) return;
    if (!rationale.trim()) { setError(t.reasonRequired); return; }
    const intended = retained ?? appealDecisionCommand(loaded.basis, actingSubject,
      { outcome, rationale, disclosure: shared ? 'parties' : 'private' }, command.id());
    setSending(true); setError(null);
    const answer = await performCommand(operation, { realm, actingSubject, input: intended, key: intended.idempotencyKey,
      status: 'recorded' }, attempt => resolveRealmAppeal(client, attempt.input), store);
    setSending(false); command.finish(answer);
    if (!answer.ok) {
      setRetained(readCommand<ModerationDecisionCommand>(realm, actingSubject, operation, store)?.input ?? null);
      setError(answer.failure === 'pending' ? t.decisionStillPending : answer.title ?? t.decisionFailed);
      return;
    }
    setRetained(null); setOutcome(null); onDecided();
  }
  if (!loaded) return <section className="grid gap-3" aria-busy={!error}>
    <p role={error ? 'alert' : 'status'}>{error ?? t.impactChecking}</p>
  </section>;
  const appeal = loaded.reading.appeal;
  return <section className="grid min-w-0 gap-4" aria-label={copy.title}>
    <h3 className="font-semibold">{copy.title}</h3>
    <div className="grid gap-2 text-sm">
      <h4 className="font-medium">{t.reasonLabel}</h4>
      <blockquote className="whitespace-pre-wrap [overflow-wrap:anywhere]">{loaded.reading.reason}</blockquote>
      {appeal.state !== 'none' ? <><h4 className="font-medium">{t.submittedText}</h4>
        <blockquote className="whitespace-pre-wrap [overflow-wrap:anywhere]">{appeal.statement}</blockquote></> : null}
    </div>
    {error && !outcome ? <p role="alert">{error}</p> : null}
    {retained ? <Button onClick={() => setOutcome(retained.outcome === 'restore' ? 'restore' : 'dismiss')}>{t.decisionResume}</Button>
      : loaded.basis.state === 'open' ? <div className="flex flex-wrap gap-2">
      {authority.dismiss ? <Button variant="outline" onClick={() => { setError(null); setOutcome('dismiss'); }}>{copy.dismiss}</Button> : null}
      {authority.restore ? <Button onClick={() => { setError(null); setOutcome('restore'); }}>{copy.restore}</Button> : null}
    </div> : null}
    <CommandDialog open={outcome !== null} title={outcome === 'restore' ? copy.restore : copy.dismiss}
      confirm={retained ? t.decisionResume : t.decisionSend} pending={sending} error={error}
      cancel={t.cancel} onConfirm={() => void submit()} onClose={() => setOutcome(null)}>
      <fieldset disabled={sending || retained !== null} className="grid gap-3">
        <p>{outcome === 'restore' ? copy.restoreHelp : copy.dismissHelp}</p>
        <Field><FieldLabel>{t.changeReasonLabel}</FieldLabel>
          <Textarea value={rationale} onChange={event => setRationale(event.currentTarget.value)} maxLength={8000} rows={4} /></Field>
        <Field orientation="horizontal"><Checkbox checked={shared} onCheckedChange={details => setShared(details.checked === true)} />
          <FieldLabel>{copy.share}</FieldLabel></Field>
      </fieldset>
    </CommandDialog>
  </section>;
}
