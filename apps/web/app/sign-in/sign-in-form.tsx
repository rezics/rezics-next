'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import type { auth as EnglishAuth } from '../../i18n/en.ts';

export function SignInForm({ next, messages }: { next: string; messages: typeof EnglishAuth }) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [error, setError] = useState('');
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
  return <>
    <h1>{mode === 'sign-up' ? messages.createAccountHeading : messages.signInHeading}</h1>
    <p className="muted">{messages.accountHelp}</p>
    <form className="auth-form" onSubmit={submit}>
      {mode === 'sign-up' ? <div><label htmlFor="name">{messages.nameLabel}</label><Input id="name" name="name" required autoComplete="name" /></div> : null}
      <div><label htmlFor="email">{messages.email}</label><Input id="email" name="email" type="email" required autoComplete="email" /></div>
      <div><label htmlFor="password">{messages.password}</label><Input id="password" name="password" type="password" minLength={8} required
        autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} /></div>
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" disabled={busy}>{busy ? messages.connecting
        : mode === 'sign-up' ? messages.createAccount : messages.signIn}</Button>
    </form>
    <p>{mode === 'sign-in' ? messages.newHere : messages.alreadyHaveAccount}{' '}
      <button className="link-action" type="button" onClick={() => { setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in'); setError(''); }}>
        {mode === 'sign-in' ? messages.createAccountLink : messages.signIn}</button></p>
  </>;
}
