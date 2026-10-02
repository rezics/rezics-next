'use client';

import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Textarea } from '@rezics/ui/textarea';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { CommandDialog } from '../manage/command-dialog.tsx';
import { browserSpaceAccessApi, newKey, type JoinPage, type SpaceAccessApi } from '../manage/settings-api.ts';
import { accessMessages } from '../manage/settings-messages.ts';
import { SpaceDiscovery } from './discovery.tsx';
import { emptyRequestJournal, parseRequestJournal, requestStorageKey, type RequestJournal, type RequestReceipt } from './request-state.ts';

type Props = { page: JoinPage; actingSubject: string | null; signInHref: string; locale: UiLocale;
  state?: 'available' | RequestReceipt['state']; receipt?: RequestReceipt; api?: SpaceAccessApi; persist?: boolean };

/** The router mounts Main's limited join page, and may supply fresh owner status
 * when that read is available. Identity changes remount all request/withdrawal state. */
export function PrivateSpaceJoinPage(props: Props) {
  return <JoinFlow key={`${props.page.id}:${props.actingSubject ?? ''}`} {...props} />;
}
function JoinFlow({ page, actingSubject, signInHref, locale, state, receipt, api: provided, persist = true }: Props) {
  const t = accessMessages[locale];
  const api = useMemo(() => provided ?? browserSpaceAccessApi(page.space, page.id, actingSubject ?? ''),
    [provided, page.space, page.id, actingSubject]);
  const journal = useRef<RequestJournal>(emptyRequestJournal());
  const [current, setCurrent] = useState<Props['state']>(receipt?.state ?? state ?? 'available');
  const [knownReceipt, setKnownReceipt] = useState(receipt ?? null);
  const [ready, setReady] = useState(false);
  const [lastKnown, setLastKnown] = useState(false);
  const [reason, setReason] = useState('');
  const [withdrawReason, setWithdrawReason] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const storageKey = actingSubject ? requestStorageKey(page.id, actingSubject) : null;

  useEffect(() => {
    let saved = emptyRequestJournal();
    if (persist && storageKey && actingSubject) {
      try { saved = parseRequestJournal(localStorage.getItem(storageKey), actingSubject); } catch { /* storage unavailable */ }
    }
    if (receipt) {
      saved = { draftReason: '', receipt, requestIntent: null, withdrawIntent: null };
      if (persist && storageKey) {
        try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* storage unavailable */ }
      }
    }
    journal.current = saved;
    setKnownReceipt(saved.receipt);
    setCurrent(receipt?.state ?? state ?? saved.receipt?.state ?? 'available');
    setLastKnown(!receipt && !state && saved.receipt !== null);
    setReason(saved.draftReason || saved.requestIntent?.command.reason || '');
    setWithdrawReason(saved.withdrawIntent?.command.reason ?? '');
    setWithdrawing(saved.withdrawIntent !== null);
    setReady(true);
  }, [persist, storageKey, actingSubject, receipt, state]);

  function retain(next: RequestJournal) {
    journal.current = next;
    if (persist && storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* this session still retains the intent */ }
    }
  }
  function confirmed(result: RequestReceipt) {
    retain({ draftReason: '', receipt: result, requestIntent: null, withdrawIntent: null });
    setKnownReceipt(result); setCurrent(result.state); setLastKnown(false); setStale(false); setReason('');
  }
  async function request() {
    if (!actingSubject || !ready || busy || stale || !reason.trim()) return;
    setBusy(true); setError(null);
    // Persist before sending: a reload after a lost response retries the exact
    // command and key rather than creating a second pending request.
    if (!journal.current.requestIntent || journal.current.requestIntent.command.reason !== reason.trim()) {
      const basis = await api.basis();
      if (!basis.ok || basis.data.state === 'joined') { setError(t.failed); setBusy(false); return; }
      retain({ ...journal.current, requestIntent: { key: newKey(), command: { actingSubject,
        expectedMembershipGeneration: basis.data.membershipGeneration, expectedPolicyRevision: basis.data.policyRevision,
        termsRevision: basis.data.termsRevision, reason: reason.trim() } } });
    }
    const intent = journal.current.requestIntent!;
    const result = await api.request(intent.command, intent.key);
    if (result.ok) confirmed(result.data);
    else {
      setError(result.failure === 'denied' ? t.denied : result.failure === 'stale' ? t.joinChanged : t.failed);
      if (result.failure === 'stale') { setStale(true); retain({ ...journal.current, requestIntent: null }); }
    }
    setBusy(false);
  }
  async function withdraw() {
    if (!actingSubject || !knownReceipt || knownReceipt.state !== 'pending' || busy || stale || !withdrawReason.trim()) return;
    setBusy(true); setError(null);
    if (!journal.current.withdrawIntent || journal.current.withdrawIntent.command.reason !== withdrawReason.trim()) {
      retain({ ...journal.current, withdrawIntent: { request: knownReceipt.requestId, key: newKey(),
        command: { actingSubject, expectedRequestGeneration: knownReceipt.requestGeneration, reason: withdrawReason.trim() } } });
    }
    const intent = journal.current.withdrawIntent!;
    const result = await api.withdraw(intent.request, intent.command, intent.key);
    if (result.ok) { confirmed(result.data); setWithdrawing(false); setWithdrawReason(''); }
    else {
      setError(result.failure === 'stale' ? t.requestStatusUnavailable : result.failure === 'denied' ? t.denied : t.failed);
      if (result.failure === 'stale') { setStale(true); retain({ ...journal.current, withdrawIntent: null }); }
    }
    setBusy(false);
  }
  return <section aria-label={page.name.value} className="mx-auto grid w-full max-w-2xl gap-6 px-4 py-8 sm:px-6">
    <SpaceDiscovery discovery={page.discovery} />
    <header className="grid gap-3"><h1 lang={page.name.language} dir="auto" className="break-words font-semibold text-3xl">{page.name.value}</h1>
      {page.description ? <p lang={page.description.language} dir="auto" className="whitespace-pre-wrap break-words text-muted-foreground">{page.description.value}</p> : null}</header>
    {page.rules.length ? <section aria-labelledby="join-rules" className="grid gap-3"><h2 id="join-rules" className="font-semibold text-xl">{t.rules}</h2>
      <ol className="grid gap-4">{page.rules.map(rule => <li key={rule.id} className="grid gap-1">
        <h3 lang={rule.title.language} dir="auto" className="break-words font-medium">{rule.title.value}</h3>
        <p lang={rule.body.language} dir="auto" className="whitespace-pre-wrap break-words text-sm">{rule.body.value}</p>
      </li>)}</ol></section> : null}
    {lastKnown ? <p className="text-muted-foreground text-sm">{t.lastKnownRequest}</p> : null}
    {current !== 'available' ? <p role="status">{current === 'pending' ? t.pending : current === 'declined' ? t.declined
      : current === 'withdrawn' ? t.withdrawn : t.approved}</p> : null}
    {current === 'pending' && actingSubject && knownReceipt ? <Button className="w-fit" variant="outline" disabled={!ready || busy || stale}
      onClick={() => { setWithdrawing(true); setError(null); }}>{t.withdraw}</Button> : null}
    {current !== 'pending' && current !== 'accepted' ? actingSubject ? <form className="grid gap-3"
      onSubmit={event => { event.preventDefault(); void request(); }}>
      <Field><FieldLabel>{t.joinReason}</FieldLabel><Textarea required maxLength={2000} value={reason} disabled={!ready || busy}
        onChange={event => {
          const draftReason = event.currentTarget.value;
          setReason(draftReason); retain({ ...journal.current, draftReason });
        }} /></Field>
      <Button type="submit" className="w-fit" isLoading={busy} disabled={!ready || busy || stale || !reason.trim()}>{t.requestJoin}</Button>
    </form> : <Button asChild className="w-fit"><a href={signInHref}>{t.signIn}</a></Button> : null}
    {error && !withdrawing ? <p role="alert">{error}</p> : null}
    {stale && current !== 'pending' ? <Button className="w-fit" variant="outline"
      onClick={() => window.location.reload()}>{t.reviewRules}</Button> : null}
    <CommandDialog open={withdrawing} title={t.withdraw} confirm={t.withdraw} pending={busy} error={error}
      disabled={stale || !withdrawReason.trim()} cancel={t.cancel} onClose={() => setWithdrawing(false)} onConfirm={() => void withdraw()}>
      <p>{t.withdrawHelp}</p><Field><FieldLabel>{t.reason}</FieldLabel><Textarea maxLength={2000} value={withdrawReason}
        onChange={event => setWithdrawReason(event.currentTarget.value)} /></Field>
    </CommandDialog>
  </section>;
}
