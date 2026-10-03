'use client';

import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Textarea } from '@rezics/ui/textarea';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { CommandDialog } from '../manage/command-dialog.tsx';
import { browserSpaceAccessApi, newKey, type JoinPage, type OwnJoinRequest, type SpaceAccessApi } from '../manage/settings-api.ts';
import { accessMessages } from '../manage/settings-messages.ts';
import { SpaceDiscovery } from './discovery.tsx';
import { emptyRequestJournal, journalAfterStatus, parseRequestJournal, readOwnRequest, requestStorageKey, type RequestJournal, type RequestReceipt } from './request-state.ts';

type Props = { page: JoinPage; actingSubject: string | null; signInHref: string; locale: UiLocale;
  api?: SpaceAccessApi; persist?: boolean };

/** Main's limited join page plus its authenticated requester read. Identity
 * changes remount all request/withdrawal state; browser receipts never supply status. */
export function PrivateSpaceJoinPage(props: Props) {
  return <JoinFlow key={`${props.page.id}:${props.actingSubject ?? ''}`} {...props} />;
}
function JoinFlow({ page, actingSubject, signInHref, locale, api: provided, persist = true }: Props) {
  const t = accessMessages[locale];
  const api = useMemo(() => provided ?? browserSpaceAccessApi(page.space, page.id, actingSubject ?? ''),
    [provided, page.space, page.id, actingSubject]);
  const journal = useRef<RequestJournal>(emptyRequestJournal());
  const [current, setCurrent] = useState<'available' | RequestReceipt['state'] | null>(null);
  const [knownReceipt, setKnownReceipt] = useState<RequestReceipt | null>(null);
  const [ready, setReady] = useState(false);
  const [statusLoading, setStatusLoading] = useState(actingSubject !== null);
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
    retain(saved);
    setReason(saved.draftReason || saved.requestIntent?.command.reason || '');
    setWithdrawReason(saved.withdrawIntent?.command.reason ?? '');
    if (!actingSubject) { setCurrent('available'); setReady(true); setStatusLoading(false); return; }
    let alive = true;
    setReady(false); setStatusLoading(true);
    void readOwnRequest(api).then(result => {
      if (!alive) return;
      if (result.ok) acceptStatus(result.data);
      else { setCurrent(null); setError(result.failure === 'denied' ? t.denied : t.failed); }
      setStatusLoading(false);
    });
    return () => { alive = false; };
  }, [persist, storageKey, actingSubject, api]);

  function retain(next: RequestJournal) {
    journal.current = next;
    if (persist && storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* this session still retains the intent */ }
    }
  }
  function acceptStatus(entry: OwnJoinRequest | null) {
    const saved = journalAfterStatus(journal.current, entry);
    retain(saved);
    setKnownReceipt(entry ? { requestId: entry.id, requestGeneration: entry.requestGeneration, state: entry.state } : null);
    setCurrent(entry?.state ?? 'available'); setReady(true);
    setReason(saved.draftReason || saved.requestIntent?.command.reason || '');
    setWithdrawReason(saved.withdrawIntent?.command.reason ?? '');
    setWithdrawing(saved.withdrawIntent !== null);
  }
  async function refreshStatus(requireRequest = knownReceipt !== null) {
    setReady(false); setStatusLoading(true); setError(null);
    const result = await readOwnRequest(api);
    if (result.ok && (result.data !== null || !requireRequest)) acceptStatus(result.data);
    else {
      setCurrent(null); setKnownReceipt(null); setWithdrawing(false);
      setError(!result.ok && result.failure === 'denied' ? t.denied : t.failed);
    }
    setStatusLoading(false);
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
    if (result.ok) {
      // A replayed submission receipt still says pending after a decision. Read
      // the owner before presenting its current result.
      retain({ ...journal.current, requestIntent: null });
      await refreshStatus(true);
    }
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
    if (result.ok) { retain({ ...journal.current, withdrawIntent: null, draftReason: '' }); await refreshStatus(); }
    else {
      setError(result.failure === 'denied' ? t.denied : t.failed);
      if (result.failure === 'stale') { retain({ ...journal.current, withdrawIntent: null }); await refreshStatus(); }
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
    {statusLoading ? <p role="status">{t.statusLoading}</p> : null}
    {!statusLoading && current !== null && current !== 'available' ? <p role="status">{current === 'pending' ? t.pending : current === 'declined' ? t.declined
      : current === 'withdrawn' ? t.withdrawn : t.approved}</p> : null}
    {current === 'pending' && actingSubject && knownReceipt ? <Button className="w-fit" variant="outline" disabled={!ready || busy || stale}
      onClick={() => { setWithdrawing(true); setError(null); }}>{t.withdraw}</Button> : null}
    {!statusLoading && current !== null && current !== 'pending' && current !== 'accepted' ? actingSubject ? <form className="grid gap-3"
      onSubmit={event => { event.preventDefault(); void request(); }}>
      <Field><FieldLabel>{t.joinReason}</FieldLabel><Textarea required maxLength={2000} value={reason} disabled={!ready || busy}
        onChange={event => {
          const draftReason = event.currentTarget.value;
          setReason(draftReason); retain({ ...journal.current, draftReason });
        }} /></Field>
      <Button type="submit" className="w-fit" isLoading={busy} disabled={!ready || busy || stale || !reason.trim()}>{t.requestJoin}</Button>
    </form> : <Button asChild className="w-fit"><a href={signInHref}>{t.signIn}</a></Button> : null}
    {actingSubject ? <Button className="w-fit" variant="outline" disabled={busy || statusLoading}
      onClick={() => void refreshStatus()}>{t.refreshStatus}</Button> : null}
    {error && !withdrawing ? <p role="alert">{error}</p> : null}
    {stale && current !== null && current !== 'pending' ? <Button className="w-fit" variant="outline"
      onClick={() => window.location.reload()}>{t.reviewRules}</Button> : null}
    <CommandDialog open={withdrawing} title={t.withdraw} confirm={t.withdraw} pending={busy} error={error}
      disabled={stale || !withdrawReason.trim()} cancel={t.cancel} onClose={() => setWithdrawing(false)} onConfirm={() => void withdraw()}>
      <p>{t.withdrawHelp}</p><Field><FieldLabel>{t.reason}</FieldLabel><Textarea maxLength={2000} value={withdrawReason}
        onChange={event => setWithdrawReason(event.currentTarget.value)} /></Field>
    </CommandDialog>
  </section>;
}
