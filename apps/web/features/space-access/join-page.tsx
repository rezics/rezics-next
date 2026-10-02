'use client';

import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Textarea } from '@rezics/ui/textarea';
import { useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserSpaceAccessApi, newKey, type JoinCommand, type JoinPage, type SpaceAccessApi } from '../manage/settings-api.ts';
import { accessMessages } from '../manage/settings-messages.ts';
import { SpaceDiscovery } from './discovery.tsx';

/** Mount with Main's join-page read, never a protected Realm header. Request status
 * must come from its owner; the local pending state only follows a successful receipt. */
export function PrivateSpaceJoinPage({ page, actingSubject, signInHref, locale, state = 'available', api: provided }: {
  page: JoinPage; actingSubject: string | null; signInHref: string; locale: UiLocale;
  state?: 'available' | 'pending' | 'declined'; api?: SpaceAccessApi;
}) {
  const t = accessMessages[locale];
  const api = useMemo(() => provided ?? browserSpaceAccessApi(page.space, page.id, actingSubject ?? ''),
    [provided, page.space, page.id, actingSubject]);
  const [submitted, setSubmitted] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intent = useRef<{ command: JoinCommand; key: string } | null>(null);
  async function request() {
    if (!actingSubject || busy || !reason.trim()) return;
    setBusy(true); setError(null);
    // Keep the exact command and key after an uncertain response. A fresh intent is
    // needed only after Main refuses a stale basis or the person changes their reason.
    if (!intent.current || intent.current.command.reason !== reason.trim()) {
      const basis = await api.basis();
      if (!basis.ok || basis.data.state === 'joined') { setError(t.failed); setBusy(false); return; }
      intent.current = { key: newKey(), command: { actingSubject,
        expectedMembershipGeneration: basis.data.membershipGeneration, expectedPolicyRevision: basis.data.policyRevision,
        termsRevision: basis.data.termsRevision, reason: reason.trim() } };
    }
    const result = await api.request(intent.current.command, intent.current.key);
    if (result.ok) setSubmitted(true);
    else { setError(result.failure === 'denied' ? t.denied : result.failure === 'stale' ? t.staleRequest : t.failed);
      if (result.failure === 'stale') intent.current = null; }
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
    {state === 'pending' || submitted ? <p role="status">{t.pending}</p> : state === 'declined' ? <p role="status">{t.declined}</p>
      : actingSubject ? <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void request(); }}>
        <Field><FieldLabel>{t.joinReason}</FieldLabel><Textarea required maxLength={2000} value={reason} disabled={busy}
          onChange={event => setReason(event.currentTarget.value)} /></Field>
        {error ? <p role="alert">{error}</p> : null}
        <Button type="submit" className="w-fit" isLoading={busy} disabled={busy || !reason.trim()}>{t.requestJoin}</Button>
      </form> : <Button asChild className="w-fit"><a href={signInHref}>{t.signIn}</a></Button>}
  </section>;
}
