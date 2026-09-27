'use client';

import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import type { AuthMessages } from '../../features/auth/messages.ts';

export function SignInForm({ next, messages, failed = false }: { next: string; messages: AuthMessages;
  /** A sign-in posted without JavaScript failed. */
  failed?: boolean }) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [error, setError] = useState(failed ? messages.accountFailed : '');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    const values = new FormData(event.currentTarget);
    const body = { email: String(values.get('email') ?? ''), password: String(values.get('password') ?? ''),
      ...(mode === 'sign-up' ? { name: String(values.get('name') ?? '') } : {}) };
    try {
      const response = await fetch(`/api/account/${mode === 'sign-up' ? 'sign-up' : 'sign-in'}/email`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(result.message ?? messages.accountFailed);
      }
      window.location.assign(`/auth/start?next=${encodeURIComponent(next)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : messages.accountFailed);
      setBusy(false);
    }
  }
  const field = 'flex flex-col gap-1.5 text-sm font-medium';
  return <section className="flex flex-col gap-5">
    <header className="flex flex-col gap-2">
      <h1 className="font-semibold text-2xl">{mode === 'sign-up' ? messages.createAccountHeading : messages.signInHeading}</h1>
      <p className="text-muted-foreground">{messages.accountHelp}</p>
    </header>
    {/* Posts to the server if submitted before hydration, never as a GET. */}
    <form className="flex flex-col gap-4" method="post" action="/auth/sign-in"
      onSubmit={event => { void submit(event); }}>
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="mode" value={mode} />
      {mode === 'sign-up' ? <div className={field}><label htmlFor="name">{messages.nameLabel}</label><Input id="name" name="name" required autoComplete="name" /></div> : null}
      <div className={field}><label htmlFor="email">{messages.email}</label><Input id="email" name="email" type="email" required autoComplete="email" /></div>
      <div className={field}><label htmlFor="password">{messages.password}</label><Input id="password" name="password" type="password" minLength={8} required
        autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} /></div>
      {error ? <Alert variant="destructive"><AlertDescription role="alert">{error}</AlertDescription></Alert> : null}
      <Button type="submit" disabled={busy} className="self-start">{busy ? messages.connecting
        : mode === 'sign-up' ? messages.createAccount : messages.signIn}</Button>
    </form>
    <p className="text-sm">{mode === 'sign-in' ? messages.newHere : messages.alreadyHaveAccount}{' '}
      <Button variant="link" size="sm" className="h-auto p-0" type="button"
        onClick={() => { setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in'); setError(''); }}>
        {mode === 'sign-in' ? messages.createAccountLink : messages.signIn}</Button></p>
  </section>;
}
